import type { ManagedSession, Worktree } from "@ark/shared";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MobileLayout } from "./MobileLayout";
import type { ViewerTab } from "./TerminalPane";

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
    isRemote: false,
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
    sessionPreviews: new Map(),
    worktreeDisplayNames: new Map(),
    getTabsForSession: vi.fn(() => tabs),
    getActiveTabForSession: vi.fn(() => 0),
    handleTabSelect: vi.fn(),
    handleTabClose: vi.fn(),
    openDiagramTab: vi.fn(),
    diagramOpenRequest: null,
    diagramCommentsUpdate: null,
    listDiagrams: vi.fn(async () => []),
    deleteDiagram: vi.fn(),
    getDiagramComments: vi.fn(),
    createDiagramComment: vi.fn(),
    replyDiagramComment: vi.fn(),
    resolveDiagramComment: vi.fn(),
    deleteDiagramComment: vi.fn(),
    sendDiagramComment: vi.fn(),
  } as ComponentProps<typeof MobileLayout>;
}

describe("MobileLayout diagram wiring", () => {
  it("Dashboard の図タブ状態と DiagramPane transport を MobileSessionView へ渡す", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, createProps())
    );

    expect(markup).toContain('aria-label="表示する図"');
    expect(markup).toContain("mobile.diagram.html");
  });
});

describe("MobileLayoutの下部タブ", () => {
  it("ローカルでは下部タブを出さず、画面の下端に余白も足さない", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
        isRemote: false,
      })
    );

    expect(markup).not.toContain("<nav");
    expect(markup).not.toContain("pb-14");
  });

  it("リモートでは下部タブを出し、選択中のタブをaria-currentで示す", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        sessionSubView: "list",
        isRemote: true,
      })
    );

    expect(markup).toMatch(/<nav [^>]*aria-label="画面の切り替え"/);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("ブラウザ");
    expect(markup).toContain("pb-14");
    expect(markup).not.toContain("border-t-2");
  });

  it("ローカルではブラウザのタブが保存されていても一覧を出す", () => {
    // 設定はサーバーに保存され端末をまたぐので、リモートの端末で開いたブラウザのタブが残りうる。
    // ローカルには下部タブが無いので、一覧に戻さないと戻る手段の無い空の画面になる
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, {
        ...createProps(),
        activeTab: "browser",
        sessionSubView: "list",
        isRemote: false,
      })
    );

    const listWrapperClass = markup.match(
      /<div class="([^"]*)"><div class="[^"]*safe-area-x/
    )?.[1];
    expect(listWrapperClass).toBe("flex-1 flex flex-col min-h-0");
  });

  it("リモートでも会話の詳細画面では下部タブを出さず、余白も付けない", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileLayout, { ...createProps(), isRemote: true })
    );

    expect(markup).toContain('aria-label="表示する図"');
    expect(markup).not.toContain("<nav");
    expect(markup).not.toContain("pb-14");
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
