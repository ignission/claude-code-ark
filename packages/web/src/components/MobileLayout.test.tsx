import type { ManagedSession } from "@ark/shared";
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
