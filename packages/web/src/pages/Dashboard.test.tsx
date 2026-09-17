// @vitest-environment jsdom

import type { ManagedSession } from "@ark/shared";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "./Dashboard";

const testDoubles = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  splitChatPane: vi.fn(),
  sessionSidebar: vi.fn(),
  aboutDialog: vi.fn(),
  bridgeSnapshotEnabled: vi.fn(),
  mobileLayout: vi.fn(),
  isMobile: false,
  socketState: {} as Record<string, unknown>,
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: {},
    isLoading: false,
    getSetting: testDoubles.getSetting,
    setSetting: testDoubles.setSetting,
  }),
}));

vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => testDoubles.socketState,
}));

vi.mock("@/hooks/useMobile", () => ({
  useIsMobile: () => testDoubles.isMobile,
}));

vi.mock("@/hooks/useBridgeSnapshot", () => ({
  useBridgeSnapshot: (_socket: unknown, enabled: boolean) => {
    testDoubles.bridgeSnapshotEnabled(enabled);
    return null;
  },
}));

vi.mock("@/hooks/useSessionNotifications", () => ({
  useSessionNotifications: () => ({
    supported: false,
    permission: "denied",
    requestPermission: vi.fn(),
  }),
}));

vi.mock("@/hooks/useViewerTabs", () => ({
  useViewerTabs: () => ({
    getTabsForSession: (sessionId: string) => [
      { type: "terminal", id: `terminal-${sessionId}` },
    ],
    getActiveTabForSession: () => 0,
    handleTabSelect: vi.fn(),
    handleTabClose: vi.fn(),
    openDiagramTab: vi.fn(),
    clearDiagramTab: vi.fn(),
  }),
}));

vi.mock("@/components/SplitChatPane", () => ({
  SplitChatPane: (props: Record<string, unknown>) => {
    testDoubles.splitChatPane(props);
    return <div data-testid="dashboard-chat" />;
  },
}));

vi.mock("@/components/TerminalPane", () => ({
  TerminalPane: () => <div data-testid="dashboard-terminal" />,
}));

vi.mock("@/components/DiagramPane", () => ({
  DiagramPane: () => null,
}));

vi.mock("@/components/SidebarMainLayout", () => ({
  SidebarMainLayout: ({
    sidebar,
    main,
  }: {
    sidebar: ReactNode;
    main: ReactNode;
  }) => (
    <>
      {sidebar}
      {main}
    </>
  ),
}));

vi.mock("@/components/AboutDialog", () => ({
  AboutDialog: (props: Record<string, unknown>) => {
    testDoubles.aboutDialog(props);
    return null;
  },
}));
vi.mock("@/components/BrowserPane", () => ({ BrowserPane: () => null }));
vi.mock("@/components/CreateWorktreeDialog", () => ({
  CreateWorktreeDialog: () => null,
}));
vi.mock("@/components/NotificationPermissionButton", () => ({
  NotificationPermissionButton: () => null,
}));
vi.mock("@/components/ProfileManagerDialog", () => ({
  ProfileManagerDialog: () => null,
}));
vi.mock("@/components/RepoGridView", () => ({ RepoGridView: () => null }));
vi.mock("@/components/RepoSelectDialog", () => ({
  RepoSelectDialog: () => null,
}));
vi.mock("@/components/SessionSidebar", () => ({
  SessionSidebar: (props: Record<string, unknown>) => {
    testDoubles.sessionSidebar(props);
    return null;
  },
}));
vi.mock("@/components/UpdateBanner", () => ({ UpdateBanner: () => null }));

vi.mock("@/components/MobileLayout", () => ({
  MobileLayout: (props: Record<string, unknown>) => {
    testDoubles.mobileLayout(props);
    return null;
  },
  normalizeMobileTab: (value: unknown) => value,
  normalizeSessionId: (value: unknown) => value,
  normalizeSessionSubView: (value: unknown) => value,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: () => null,
  DialogContent: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
}));

vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/ui/input", () => ({ Input: () => null }));
vi.mock("@/components/ui/label", () => ({ Label: () => null }));
vi.mock("@/components/ui/select", () => ({
  Select: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

let mountedRoot: { root: Root; container: HTMLDivElement } | null = null;

function makeSession(): ManagedSession {
  return {
    id: "dashboard-session",
    worktreeId: "dashboard-worktree",
    worktreePath: "/worktrees/dashboard",
    status: "active",
    createdAt: new Date("2026-08-23T00:00:00Z"),
    tmuxSessionName: "tmux-dashboard",
    ttydPort: 4100,
    ttydUrl: "/ttyd/dashboard-session/",
  };
}

function socketState(session: ManagedSession): Record<string, unknown> {
  const fn = vi.fn();
  return {
    socket: null,
    isConnected: true,
    error: null,
    diagramCommentsUpdate: null,
    allowedRepos: [],
    repoList: [],
    repoPath: null,
    selectRepo: fn,
    removeRepo: fn,
    scannedRepos: [],
    isScanning: false,
    scanRepos: fn,
    listDirectory: fn,
    listDiagrams: async () => [],
    deleteDiagram: fn,
    getDiagramComments: fn,
    createDiagramComment: fn,
    replyDiagramComment: fn,
    resolveDiagramComment: fn,
    deleteDiagramComment: fn,
    sendDiagramComment: fn,
    worktrees: [],
    createWorktree: fn,
    deleteWorktree: fn,
    sessions: new Map([[session.id, session]]),
    sessionsLoaded: true,
    startSession: fn,
    stopSession: fn,
    sendMessage: fn,
    sendKey: fn,
    tunnelUrl: null,
    tunnelToken: null,
    tunnelLoading: false,
    tunnelJustStarted: false,
    startTunnel: fn,
    stopTunnel: fn,
    clearTunnelJustStarted: fn,
    listeningPorts: [],
    uploadFile: fn,
    copyBuffer: undefined,
    deletedWorktreeId: null,
    clearDeletedWorktreeId: fn,
    sessionPreviews: new Map(),
    sessionAwaitingTexts: new Map([
      [session.id, "Dashboard から届く AWAITING テキスト"],
    ]),
    gridSnapshots: new Map(),
    subscribeGrid: fn,
    unsubscribeGrid: fn,
    sessionStatuses: new Map([[session.id, "AWAITING"]]),
    sessionStatusSignals: [],
    sessionAuqSignals: [],
    readFile: fn,
    fileContent: null,
    browserSessions: new Map(),
    startBrowser: fn,
    navigateBrowser: fn,
    profiles: [],
    repoProfileLinks: new Map(),
    worktreeProfileLinks: new Map(),
    capabilities: { multiProfileSupported: false },
    createProfile: fn,
    updateProfile: fn,
    deleteProfile: fn,
    setRepoProfile: fn,
    setWorktreeProfile: fn,
    worktreeDisplayNames: new Map(),
    setWorktreeDisplayName: fn,
    restartSessionWithProfile: fn,
    messageShortcuts: [],
    createShortcut: fn,
    updateShortcut: fn,
    deleteShortcut: fn,
  };
}

function mount(element: ReactElement): void {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoot = { root, container };
}

function latestProps(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const props = mock.mock.calls.at(-1)?.[0];
  expect(props).toBeDefined();
  return props as Record<string, unknown>;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testDoubles.isMobile = false;
  testDoubles.mobileLayout.mockClear();
  localStorage.clear();
  localStorage.setItem("ark-split-left-mode", "chat");
  testDoubles.splitChatPane.mockClear();
  testDoubles.setSetting.mockClear();
  testDoubles.sessionSidebar.mockClear();
  testDoubles.aboutDialog.mockClear();
  testDoubles.bridgeSnapshotEnabled.mockClear();

  const session = makeSession();
  testDoubles.socketState = socketState(session);
  testDoubles.getSetting.mockImplementation((key: string, fallback: unknown) =>
    key === "selectedSessionId" ? session.id : fallback
  );
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.root.unmount());
    mountedRoot.container.remove();
    mountedRoot = null;
  }
});

describe("Dashboard の会話ビュー配線", () => {
  it("Dashboard → SplitViewPane → SplitChatPane へ preview 状態を渡す", () => {
    mount(<Dashboard />);

    const observed = testDoubles.splitChatPane.mock.calls
      .map(([props]) => props as Record<string, unknown>)
      .at(-1);
    expect(observed).toMatchObject({
      isActive: true,
      bridgeStatus: "AWAITING",
      awaitingText: "Dashboard から届く AWAITING テキスト",
    });
  });
});

describe("Dashboardのサイドバー配線", () => {
  it("状態とプレビューをサイドバーへ渡し、Aboutを開いている間だけホストの状態を購読する", () => {
    mount(<Dashboard />);

    const state = testDoubles.socketState;
    const sidebar = latestProps(testDoubles.sessionSidebar);
    expect(sidebar.sessionStatuses).toBe(state.sessionStatuses);
    expect(sidebar.sessionPreviews).toBe(state.sessionPreviews);
    expect(sidebar.selectedSessionId).toBe("dashboard-session");
    expect(sidebar).not.toHaveProperty("sessionActivityTexts");
    expect(latestProps(testDoubles.aboutDialog)).toMatchObject({
      open: false,
      metrics: null,
    });
    expect(testDoubles.bridgeSnapshotEnabled).toHaveBeenLastCalledWith(false);

    act(() => (sidebar.onOpenAbout as () => void)());

    expect(latestProps(testDoubles.aboutDialog)).toMatchObject({ open: true });
    expect(testDoubles.bridgeSnapshotEnabled).toHaveBeenLastCalledWith(true);
  });
});

describe("Dashboardのモバイル一覧の配線", () => {
  it("状態・プレビュー・表示名・プロファイルと、リポジトリの操作をMobileLayoutへ渡す", () => {
    testDoubles.isMobile = true;
    mount(<Dashboard />);

    const state = testDoubles.socketState;
    const layout = latestProps(testDoubles.mobileLayout);
    expect(layout.sessionStatuses).toBe(state.sessionStatuses);
    expect(layout.sessionPreviews).toBe(state.sessionPreviews);
    expect(layout.worktreeDisplayNames).toBe(state.worktreeDisplayNames);
    expect(layout.onSetWorktreeDisplayName).toBe(state.setWorktreeDisplayName);
    expect(layout.capabilities).toBe(state.capabilities);
    expect(layout.profiles).toBe(state.profiles);
    expect(layout.repoProfileLinks).toBe(state.repoProfileLinks);
    expect(layout.worktreeProfileLinks).toBe(state.worktreeProfileLinks);
    expect(layout.onSetRepoProfile).toBe(state.setRepoProfile);
    expect(layout.onSetWorktreeProfile).toBe(state.setWorktreeProfile);
    expect(layout.onOpenProfileManager).toBeTypeOf("function");
    expect(layout.onCreateWorktreeForRepo).toBeTypeOf("function");
    expect(layout.onRemoveRepo).toBeTypeOf("function");
  });
});

describe("Dashboardの上部バー配線", () => {
  it("上部バーに表示名と状態チップを出す", () => {
    const session = makeSession();
    testDoubles.socketState = {
      ...socketState(session),
      worktreeDisplayNames: new Map([[session.worktreePath, "ログイン画面"]]),
    };

    mount(<Dashboard />);

    const header = mountedRoot?.container.querySelector("header");
    expect(header?.textContent).toContain("ログイン画面");
    expect(header?.textContent).toContain("確認待ち");
  });

  it("サーバーとの切断を日本語の帯で知らせる", () => {
    const session = makeSession();
    testDoubles.socketState = { ...socketState(session), isConnected: false };

    mount(<Dashboard />);

    const text = mountedRoot?.container.textContent ?? "";
    expect(text).toContain("サーバーとつながっていません");
    expect(text).not.toContain("Not connected to server");
  });
});
