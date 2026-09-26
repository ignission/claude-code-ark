import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideBoardSuggestion,
  type FetchLike,
  JEV_DECISIONS_ENDPOINT,
  JEV_MAX_STATE_CHARS,
  JEV_MODEL,
  loadOpenRouterApiKey,
} from "./jev-client.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(
  body: unknown,
  status = 200
): FetchLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  }) as FetchLike & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

describe("loadOpenRouterApiKey", () => {
  it("環境変数を優先し、無ければ ~/.config/openrouter/api-key を読む", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ark-jev-home-"));
    tempDirs.push(home);
    expect(loadOpenRouterApiKey({}, home)).toBeNull();
    fs.mkdirSync(path.join(home, ".config", "openrouter"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config", "openrouter", "api-key"),
      " sk-file \n"
    );
    expect(loadOpenRouterApiKey({}, home)).toBe("sk-file");
    expect(loadOpenRouterApiKey({ OPENROUTER_API_KEY: "sk-env" }, home)).toBe(
      "sk-env"
    );
  });
});

describe("decideBoardSuggestion", () => {
  it("Decisions API に noul と choice を送り、確率を取り出す", async () => {
    const fetchImpl = fakeFetch({
      answers: {
        board: { type: "noul", noul: 0.88 },
        form: {
          type: "choice",
          choice: "doc",
          probabilities: { doc: 0.91, figure: 0.09 },
        },
      },
      usage: { cost: 0.00002 },
    });
    const decision = await decideBoardSuggestion("本文", "sk-test", fetchImpl);
    expect(decision).toEqual({
      board: 0.88,
      form: "doc",
      figure: 0.09,
      cost: 0.00002,
    });
    const request = fetchImpl.calls[0] as Record<string, unknown>;
    expect(request.model).toBe(JEV_MODEL);
    expect(request.state).toBe("本文");
    expect(request.provider).toEqual({ data_collection: "deny" });
    expect(Object.keys(request.questions as object)).toEqual(["board", "form"]);
    expect(JEV_DECISIONS_ENDPOINT).toContain("/api/alpha/decisions");
  });

  it("本文は末尾の JEV_MAX_STATE_CHARS 文字だけ送る", async () => {
    const fetchImpl = fakeFetch({
      answers: {
        board: { noul: 0.1 },
        form: { choice: "doc", probabilities: { doc: 1, figure: 0 } },
      },
    });
    const text = "a".repeat(JEV_MAX_STATE_CHARS + 100);
    await decideBoardSuggestion(text, "sk-test", fetchImpl);
    const request = fetchImpl.calls[0] as { state: string };
    expect(request.state.length).toBe(JEV_MAX_STATE_CHARS);
  });

  it("HTTP エラーと想定外の応答は throw する", async () => {
    await expect(
      decideBoardSuggestion("x", "sk", fakeFetch({ error: "nope" }, 401))
    ).rejects.toThrow(/Jev HTTP 401/);
    await expect(
      decideBoardSuggestion(
        "x",
        "sk",
        fakeFetch({ answers: { board: { noul: 2 } } })
      )
    ).rejects.toThrow(/想定外/);
    const fetchAbort = (async (_url: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, status: 200, text: async () => "{}" };
    }) as FetchLike;
    await expect(decideBoardSuggestion("x", "sk", fetchAbort)).rejects.toThrow(
      /想定外/
    );
    vi.restoreAllMocks();
  });
});
