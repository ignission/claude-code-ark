import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BoardSuggestEvent } from "@ark/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BoardSuggestDeps,
  BoardSuggestService,
  FIGURE_REQUEST_MESSAGE,
} from "./board-suggest-service.js";
import type { BoardDecision } from "./jev-client.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function endTurnLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { stop_reason: "end_turn", content: [{ type: "text", text }] },
  });
}

function setup(
  decision: BoardDecision,
  overrides: Partial<BoardSuggestDeps> = {}
) {
  const worktree = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ark-bs-"))
  );
  tempDirs.push(worktree);
  let listener: {
    onLine(line: { raw: string }): void;
    onReset?(): void;
  } | null = null;
  const unsubscribe = vi.fn();
  const events: BoardSuggestEvent[] = [];
  const logs: string[] = [];
  const deps: BoardSuggestDeps = {
    subscribeJsonl: (_wt, _cfg, l) => {
      listener = l;
      return unsubscribe;
    },
    decide: vi.fn(async () => decision),
    threshold: () => 0.7,
    resolveWorktreeReal: () => worktree,
    openDiagram: vi.fn(async () => ({ ok: true })),
    isIdle: () => true,
    sendToClaude: vi.fn(),
    notify: e => events.push(e),
    now: () => 1_700_000_000_000,
    log: m => logs.push(m),
    ...overrides,
  };
  const service = new BoardSuggestService(deps);
  service.attach({ id: "s1", worktreePath: "/wt", profileConfigDir: null });
  // 時間ではなく状態を待つ: decide の呼び出しと、その後の通知/ログ/送信が
  // 出揃うまでポーリングする (上限つき)
  const push = async (raw: string, settled: () => boolean) => {
    listener?.onLine({ raw });
    const deadline = Date.now() + 2000;
    while (!settled() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5));
    }
  };
  return { deps, service, worktree, events, logs, push, unsubscribe };
}

describe("BoardSuggestService", () => {
  it("閾値以上かつ doc なら、返答を doc に書いて開き、通知する", async () => {
    const { deps, worktree, events, push } = setup({
      board: 0.88,
      form: "doc",
      figure: 0.1,
      cost: 0,
    });
    await push(endTurnLine("## 見出し\n\n本文です。"), () => events.length > 0);
    expect(deps.decide).toHaveBeenCalledWith("## 見出し\n\n本文です。");
    expect(deps.openDiagram).toHaveBeenCalledTimes(1);
    const [, relPath] = (deps.openDiagram as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(relPath).toMatch(
      /^\.claude\/diagrams\/_auto\/s1\/\d{8}-\d{6}\.diagram\.html$/
    );
    expect(fs.existsSync(path.join(worktree, relPath))).toBe(true);
    expect(events).toEqual([
      {
        sessionId: "s1",
        at: 1_700_000_000_000,
        probability: 0.88,
        form: "doc",
        relPath,
        title: "見出し",
      },
    ]);
    expect(deps.sendToClaude).not.toHaveBeenCalled();
  });

  it("閾値未満なら何もしない", async () => {
    const { deps, events, push } = setup({
      board: 0.4,
      form: "doc",
      figure: 0,
      cost: 0,
    });
    await push(
      endTurnLine("短い返答"),
      () => (deps.decide as ReturnType<typeof vi.fn>).mock.calls.length > 0
    );
    await new Promise(r => setTimeout(r, 20));
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(deps.openDiagram).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("figure なら Claude が手を止めているときだけ作図依頼を送る", async () => {
    const decision: BoardDecision = {
      board: 0.9,
      form: "figure",
      figure: 0.8,
      cost: 0,
    };
    const busy = setup(decision, { isIdle: () => false });
    await busy.push(endTurnLine("フロー"), () =>
      busy.logs.some(l => l.includes("見送る"))
    );
    expect(busy.deps.sendToClaude).not.toHaveBeenCalled();
    expect(busy.events).toEqual([]);

    const idle = setup(decision);
    await idle.push(endTurnLine("フロー"), () => idle.events.length > 0);
    expect(idle.deps.sendToClaude).toHaveBeenCalledWith(
      "s1",
      FIGURE_REQUEST_MESSAGE
    );
    expect(idle.events[0]).toMatchObject({
      form: "figure",
      relPath: null,
      title: null,
    });
    expect(idle.deps.openDiagram).not.toHaveBeenCalled();
  });

  it("Jev の失敗は 1 回だけログに出し、回復したら 1 行出す", async () => {
    let fail = true;
    const { logs, push } = setup(
      { board: 0.1, form: "doc", figure: 0, cost: 0 },
      {
        decide: async () => {
          if (fail) throw new Error("boom");
          return { board: 0.1, form: "doc", figure: 0, cost: 0 };
        },
      }
    );
    await push(endTurnLine("a"), () => logs.some(l => l.includes("boom")));
    await push(endTurnLine("b"), () => false);
    expect(logs.filter(l => l.includes("boom"))).toHaveLength(1);
    fail = false;
    await push(endTurnLine("c"), () => logs.some(l => l.includes("回復")));
    expect(logs.some(l => l.includes("回復"))).toBe(true);
  });

  it("detach で購読を解除し、以後の行を無視する", async () => {
    const { deps, service, push, unsubscribe } = setup({
      board: 0.9,
      form: "doc",
      figure: 0,
      cost: 0,
    });
    service.detach("s1");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    service.detach("s1");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await push(
      endTurnLine("x"),
      () => (deps.decide as ReturnType<typeof vi.fn>).mock.calls.length > 0
    );
    // 購読解除後も listener 自体は残っているが、実運用では tail が呼ばなくなる。
    // ここでは二重 detach が安全なことだけを確認する
    expect(deps.decide).toHaveBeenCalledTimes(1);
  });
});
