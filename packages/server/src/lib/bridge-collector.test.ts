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

// CLI 状態ファイルの読み取りだけを差し替える (格上げ規則 mergeCliSessionState は
// 本物を使う)。モックしないと、このテストが実機の ~/.claude/sessions を読む
vi.mock("./cli-session-status.js", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./cli-session-status.js")>();
  return {
    ...actual,
    cliSessionStatusReader: { stateFor: vi.fn(() => null) },
  };
});

// transcript の読み取りも実機の ~/.claude/projects を見るので差し替える。
// 既定は「判定できない」= 画面だけで決まる (このファイルの既存テストの前提)
vi.mock("./transcript-conversation.js", () => ({
  readTranscriptConversationState: vi.fn(() => "unknown"),
}));

import {
  analyzeBridgeStatus,
  collectBridgeSessions,
  collectGridSnapshots,
  collectStreamLines,
} from "./bridge-collector.js";
import { cliSessionStatusReader } from "./cli-session-status.js";
import { sessionOrchestrator } from "./session-orchestrator.js";
import { tmuxManager } from "./tmux-manager.js";
import * as transcriptConversation from "./transcript-conversation.js";

const mockedOrchestrator = vi.mocked(sessionOrchestrator);
const mockedTmux = vi.mocked(tmuxManager);
const mockedCliStatus = vi.mocked(cliSessionStatusReader);
const mockedTranscript = vi.mocked(transcriptConversation);

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
    mockedCliStatus.stateFor.mockReturnValue(null);
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

describe("bridge-collector - CLI の状態ファイルによる格上げ", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedOrchestrator.getAllSessions.mockReturnValue([
      { ...managedSession, id: "sess-cli" } as never,
    ]);
    mockedCliStatus.stateFor.mockReturnValue(null);
  });

  /** 画面には進行中の行が無い (subagent 実行中の本体の見え方) */
  const idleScreen = { ok: true as const, value: "前の作業が終わりました\n❯ " };

  it("画面が IDLE でも CLI が busy なら TOOL にする", () => {
    mockedTmux.capturePaneVisible.mockReturnValue(idleScreen);
    expect(collectBridgeSessions()[0]?.status).toBe("IDLE");

    mockedCliStatus.stateFor.mockReturnValue("busy");
    expect(collectBridgeSessions()[0]?.status).toBe("TOOL");
    expect(collectGridSnapshots()[0]?.status).toBe("TOOL");
  });

  it("画面が空 (READY) でも CLI が busy なら TOOL にする", () => {
    mockedTmux.capturePaneVisible.mockReturnValue({ ok: true, value: "❯ " });
    expect(collectBridgeSessions()[0]?.status).toBe("READY");

    mockedCliStatus.stateFor.mockReturnValue("busy");
    expect(collectBridgeSessions()[0]?.status).toBe("TOOL");
  });

  it("画面が AWAITING なら busy でも画面を優先する", () => {
    mockedTmux.capturePaneVisible.mockReturnValue({
      ok: true,
      value: "Do you want to proceed?\n1. Yes\n2. No",
    });
    mockedCliStatus.stateFor.mockReturnValue("busy");
    expect(collectBridgeSessions()[0]?.status).toBe("AWAITING");
  });

  it("capture-pane 失敗の ERR は busy でも上書きしない", () => {
    mockedTmux.capturePaneVisible.mockReturnValue(tmuxFailed("no server"));
    mockedCliStatus.stateFor.mockReturnValue("busy");
    expect(collectBridgeSessions()[0]?.status).toBe("ERR");
  });

  it("waiting / idle では画面の判定のまま", () => {
    mockedTmux.capturePaneVisible.mockReturnValue(idleScreen);
    for (const state of ["waiting", "idle"] as const) {
      mockedCliStatus.stateFor.mockReturnValue(state);
      expect(collectBridgeSessions()[0]?.status).toBe("IDLE");
    }
  });

  it("tmux セッション名・worktree・プロファイルの configDir で引く", () => {
    mockedTmux.capturePaneVisible.mockReturnValue(idleScreen);
    mockedOrchestrator.getAllSessions.mockReturnValue([
      {
        ...managedSession,
        id: "sess-cli",
        profileConfigDir: "/home/tester/.claude-alt",
      } as never,
    ]);
    collectBridgeSessions();
    expect(mockedCliStatus.stateFor).toHaveBeenCalledWith({
      tmuxSessionName: "ark-sess-1",
      worktreePath: "/repo/wt",
      configDir: "/home/tester/.claude-alt",
    });
  });
});

/**
 * `/clear` 直後の実測画面 (Claude Code v2.1.276、2026-09-18 に使い捨ての tmux
 * セッションで capture-pane したもの。空行の連なりだけ詰めてある)。
 *
 * 起動バナーと `❯ /clear` は isUiLine が落とすが、行頭 `▎` のお知らせは
 * 落とす文字の並び (▘▝▛▜▐▌█) に無いのですり抜ける。この 1 種類だけで
 * previewText は 327 文字になり、「空なら READY」には掛からない。
 */
const AFTER_CLEAR_SCREEN = [
  "",
  " ▐▛███▛█   Claude Code v2.1.276",
  "▝▜██████▀  Opus 5 (1M context) with xhigh effort · Claude Max",
  "  ▝▝ ▝▝    /…/scratchpad/clearprobe",
  "",
  "▎ Auto mode is now Claude Code's default permission mode.",
  "▎ Auto mode lets Claude handle permission prompts automatically.",
  "▎ Claude checks each tool call for risky actions and prompt",
  "▎ injection before executing, runs the ones it assesses as",
  "▎ lower-risk, and blocks the rest.",
  "▎ https://code.claude.com/docs/en/permission-modes",
  "",
  "❯ /clear",
  "",
  "─────────────────────────────────────────────────────────────────",
  "❯ ",
  "─────────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

describe("bridge-collector - /clear 直後を待機にする", () => {
  it("この画面は空にならない (だから「空なら READY」では効かない)", () => {
    const { previewText } = analyzeBridgeStatus(AFTER_CLEAR_SCREEN, false);
    expect(previewText.trim().length).toBeGreaterThan(0);
  });

  it("画面が IDLE で、現行 transcript に会話が無ければ READY", () => {
    expect(
      analyzeBridgeStatus(
        AFTER_CLEAR_SCREEN,
        false,
        null,
        () => "no-conversation"
      ).status
    ).toBe("READY");
  });

  it("会話がある transcript では IDLE のまま (あなたの番)", () => {
    expect(
      analyzeBridgeStatus(
        AFTER_CLEAR_SCREEN,
        false,
        null,
        () => "has-conversation"
      ).status
    ).toBe("IDLE");
  });

  it("判定できないときは既存の画面判定のまま", () => {
    expect(
      analyzeBridgeStatus(AFTER_CLEAR_SCREEN, false, null, () => "unknown")
        .status
    ).toBe("IDLE");
    // 渡さない呼び出し (既存の挙動) も同じ
    expect(analyzeBridgeStatus(AFTER_CLEAR_SCREEN, false).status).toBe("IDLE");
  });

  it("画面が空なら transcript を読まずに READY (読み取りを増やさない)", () => {
    const read = vi.fn(() => "has-conversation" as const);
    expect(analyzeBridgeStatus("❯ ", false, null, read).status).toBe("READY");
    expect(read).not.toHaveBeenCalled();
  });

  it("IDLE 以外は transcript が空でも格下げしない", () => {
    const empty = () => "no-conversation" as const;
    // AWAITING (許諾プロンプト): ユーザーの操作が要る
    expect(
      analyzeBridgeStatus(
        "Do you want to proceed?\n1. Yes\n2. No",
        false,
        null,
        empty
      ).status
    ).toBe("AWAITING");
    // ERR (セッションが壊れている)
    expect(
      analyzeBridgeStatus("panicked at 'boom'", false, null, empty).status
    ).toBe("ERR");
    // THINK / TOOL (進行中の行がある)
    expect(
      analyzeBridgeStatus("✻ Wibbling… (4s · 23 tokens)", false, null, empty)
        .status
    ).toBe("THINK");
    expect(
      analyzeBridgeStatus(
        "⏺ Bash(ls)\n✻ Wibbling… (4s · 23 tokens)",
        false,
        null,
        empty
      ).status
    ).toBe("TOOL");
    // STOP (ライフサイクル上の停止)
    expect(
      analyzeBridgeStatus(AFTER_CLEAR_SCREEN, true, null, empty).status
    ).toBe("STOP");
  });

  it("CLI が busy なら READY へ落とさず作業中に格上げする", () => {
    expect(
      analyzeBridgeStatus(
        AFTER_CLEAR_SCREEN,
        false,
        "busy",
        () => "no-conversation"
      ).status
    ).toBe("TOOL");
  });
});

describe("bridge-collector - collector も transcript を見る", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedOrchestrator.getAllSessions.mockReturnValue([
      managedSession as never,
    ]);
    mockedCliStatus.stateFor.mockReturnValue(null);
    mockedTmux.capturePaneVisible.mockReturnValue({
      ok: true,
      value: AFTER_CLEAR_SCREEN,
    });
  });

  it("collectBridgeSessions / collectGridSnapshots とも会話が無ければ READY", () => {
    mockedTranscript.readTranscriptConversationState.mockReturnValue(
      "no-conversation"
    );
    expect(collectBridgeSessions()[0]?.status).toBe("READY");
    expect(collectGridSnapshots()[0]?.status).toBe("READY");
  });

  it("会話があれば IDLE のまま", () => {
    mockedTranscript.readTranscriptConversationState.mockReturnValue(
      "has-conversation"
    );
    expect(collectBridgeSessions()[0]?.status).toBe("IDLE");
    expect(collectGridSnapshots()[0]?.status).toBe("IDLE");
  });

  it("worktree とプロファイルの configDir で引く", () => {
    mockedTranscript.readTranscriptConversationState.mockReturnValue("unknown");
    mockedOrchestrator.getAllSessions.mockReturnValue([
      { ...managedSession, profileConfigDir: "/home/tester/.claude-alt" },
    ] as never);
    collectBridgeSessions();
    expect(
      mockedTranscript.readTranscriptConversationState
    ).toHaveBeenCalledWith("/repo/wt", "/home/tester/.claude-alt");
  });
});
