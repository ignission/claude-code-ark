// @vitest-environment jsdom

import type { ManagedSession, Worktree } from "@ark/shared";
import {
  act,
  type ComponentProps,
  createElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagramOpenRequest,
  getViewModeForDiagramOpenRequest,
  getViewModeForViewerTab,
  normalizeMobileSessionViewMode,
  writeSavedViewMode,
} from "../lib/mobile-session-view-mode";
import { MobileSessionView } from "./MobileSessionView";
import {
  MOBILE_SESSION_VIEW_MODES,
  MobileSessionViewModeToggle,
} from "./MobileSessionViewModeToggle";

interface ObservedChatProps {
  isActive: boolean;
  layout?: "pane" | "mobile";
  composerAccessory?: ReactNode;
  onActiveAuqChange?: (hasActiveAuq: boolean) => void;
}

const testDoubles = vi.hoisted(() => ({
  splitChatPane: vi.fn(),
}));

// 会話ビューの中身は Task 9 のテストで確かめる。ここでは受け取った props と、
// ガラスバーの上段に置かれる composerAccessory の描画だけを見る
vi.mock("./SplitChatPane", () => ({
  SplitChatPane: (props: ObservedChatProps) => {
    testDoubles.splitChatPane(props);
    return <div data-testid="chat-pane">{props.composerAccessory}</div>;
  },
}));

vi.mock("./DiagramPane", () => ({
  DiagramPane: () => <div data-testid="diagram-pane" />,
}));

vi.mock("../hooks/useTerminalLinkInjection", () => ({
  useTerminalLinkInjection: () => undefined,
}));

vi.mock("../hooks/useTtydReconnect", () => ({
  useTtydReconnect: () => undefined,
}));

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

const notCalled = async (): Promise<never> => {
  throw new Error("このテストでは呼ばれない関数です");
};

const worktree: Worktree = {
  id: "wt-1",
  path: "/repos/recipe-app-login",
  branch: "feat/login",
  commit: "abc1234",
  isMain: false,
  isBare: false,
};

function makeSession(): ManagedSession {
  return {
    id: "s1",
    worktreeId: "wt-1",
    worktreePath: "/repos/recipe-app-login",
    repoPath: "/repos/recipe-app",
    status: "active",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: "ark-s1",
    ttydPort: 7680,
    ttydUrl: "/ttyd/s1/",
  };
}

function makeProps(
  overrides: Partial<ComponentProps<typeof MobileSessionView>> = {}
): ComponentProps<typeof MobileSessionView> {
  return {
    socket: null,
    isActive: true,
    session: makeSession(),
    worktree,
    repoName: "recipe-app",
    onBack: vi.fn(),
    onSendMessage: vi.fn(),
    onSendKey: vi.fn(),
    onDeleteSession: vi.fn(),
    tabs: [{ type: "terminal", id: "terminal-s1" }],
    activeTabIndex: 0,
    diagramOpenRequest: null,
    onTabSelect: vi.fn(),
    onTabClose: vi.fn(),
    messageShortcuts: [],
    onCreateShortcut: vi.fn(),
    onUpdateShortcut: vi.fn(),
    onDeleteShortcut: vi.fn(),
    isConnected: true,
    diagramCommentsUpdate: null,
    listDiagrams: async () => [],
    deleteDiagram: notCalled,
    getDiagramComments: notCalled,
    createDiagramComment: notCalled,
    replyDiagramComment: notCalled,
    resolveDiagramComment: notCalled,
    deleteDiagramComment: notCalled,
    sendDiagramComment: notCalled,
    onSelectDiagram: vi.fn(),
    ...overrides,
  };
}

function latestChatProps(): ObservedChatProps {
  const latest = testDoubles.splitChatPane.mock.calls.at(-1)?.[0];
  expect(latest).toBeDefined();
  return latest as ObservedChatProps;
}

function click(element: Element | null | undefined): void {
  expect(element).not.toBeNull();
  expect(element).toBeDefined();
  act(() => (element as HTMLElement).click());
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  testDoubles.splitChatPane.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("mobile session view mode", () => {
  it("chat / terminal / board を正規化し、不正値は chat へ戻す", () => {
    expect(MOBILE_SESSION_VIEW_MODES.map(option => option.value)).toEqual([
      "chat",
      "terminal",
      "board",
    ]);
    expect(normalizeMobileSessionViewMode("chat")).toBe("chat");
    expect(normalizeMobileSessionViewMode("terminal")).toBe("terminal");
    expect(normalizeMobileSessionViewMode("board")).toBe("board");
    expect(normalizeMobileSessionViewMode("unknown")).toBe("chat");
    expect(normalizeMobileSessionViewMode(null)).toBe("chat");
  });

  it("board を永続化する", () => {
    const storage = { setItem: vi.fn() };

    writeSavedViewMode("board", storage);

    expect(storage.setItem).toHaveBeenCalledWith(
      "ark-mobile-session-view",
      "board"
    );
  });

  it("同じ図を続けて開いても通知が変化し、毎回 board へ切り替える", () => {
    const first = createDiagramOpenRequest(
      null,
      "session-1",
      ".claude/diagrams/mobile.diagram.html"
    );
    const second = createDiagramOpenRequest(
      first,
      "session-1",
      ".claude/diagrams/mobile.diagram.html"
    );

    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(getViewModeForDiagramOpenRequest("session-1", first, null)).toBe(
      "board"
    );
    expect(
      getViewModeForDiagramOpenRequest("session-1", second, first.sequence)
    ).toBe("board");
  });

  it("別セッション向け、処理済み、通知なしでは表示モードを変えない", () => {
    const request = createDiagramOpenRequest(
      null,
      "session-2",
      ".claude/diagrams/mobile.diagram.html"
    );

    expect(
      getViewModeForDiagramOpenRequest("session-1", request, null)
    ).toBeNull();
    expect(
      getViewModeForDiagramOpenRequest("session-2", request, request.sequence)
    ).toBeNull();
    // reload 復元は diagram:open 通知を作らない。
    expect(
      getViewModeForDiagramOpenRequest("session-1", null, null)
    ).toBeNull();
  });

  it.each(["file", "html"] as const)(
    "active な %s ビューワータブでは従来どおり terminal へ切り替える",
    activeTabType => {
      expect(getViewModeForViewerTab(activeTabType)).toBe("terminal");
    }
  );

  it("terminal タブでは表示モードを変えない", () => {
    expect(getViewModeForViewerTab("terminal")).toBeNull();
  });

  it("現在モードが分かる3択のセグメントを、絵文字を使わずに表示する", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileSessionViewModeToggle, {
        value: "board",
        onChange: vi.fn(),
      })
    );

    expect(markup.match(/<button/g)).toHaveLength(3);
    for (const label of ["会話", "端末", "図"]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).toMatch(
      /aria-label="図"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="図"/
    );
    expect(markup).not.toMatch(/💬|🖥|📐/);
  });
});

describe("MobileSessionView のヘッダー", () => {
  it("表示名・ブランチ・状態チップを出し、絵文字と等幅を使わない", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({
          bridgeStatus: "AWAITING",
          displayName: "ログイン画面",
        })}
      />
    );
    const header = container.querySelector("header");

    expect(header?.textContent).toContain("ログイン画面");
    expect(header?.textContent).not.toContain("recipe-app");
    expect(header?.textContent).toContain("feat/login");
    expect(header?.querySelector('[data-status="AWAITING"]')?.textContent).toBe(
      "確認待ち"
    );
    expect(header?.querySelector(".font-mono")).toBeNull();
    expect(header?.querySelector(".status-indicator")).toBeNull();
    expect(container.innerHTML).not.toMatch(/💬|🖥|📐/);
  });

  it("戻るボタンと操作メニューの入口だけを置き、削除とショートカットはメニューへ畳む", () => {
    const onBack = vi.fn();
    const container = mount(<MobileSessionView {...makeProps({ onBack })} />);
    const header = container.querySelector("header");

    // 表示名が無ければリポジトリ名を主ラベルにする
    expect(header?.textContent).toContain("recipe-app");
    click(header?.querySelector('button[aria-label="一覧へ戻る"]'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(
      header?.querySelector('button[aria-label="セッションの操作"]')
    ).not.toBeNull();
    expect(
      header?.querySelector('button[title="セッションを削除"]')
    ).toBeNull();
    expect(
      header?.querySelector('button[title="メッセージショートカット"]')
    ).toBeNull();
  });
});
