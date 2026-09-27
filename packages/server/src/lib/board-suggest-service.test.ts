import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  /** 開いたボードの relPath (openDiagram が成功した分) */
  const opened: string[] = [];
  const logs: string[] = [];
  const deps: BoardSuggestDeps = {
    subscribeJsonl: (_wt, _cfg, l) => {
      listener = l;
      return unsubscribe;
    },
    decide: vi.fn(async () => decision),
    enabled: () => true,
    apiKey: () => "sk-test",
    threshold: () => 0.7,
    resolveWorktreeReal: () => worktree,
    openDiagram: vi.fn(async (_sid: string, relPath: string) => {
      opened.push(relPath);
      return { ok: true };
    }),
    now: () => 1_700_000_000_000,
    turnSettleMs: 0,
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
    opened,
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
  it("閾値以上かつ doc なら、返答を doc に書いて開く", async () => {
    const { deps, worktree, opened, push } = setup({
      board: 0.88,
      form: "doc",
      figure: 0.1,
      cost: 0,
    });
    await push(endTurnLine("## 見出し\n\n本文です。"), () => opened.length > 0);
    expect(deps.decide).toHaveBeenCalledWith(
      "## 見出し\n\n本文です。",
      "sk-test"
    );
    expect(deps.openDiagram).toHaveBeenCalledTimes(1);
    const [, relPath, shouldAbort] = (
      deps.openDiagram as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(typeof shouldAbort).toBe("function");
    expect(shouldAbort()).toBe(false);
    expect(relPath).toMatch(
      /^\.claude\/diagrams\/_auto\/s1\/\d{8}-\d{6}-\d{3}-\d+\.diagram\.html$/
    );
    expect(fs.existsSync(path.join(worktree, relPath))).toBe(true);
    expect(opened).toEqual([relPath]);
  });

  it("無効か鍵が無ければ Jev を呼ばない", async () => {
    const off = setup(
      { board: 0.9, form: "doc", figure: 0, cost: 0 },
      { enabled: () => false }
    );
    off.listener()?.onLine({ raw: endTurnLine("長い説明") });
    await new Promise(r => setTimeout(r, 30));
    expect(off.deps.decide).not.toHaveBeenCalled();
    const noKey = setup(
      { board: 0.9, form: "doc", figure: 0, cost: 0 },
      { apiKey: () => null }
    );
    noKey.listener()?.onLine({ raw: endTurnLine("長い説明") });
    await new Promise(r => setTimeout(r, 30));
    expect(noKey.deps.decide).not.toHaveBeenCalled();
    expect(noKey.logs).toEqual([]);
  });

  it("1 つの返答の本文が複数の行に分かれても、判定は 1 回で本文をすべて含む", async () => {
    const { deps, opened, push, listener } = setup({
      board: 0.9,
      form: "doc",
      figure: 0,
      cost: 0,
    });
    // 同じ返答の 2 つの本文の行が続けて届く (どちらも end_turn を持つ)
    listener()?.onLine({ raw: endTurnLine("前半です。") });
    await push(endTurnLine("後半です。"), () => opened.length > 0);
    await new Promise(r => setTimeout(r, 20));
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(deps.decide).toHaveBeenCalledWith(
      "前半です。\n\n後半です。",
      "sk-test"
    );
    expect(opened).toHaveLength(1);
  });

  it("同じ時刻で 2 ターン続いてもファイル名が衝突しない", async () => {
    const { deps, opened, push } = setup({
      board: 0.9,
      form: "doc",
      figure: 0,
      cost: 0,
    });
    await push(endTurnLine("一つ目"), () => opened.length > 0);
    await push(endTurnLine("二つ目"), () => opened.length > 1);
    const paths = (deps.openDiagram as ReturnType<typeof vi.fn>).mock.calls.map(
      c => c[1]
    );
    expect(new Set(paths).size).toBe(2);
  });

  it("閾値未満なら何もしない", async () => {
    const { deps, opened, push } = setup({
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
    expect(opened).toEqual([]);
  });

  it("figure なら何もしない (ファイルも書かず、開かない)", async () => {
    const { deps, worktree, push } = setup({
      board: 0.9,
      form: "figure",
      figure: 0.8,
      cost: 0,
    });
    await push(
      endTurnLine("フロー"),
      () => (deps.decide as ReturnType<typeof vi.fn>).mock.calls.length > 0
    );
    await new Promise(r => setTimeout(r, 20));
    expect(deps.openDiagram).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(worktree, ".claude"))).toBe(false);
  });

  it("判定中に会話が進んだ (新しい発話 / clear) ら、その判定の結果は捨てる", async () => {
    let resolveDecide: ((d: BoardDecision) => void) | null = null;
    const { deps, opened, push, listener } = setup(
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
    expect(opened).toEqual([]);
  });

  it("ボードを開く読み込みの間に会話が進んだら、open 側の判定で開かず、失敗としても残さない", async () => {
    const { deps, logs, push, listener } = setup(
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
    expect(logs).toEqual([]);
  });

  it("detach された後に判定が返っても何もしない", async () => {
    let resolveDecide: ((d: BoardDecision) => void) | null = null;
    const { deps, opened, service, push } = setup(
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
    expect(opened).toEqual([]);
  });

  it("生成先の途中が worktree の外を指す symlink なら doc を書かない", async () => {
    const { deps, opened, worktree, logs, push } = setup({
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
    expect(opened).toEqual([]);
  });

  it("Jev の失敗は 1 回だけログに出し、回復したら 1 行出す", async () => {
    let fail = true;
    const { logs, push, listener } = setup(
      { board: 0.1, form: "doc", figure: 0, cost: 0 },
      {
        decide: async () => {
          if (fail) throw new Error("boom");
          return { board: 0.1, form: "doc", figure: 0, cost: 0 };
        },
      }
    );
    await push(endTurnLine("a"), () => logs.some(l => l.includes("boom")));
    listener()?.onLine({ raw: endTurnLine("b") });
    await new Promise(r => setTimeout(r, 30));
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
    const { deps, service, unsubscribe, listener } = setup({
      board: 0.9,
      form: "doc",
      figure: 0,
      cost: 0,
    });
    service.detach("s1");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    service.detach("s1");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // 購読解除後も listener 自体は残っている (実運用では tail が呼ばなくなる)。
    // 行が届いても、確定の時点で detach 済みなので判定しない
    listener()?.onLine({ raw: endTurnLine("x") });
    await new Promise(r => setTimeout(r, 20));
    expect(deps.decide).not.toHaveBeenCalled();
  });

  it("確定を待っている間に会話が進んだら、次のターンの途中経過を判定しない", async () => {
    const { deps, listener } = setup(
      { board: 0.9, form: "doc", figure: 0, cost: 0 },
      { turnSettleMs: 10 }
    );
    listener()?.onLine({ raw: endTurnLine("前の返答") });
    // 確定前に次の発言と、次の返答の途中の本文が届く
    listener()?.onLine({
      raw: JSON.stringify({ type: "user", message: { content: "次" } }),
    });
    listener()?.onLine({
      raw: JSON.stringify({
        type: "assistant",
        message: {
          stop_reason: "tool_use",
          content: [{ type: "text", text: "途中経過" }],
        },
      }),
    });
    await new Promise(r => setTimeout(r, 30));
    expect(deps.decide).not.toHaveBeenCalled();
    // 次の返答が終われば、途中経過も含めて 1 回判定する
    listener()?.onLine({ raw: endTurnLine("次の結論") });
    const deadline = Date.now() + 2000;
    while (
      (deps.decide as ReturnType<typeof vi.fn>).mock.calls.length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise(r => setTimeout(r, 5));
    }
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(deps.decide).toHaveBeenCalledWith("途中経過\n\n次の結論", "sk-test");
  });

  it("確定を待っている間に detach されたら判定しない", async () => {
    const { deps, service, listener } = setup(
      { board: 0.9, form: "doc", figure: 0, cost: 0 },
      { turnSettleMs: 10 }
    );
    listener()?.onLine({ raw: endTurnLine("説明") });
    service.detach("s1");
    await new Promise(r => setTimeout(r, 30));
    expect(deps.decide).not.toHaveBeenCalled();
  });
});
