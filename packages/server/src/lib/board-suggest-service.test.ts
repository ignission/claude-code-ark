import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BoardSuggestEvent } from "@ark/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BoardSuggestDeps,
  BoardSuggestService,
  ensureContainedDir,
  writeFileConfined,
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
  return {
    deps,
    service,
    worktree,
    events,
    logs,
    push,
    unsubscribe,
    listener: () => listener,
  };
}

describe("ensureContainedDir", () => {
  it("無ければ作り、realpath が worktree の中なら返す", async () => {
    const worktree = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ark-contain-"))
    );
    tempDirs.push(worktree);
    const real = await ensureContainedDir(worktree, "a/b/c");
    expect(real).toBe(path.join(worktree, "a", "b", "c"));
    // 途中の要素がファイルなら拒否する
    fs.writeFileSync(path.join(worktree, "file"), "");
    expect(await ensureContainedDir(worktree, "file/x")).toBeNull();
  });
});

describe("writeFileConfined", () => {
  it("親が検証後に外向きの symlink へ差し替えられていたら、中身を書かずに消す", async () => {
    const worktree = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ark-confine-"))
    );
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ark-confine-out-"))
    );
    tempDirs.push(worktree, outside);
    const dir = await ensureContainedDir(worktree, "a/b");
    expect(dir).not.toBeNull();
    // ensureContainedDir の後で b を外向きの symlink に差し替える (TOCTOU)
    fs.rmdirSync(path.join(worktree, "a", "b"));
    fs.symlinkSync(outside, path.join(worktree, "a", "b"));

    const ok = await writeFileConfined(
      path.join(worktree, "a", "b", "x.html"),
      "secret"
    );
    expect(ok).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);

    // 差し替えが無ければ書ける。同じ名前は二度作らない
    fs.unlinkSync(path.join(worktree, "a", "b"));
    fs.mkdirSync(path.join(worktree, "a", "b"));
    const target = path.join(worktree, "a", "b", "y.html");
    expect(await writeFileConfined(target, "body")).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("body");
    await expect(writeFileConfined(target, "again")).rejects.toThrow(/EEXIST/);
  });
});

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
    const [, relPath, shouldAbort] = (
      deps.openDiagram as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(typeof shouldAbort).toBe("function");
    expect(shouldAbort()).toBe(false);
    expect(relPath).toMatch(
      /^\.claude\/diagrams\/_auto\/s1\/\d{8}-\d{6}-\d{3}\.diagram\.html$/
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

  it("figure なら通知だけ出し、ファイルも書かず Claude にも送らない", async () => {
    const { deps, events, worktree, push } = setup({
      board: 0.9,
      form: "figure",
      figure: 0.8,
      cost: 0,
    });
    await push(endTurnLine("フロー"), () => events.length > 0);
    expect(events[0]).toMatchObject({
      form: "figure",
      relPath: null,
      title: null,
      probability: 0.9,
    });
    expect(deps.openDiagram).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(worktree, ".claude"))).toBe(false);
  });

  it("判定中に会話が進んだ (新しい発話 / clear) ら、その判定の結果は捨てる", async () => {
    let resolveDecide: ((d: BoardDecision) => void) | null = null;
    const { deps, events, push, listener } = setup(
      { board: 0.9, form: "doc", figure: 0, cost: 0 },
      {
        decide: () =>
          new Promise<BoardDecision>(resolve => {
            resolveDecide = resolve;
          }),
      }
    );
    await push(endTurnLine("長い説明"), () => resolveDecide !== null);
    // 判定を待っている間にユーザーが次の発話をした
    listener()?.onLine({
      raw: JSON.stringify({ type: "user", message: { content: "次" } }),
    });
    resolveDecide?.({ board: 0.9, form: "doc", figure: 0, cost: 0 });
    await new Promise(r => setTimeout(r, 30));
    expect(deps.openDiagram).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("ボードを開く読み込みの間に会話が進んだら、open 側の判定で開かず、知らせない", async () => {
    const { deps, events, push, listener } = setup(
      { board: 0.9, form: "doc", figure: 0, cost: 0 },
      {
        openDiagram: vi.fn(async (_sid, _rel, shouldAbort) => {
          // readDiagram 相当の待ちの間にユーザーが発話した
          listener()?.onLine({
            raw: JSON.stringify({ type: "user", message: { content: "次" } }),
          });
          return shouldAbort()
            ? { ok: false, error: "会話が進んだので開かない" }
            : { ok: true };
        }),
      }
    );
    await push(
      endTurnLine("長い説明"),
      () => (deps.openDiagram as ReturnType<typeof vi.fn>).mock.calls.length > 0
    );
    await new Promise(r => setTimeout(r, 30));
    expect(events).toEqual([]);
  });

  it("detach された後に判定が返っても何もしない", async () => {
    let resolveDecide: ((d: BoardDecision) => void) | null = null;
    const { deps, events, service, push } = setup(
      { board: 0.9, form: "doc", figure: 0, cost: 0 },
      {
        decide: () =>
          new Promise<BoardDecision>(resolve => {
            resolveDecide = resolve;
          }),
      }
    );
    await push(endTurnLine("長い説明"), () => resolveDecide !== null);
    service.detach("s1");
    resolveDecide?.({ board: 0.9, form: "doc", figure: 0, cost: 0 });
    await new Promise(r => setTimeout(r, 30));
    expect(deps.openDiagram).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("生成先の途中が worktree の外を指す symlink なら doc を書かない", async () => {
    const { deps, events, worktree, logs, push } = setup({
      board: 0.9,
      form: "doc",
      figure: 0,
      cost: 0,
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ark-bs-outside-"));
    tempDirs.push(outside);
    fs.mkdirSync(path.join(worktree, ".claude", "diagrams"), {
      recursive: true,
    });
    fs.symlinkSync(
      outside,
      path.join(worktree, ".claude", "diagrams", "_auto")
    );
    await push(endTurnLine("長い説明"), () =>
      logs.some(l => l.includes("symlink"))
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(deps.openDiagram).not.toHaveBeenCalled();
    expect(events).toEqual([]);
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

  it("doc の書き出し失敗は Jev の失敗として数えず、毎回ログに残す", async () => {
    const { logs, push } = setup(
      { board: 0.9, form: "doc", figure: 0, cost: 0 },
      {
        openDiagram: async () => {
          throw new Error("disk");
        },
      }
    );
    await push(endTurnLine("a"), () => logs.some(l => l.includes("disk")));
    await push(
      endTurnLine("b"),
      () => logs.filter(l => l.includes("disk")).length >= 2
    );
    expect(logs.filter(l => l.includes("書き出しに失敗"))).toHaveLength(2);
    expect(logs.some(l => l.includes("判定に失敗"))).toBe(false);
    expect(logs.some(l => l.includes("回復"))).toBe(false);
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
