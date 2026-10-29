import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFERRED_QUESTIONS,
  decideDeferredTopic,
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

describe("Decisions API の呼び出し", () => {
  it("model と data_collection: deny を送る", async () => {
    const fetchImpl = fakeFetch({ answers: { deferred: { noul: 0.1 } } });
    await decideDeferredTopic("q", "a", "sk-test", fetchImpl);
    const request = fetchImpl.calls[0] as Record<string, unknown>;
    expect(request.model).toBe(JEV_MODEL);
    expect(request.provider).toEqual({ data_collection: "deny" });
    expect(JEV_DECISIONS_ENDPOINT).toContain("/api/alpha/decisions");
  });

  it("HTTP エラーと想定外の応答は throw する", async () => {
    await expect(
      decideDeferredTopic("q", "a", "sk", fakeFetch({ error: "nope" }, 401))
    ).rejects.toThrow(/Jev HTTP 401/);
    await expect(
      decideDeferredTopic(
        "q",
        "a",
        "sk",
        fakeFetch({ answers: { deferred: { noul: 2 } } })
      )
    ).rejects.toThrow(/想定外/);
    const fetchAbort = (async (_url: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, status: 200, text: async () => "{}" };
    }) as FetchLike;
    await expect(
      decideDeferredTopic("q", "a", "sk", fetchAbort)
    ).rejects.toThrow(/想定外/);
    vi.restoreAllMocks();
  });
});

describe("decideDeferredTopic", () => {
  it("人の発話と返答を state に入れ、deferred の確率を返す", async () => {
    const fetchImpl = fakeFetch({
      answers: { deferred: { type: "noul", noul: 0.98 } },
      usage: { cost: 0.00002 },
    });
    const result = await decideDeferredTopic(
      "CIを直して。ログの形式も気になる",
      "CIは直した。ログの形式は別の変更で扱う",
      "key",
      fetchImpl
    );
    expect(result).toEqual({ deferred: 0.98, cost: 0.00002 });
    const request = fetchImpl.calls[0] as Record<string, unknown>;
    expect(request.state).toBe(
      "User: CIを直して。ログの形式も気になる\n\nAssistant: CIは直した。ログの形式は別の変更で扱う"
    );
    expect(request.questions).toEqual(DEFERRED_QUESTIONS);
  });

  it("deferred が無い応答は投げる", async () => {
    await expect(
      decideDeferredTopic("q", "a", "key", fakeFetch({ answers: {} }))
    ).rejects.toThrow("想定外");
  });

  it("人の発話は末尾2000文字に切り、返答は発話とラベルを残して JEV_MAX_STATE_CHARS に収まるよう末尾から切る", async () => {
    const fetchImpl = fakeFetch({ answers: { deferred: { noul: 0.1 } } });
    await decideDeferredTopic(
      `X${"p".repeat(2000)}`,
      "r".repeat(JEV_MAX_STATE_CHARS),
      "key",
      fetchImpl
    );
    const { state } = fetchImpl.calls[0] as { state: string };
    const head = `User: ${"p".repeat(2000)}\n\nAssistant: `;
    expect(state.length).toBe(JEV_MAX_STATE_CHARS);
    expect(state.startsWith(head)).toBe(true);
    expect(state).toBe(head + "r".repeat(JEV_MAX_STATE_CHARS - head.length));
    const short = fakeFetch({ answers: { deferred: { noul: 0.1 } } });
    await decideDeferredTopic(`X${"p".repeat(2000)}`, "r", "key", short);
    const { state: s2 } = short.calls[0] as { state: string };
    expect(s2).toBe(`User: ${"p".repeat(2000)}\n\nAssistant: r`);
  });
});
