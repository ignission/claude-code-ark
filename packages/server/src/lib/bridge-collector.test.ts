/**
 * bridge-collector の tmux 読み取り失敗の扱い (#393)
 *
 * collectBridgeSessions / collectGridSnapshots / collectStreamLines は 1 秒前後の
 * polling で呼ばれる。capture-pane が失敗したとき、失敗理由 (stderr) が 1 度だけ
 * ログに残り、毎 tick 繰り返さないこと、および成功時と同じ形で結果が組み立て
 * られることを検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "%0\n", stderr: "" })),
}));

vi.mock("./database.js", () => ({
  db: { getSetting: vi.fn(() => null) },
}));

vi.mock("./session-orchestrator.js", () => ({
  sessionOrchestrator: { getAllSessions: vi.fn(() => []) },
}));

vi.mock("./tmux-manager.js", () => ({
  tmuxManager: {
    capturePane: vi.fn(),
    capturePaneVisible: vi.fn(),
  },
}));

import {
  collectBridgeSessions,
  collectGridSnapshots,
  collectStreamLines,
} from "./bridge-collector.js";
import { sessionOrchestrator } from "./session-orchestrator.js";
import { tmuxManager } from "./tmux-manager.js";

const mockedOrchestrator = vi.mocked(sessionOrchestrator);
const mockedTmux = vi.mocked(tmuxManager);

const tmuxFailed = (stderr: string) => ({
  ok: false as const,
  failure: {
    kind: "tmux-failed" as const,
    command: "capture-pane",
    status: 1,
    signal: null,
    stderr,
  },
});

const managedSession = {
  id: "sess-1",
  worktreeId: "wt-1",
  worktreePath: "/repo/wt",
  repoPath: "/repo",
  status: "active",
  createdAt: new Date("2026-08-22T00:00:00Z"),
  tmuxSessionName: "ark-sess-1",
  ttydPort: null,
  ttydUrl: null,
  profileId: null,
  profileConfigDir: null,
  staleProfile: false,
  lastDiagramPath: null,
};

describe("bridge-collector - tmux 読み取り失敗 (#393)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedOrchestrator.getAllSessions.mockReturnValue([
      managedSession as never,
    ]);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("collectBridgeSessions: capture-pane 失敗は ERR で残り、理由は 1 度だけ警告する", () => {
    mockedTmux.capturePaneVisible.mockReturnValue(
      tmuxFailed("can't find pane: ark-sess-1")
    );

    const first = collectBridgeSessions();
    const second = collectBridgeSessions();

    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe("ERR");
    expect(first[0]?.previewText).toBe("");
    expect(second).toHaveLength(1);
    const matching = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("can't find pane: ark-sess-1")
    );
    expect(matching).toHaveLength(1);
  });

  it("collectGridSnapshots: capture-pane 失敗は ERR の snapshot で返り、理由は 1 度だけ警告する", () => {
    mockedTmux.capturePaneVisible.mockReturnValue(
      tmuxFailed("no server running")
    );

    const first = collectGridSnapshots();
    const second = collectGridSnapshots();

    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe("ERR");
    expect(second).toHaveLength(1);
    const matching = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("no server running")
    );
    expect(matching).toHaveLength(1);
  });

  it("collectStreamLines: capture-pane 失敗なら空配列を返し、理由は 1 度だけ警告する", () => {
    mockedTmux.capturePane.mockReturnValue(tmuxFailed("server exited"));

    expect(collectStreamLines("sess-1")).toEqual([]);
    expect(collectStreamLines("sess-1")).toEqual([]);

    const matching = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("server exited")
    );
    expect(matching).toHaveLength(1);
  });

  it("成功時は画面テキストを解析して返す", () => {
    // reporter はモジュール単位で状態を持つため、前のテストで失敗した id を
    // 使うと「回復」行が出る。失敗歴の無い id で警告ゼロを検証する
    mockedOrchestrator.getAllSessions.mockReturnValue([
      { ...managedSession, id: "sess-ok" } as never,
    ]);
    mockedTmux.capturePaneVisible.mockReturnValue({
      ok: true,
      value: "⏺ Bash(ls)\n  ⎿ ok\n❯ ",
    });

    const sessions = collectBridgeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.previewText).not.toBe("");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
