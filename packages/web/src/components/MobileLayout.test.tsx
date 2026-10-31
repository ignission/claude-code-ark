import type { ManagedSession, Worktree } from "@ark/shared";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MobileLayout, normalizeMobileTab } from "./MobileLayout";
import type { ViewerTab } from "./TerminalPane";

vi.mock("@/components/ScreenPane", () => ({ ScreenPane: () => null }));

const session: ManagedSession = {
  id: "session-1",
  worktreeId: "worktree-1",
  worktreePath: "/repo/worktree",
  status: "active",
  createdAt: new Date("2026-08-11T00:00:00Z"),
  tmuxSessionName: "ark-session-1",
  ttydPort: 7680,
  ttydUrl: "/ttyd/session-1/",
};

const tabs: ViewerTab[] = [
  { type: "terminal", id: "terminal" },
  {
    type: "diagram",
    id: "diagram-1",
    worktreePath: session.worktreePath,
    relPath: ".claude/diagrams/mobile.diagram.html",
  },
];

function createProps(): ComponentProps<typeof MobileLayout> {
  return {
    socket: null,
    sessions: new Map([[session.id, session]]),
    worktrees: [],
    repoList: [],
    repoPath: null,
    onStartSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onDeleteWorktree: vi.fn(),
    onSendMessage: vi.fn(),
    onSendKey: vi.fn(),
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    isSocketConnected: true,
    activeBrowserSession: null,
    onSelectBrowser: vi.fn(),
    screens: [],
    requestScreenCredentials: vi
      .fn()
      .mockResolvedValue({ kind: "unregistered" }),
    setScreenClipboard: vi.fn().mockResolvedValue({ ok: true }),
    onOpenScreenManager: vi.fn(),
    messageShortcuts: [],
    onCreateShortcut: vi.fn(),
    onUpdateShortcut: vi.fn(),
    onDeleteShortcut: vi.fn(),
    selectedSessionId: session.id,
    activeTab: "session",
    sessionSubView: "detail",
    onChangeActiveTab: vi.fn(),
    onChangeSessionSubView: vi.fn(),
    sessionsLoaded: true,
    sessionStatuses: new Map(),
    sessionAwaitingTexts: new Map(),
    sessionLiveTails: new Map(),
    sessionPreviews: new Map(),
    sessionPrStatuses: new Map(),
    sessionPlanLimits: new Map(),
    worktreeDisplayNames: new Map(),
    getTabsForSession: vi.fn(() => tabs),
    getActiveTabForSession: vi.fn(() => 0),
    getViewerOpenSeqForSession: vi.fn(() => 0),
    handleTabSelect: vi.fn(),
    handleTabClose: vi.fn(),
    openDiagramTab: vi.fn(),
    diagramOpenRequest: null,
    listDiagrams: vi.fn(async () => []),
    deleteDiagram: vi.fn(),
  } as ComponentProps<typeof MobileLayout>;
}

describe("MobileLayout diagram wiring", () => {
  it("Dashboard の図タブ状態と DiagramPane transport を MobileSessionView へ渡す", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, createProps())
    );

    expect(markup).toContain('aria-label="図の一覧"');
    expect(markup).toContain("mobile.diagram.html");
  });
});

const SCREENS = [
  {
    id: "s1",
    name: "ビルド VM",
    sshHost: "build.example.internal",
    sshPort: 22,
    sshUser: "user",
    vncHost: "127.0.0.1",
    vncPort: 5900,
    vncUser: "user",
    createdAt: 0,
    updatedAt: 0,
  },
];

describe("MobileLayoutの下部タブ", () => {
  it("下部タブが無いときは、画面の下端に余白も足さない", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
      })
    );

    expect(markup).not.toContain("<nav");
    expect(markup).not.toContain("pb-14");
  });

  it("会話の詳細画面では下部タブを出さず、余白も付けない", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        screens: SCREENS,
      })
    );

    expect(markup).toContain('aria-label="図の一覧"');
    expect(markup).not.toContain("<nav");
    expect(markup).not.toContain("pb-14");
  });

  it("画面が登録されていれば下部タブに「画面」を出し、選択中のタブをaria-currentで示す", () => {
    const html = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
        screens: SCREENS,
      })
    );
    expect(html).toContain('aria-label="画面の切り替え"');
    expect(html).toContain(">画面</button>");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("pb-14");
  });

  it("画面が未登録なら下部タブを出さない", () => {
    const html = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
        screens: [],
      })
    );
    expect(html).not.toContain('aria-label="画面の切り替え"');
  });
});

describe("MobileLayoutの一覧の配線", () => {
  it("一覧の行にプレビュー文と表示名を出す", () => {
    const worktree: Worktree = {
      id: session.worktreeId,
      path: session.worktreePath,
      branch: "feature/list",
      commit: "abc1234",
      isMain: false,
      isBare: false,
    };
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
        repoList: ["/repo"],
        worktrees: [worktree],
        sessionStatuses: new Map([[session.id, "TOOL"]]),
        sessionPreviews: new Map([[session.id, "テストを実行しています"]]),
        worktreeDisplayNames: new Map([[worktree.path, "一覧の表示名"]]),
      })
    );

    expect(markup).toContain("テストを実行しています");
    expect(markup).toContain("一覧の表示名");
  });
});

describe("normalizeMobileTab", () => {
  // 画面の登録が無いと下部タブが出ず、保存値の正規化を画面から確かめられないので、ここで固定する
  it("不正な保存値は session に戻す", () => {
    expect(normalizeMobileTab("garbage")).toBe("session");
    expect(normalizeMobileTab(42)).toBe("session");
    expect(normalizeMobileTab(undefined)).toBe("session");
    // 撤去したブラウザのタブが設定に残っていても一覧へ戻す
    expect(normalizeMobileTab("browser")).toBe("session");
  });

  it("正しい保存値はそのまま使う", () => {
    expect(normalizeMobileTab("session")).toBe("session");
    expect(normalizeMobileTab("screen")).toBe("screen");
  });
});
