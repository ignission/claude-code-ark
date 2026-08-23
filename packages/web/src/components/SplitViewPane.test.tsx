// @vitest-environment jsdom

import type { BridgeSessionStatus, ManagedSession } from "@ark/shared";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeSplitViewLeftMode,
  readSavedSplitViewLeftMode,
  STORAGE_KEY_SPLIT_LEFT_MODE,
  writeSavedSplitViewLeftMode,
} from "../lib/split-view-left-mode";
import { SplitViewPane } from "./SplitViewPane";

interface ObservedChatProps {
  session: ManagedSession;
  isActive: boolean;
  bridgeStatus?: BridgeSessionStatus;
  awaitingText?: string;
}

const testDoubles = vi.hoisted(() => ({
  splitChatPane: vi.fn(),
}));

vi.mock("./SplitChatPane", () => ({
  SplitChatPane: (props: ObservedChatProps) => {
    testDoubles.splitChatPane(props);
    return <div data-testid={`chat-${props.session.id}`} />;
  },
}));

vi.mock("./DiagramPane", () => ({
  DiagramPane: () => <div data-testid="diagram-pane" />,
}));

vi.mock("../hooks/useMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("../hooks/useTerminalLinkInjection", () => ({
  useTerminalLinkInjection: () => undefined,
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

function makeSession(id: string): ManagedSession {
  return {
    id,
    worktreeId: `worktree-${id}`,
    worktreePath: `/worktrees/${id}`,
    status: "active",
    createdAt: new Date("2026-08-23T00:00:00Z"),
    tmuxSessionName: `tmux-${id}`,
    ttydPort: 4100,
    ttydUrl: `/ttyd/${id}/`,
  };
}

const notCalled = async (): Promise<never> => {
  throw new Error("このテストでは呼ばれない関数です");
};

function makePaneProps(
  session: ManagedSession,
  isActive: boolean
): ComponentProps<typeof SplitViewPane> {
  return {
    socket: null,
    isConnected: true,
    diagramCommentsUpdate: null,
    listDiagrams: async () => [],
    deleteDiagram: notCalled,
    getDiagramComments: notCalled,
    createDiagramComment: notCalled,
    resolveDiagramComment: notCalled,
    replyDiagramComment: notCalled,
    deleteDiagramComment: notCalled,
    sendDiagramComment: notCalled,
    session,
    isActive,
    worktree: undefined,
    tabs: [{ type: "terminal", id: `terminal-${session.id}` }],
    activeTabIndex: 0,
    onTabSelect: vi.fn(),
    onTabClose: vi.fn(),
    onSelectDiagram: vi.fn(),
    onSendMessage: vi.fn(),
    onSendKey: vi.fn(),
    onDeleteSession: vi.fn(),
    onUploadFile: vi.fn(async data => ({
      path: `/uploads/${data.originalFilename ?? "file"}`,
      filename: data.originalFilename ?? "file",
    })),
    messageShortcuts: [],
    onCreateShortcut: vi.fn(),
    onUpdateShortcut: vi.fn(),
    onDeleteShortcut: vi.fn(),
  };
}

function paneSection(
  session: ManagedSession,
  isActive: boolean,
  overrides: Partial<ComponentProps<typeof SplitViewPane>> = {}
): ReactElement {
  return (
    <section key={session.id} data-testid={`pane-${session.id}`}>
      <SplitViewPane {...makePaneProps(session, isActive)} {...overrides} />
    </section>
  );
}

function renderSessions(
  activeSessionId: string,
  sessions: ManagedSession[],
  overrides: Partial<ComponentProps<typeof SplitViewPane>> = {}
): ReactElement {
  return (
    <>
      {sessions.map(session =>
        paneSection(session, session.id === activeSessionId, overrides)
      )}
    </>
  );
}

function clickButton(scope: ParentNode, label: string): void {
  const button = scope.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
  expect(button).not.toBeNull();
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function dispatchFileDrop(filename: string): void {
  const event = new Event("drop", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      files: [new File(["review"], filename, { type: "text/plain" })],
    },
  });
  window.dispatchEvent(event);
}

function latestChatProps(sessionId: string): ObservedChatProps {
  const calls = testDoubles.splitChatPane.mock.calls
    .map(([props]) => props as ObservedChatProps)
    .filter(props => props.session.id === sessionId);
  const latest = calls.at(-1);
  expect(latest).toBeDefined();
  return latest as ObservedChatProps;
}

function hasTerminalUploadPreview(scope: ParentNode): boolean {
  return (
    scope.querySelector('[data-testid="terminal-upload-preview"]') !== null
  );
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
  vi.restoreAllMocks();
});

describe("PC 左ペインの表示モード", () => {
  it("保存値を正規化し、localStorage が使えなくても既定へ戻る", () => {
    expect(normalizeSplitViewLeftMode("terminal")).toBe("terminal");
    expect(normalizeSplitViewLeftMode("chat")).toBe("chat");
    expect(normalizeSplitViewLeftMode("board")).toBe("terminal");
    expect(readSavedSplitViewLeftMode({ getItem: () => null })).toBe(
      "terminal"
    );
    expect(
      readSavedSplitViewLeftMode({
        getItem: () => {
          throw new Error("storage disabled");
        },
      })
    ).toBe("terminal");
    expect(() =>
      writeSavedSplitViewLeftMode("chat", {
        setItem: () => {
          throw new Error("storage disabled");
        },
      })
    ).not.toThrow();
  });

  it("SplitViewPane から会話ビューへ bridgeStatus / awaitingText を渡す", () => {
    localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "chat");
    const session = makeSession("wiring");

    mount(
      paneSection(session, true, {
        bridgeStatus: "AWAITING",
        awaitingText: "レビューを続けますか？",
      })
    );

    expect(latestChatProps(session.id)).toMatchObject({
      isActive: true,
      bridgeStatus: "AWAITING",
      awaitingText: "レビューを続けますか？",
    });
  });

  it("トグル操作で状態と localStorage が変わり、全セッションで共有される", () => {
    const sessions = [makeSession("a"), makeSession("b")];
    const container = mount(renderSessions("a", sessions));
    const paneA = container.querySelector('[data-testid="pane-a"]');
    const paneB = container.querySelector('[data-testid="pane-b"]');
    expect(paneA).not.toBeNull();
    expect(paneB).not.toBeNull();

    clickButton(paneA as ParentNode, "会話");

    expect(localStorage.getItem(STORAGE_KEY_SPLIT_LEFT_MODE)).toBe("chat");
    for (const pane of [paneA, paneB]) {
      expect(
        pane
          ?.querySelector('button[aria-label="会話"]')
          ?.getAttribute("aria-pressed")
      ).toBe("true");
    }
    expect(
      paneA?.querySelector('[data-testid="chat-a"]')?.parentElement?.className
    ).toBe("h-full");
    expect(
      paneB?.querySelector('[data-testid="chat-b"]')?.parentElement?.className
    ).toBe("h-full");
  });

  it("localStorage 書き込み失敗時も全セッションへ選択モードを通知する", () => {
    const sessions = [makeSession("storage-a"), makeSession("storage-b")];
    const container = mount(renderSessions("storage-a", sessions));
    const paneA = container.querySelector('[data-testid="pane-storage-a"]');
    const paneB = container.querySelector('[data-testid="pane-storage-b"]');
    expect(paneA).not.toBeNull();
    expect(paneB).not.toBeNull();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    clickButton(paneA as ParentNode, "会話");

    expect(localStorage.getItem(STORAGE_KEY_SPLIT_LEFT_MODE)).toBeNull();
    for (const pane of [paneA, paneB]) {
      expect(
        pane
          ?.querySelector('button[aria-label="会話"]')
          ?.getAttribute("aria-pressed")
      ).toBe("true");
    }
  });

  it("active session と left mode に応じて会話購読と端末 D&D を一枚だけ有効にする", async () => {
    const sessions = [makeSession("a"), makeSession("b")];
    const container = mount(renderSessions("a", sessions));
    const root = mountedRoots.at(-1)?.root;
    expect(root).toBeDefined();

    expect(latestChatProps("a").isActive).toBe(false);
    expect(latestChatProps("b").isActive).toBe(false);

    await act(async () => {
      dispatchFileDrop("active-a.txt");
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(
      hasTerminalUploadPreview(
        container.querySelector('[data-testid="pane-a"]') as ParentNode
      )
    ).toBe(true);
    expect(
      hasTerminalUploadPreview(
        container.querySelector('[data-testid="pane-b"]') as ParentNode
      )
    ).toBe(false);

    act(() => root?.render(renderSessions("b", sessions)));
    expect(latestChatProps("a").isActive).toBe(false);
    expect(latestChatProps("b").isActive).toBe(false);

    clickButton(container, "会話");
    expect(latestChatProps("a").isActive).toBe(false);
    expect(latestChatProps("b").isActive).toBe(true);
  });

  it("display:none の TerminalPane は window drop を処理しない", async () => {
    localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "chat");
    const session = makeSession("hidden-terminal");
    const container = mount(paneSection(session, true));
    const readSpy = vi.spyOn(FileReader.prototype, "readAsDataURL");

    await act(async () => {
      dispatchFileDrop("must-not-be-read.txt");
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(readSpy).not.toHaveBeenCalled();
    expect(hasTerminalUploadPreview(container)).toBe(false);

    // 陽性対照: 同じペインを端末表示に戻せば、同じ window drop が処理される。
    clickButton(container, "端末");
    await act(async () => {
      dispatchFileDrop("visible-terminal.txt");
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(hasTerminalUploadPreview(container)).toBe(true);
  });
});
