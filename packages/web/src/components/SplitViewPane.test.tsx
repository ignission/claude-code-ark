// @vitest-environment jsdom

import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
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

/**
 * Radix の DropdownMenuTrigger は pointerdown で開くため、素の click() だけでは
 * 開かない (jsdom で確認済み)。開いた内容は Portal で document.body 直下に出る。
 */
function openDropdown(trigger: Element | null | undefined): void {
  expect(trigger).not.toBeNull();
  act(() => {
    (trigger as HTMLElement).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true })
    );
    (trigger as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    );
  });
}

function headerButtonLabels(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll("button"))
    .map(button => button.getAttribute("aria-label"))
    .filter((label): label is string => label !== null);
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

async function waitForTerminalUploadPreview(scope: ParentNode): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!hasTerminalUploadPreview(scope)) {
    if (Date.now() >= deadline) {
      throw new Error(
        "terminal upload preview did not appear within 5 seconds"
      );
    }
    await act(
      () =>
        new Promise<void>(resolve => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
          };
          channel.port2.postMessage(undefined);
        })
    );
  }
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
  vi.unstubAllGlobals();
});

describe("PC 左ペインの表示モード", () => {
  it("保存値を正規化し、保存なし・不正値・localStorage の例外では会話を既定にする", () => {
    expect(normalizeSplitViewLeftMode("terminal")).toBe("terminal");
    expect(normalizeSplitViewLeftMode("chat")).toBe("chat");
    expect(normalizeSplitViewLeftMode("board")).toBe("chat");
    expect(normalizeSplitViewLeftMode(null)).toBe("chat");
    expect(readSavedSplitViewLeftMode({ getItem: () => null })).toBe("chat");
    expect(readSavedSplitViewLeftMode({ getItem: () => "terminal" })).toBe(
      "terminal"
    );
    expect(
      readSavedSplitViewLeftMode({
        getItem: () => {
          throw new Error("storage disabled");
        },
      })
    ).toBe("chat");
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
    localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "terminal");
    const sessions = [makeSession("a"), makeSession("b")];
    const container = mount(renderSessions("a", sessions));
    const paneA = container.querySelector('[data-testid="pane-a"]');
    const paneB = container.querySelector('[data-testid="pane-b"]');
    expect(paneA).not.toBeNull();
    expect(paneB).not.toBeNull();
    const iframeBeforeA = paneA?.querySelector("iframe");
    const iframeBeforeB = paneB?.querySelector("iframe");
    expect(iframeBeforeA).not.toBeNull();
    expect(iframeBeforeB).not.toBeNull();

    clickButton(paneA as ParentNode, "会話");

    expect(localStorage.getItem(STORAGE_KEY_SPLIT_LEFT_MODE)).toBe("chat");
    for (const [pane, id] of [
      [paneA, "a"],
      [paneB, "b"],
    ] as const) {
      expect(
        pane
          ?.querySelector('button[aria-label="会話"]')
          ?.getAttribute("aria-pressed")
      ).toBe("true");
      // 会話を表示し、端末は隠したまま残す (ttydのiframeを作り直さない)
      expect(
        pane?.querySelector(`[data-testid="chat-${id}"]`)?.closest(".hidden")
      ).toBeNull();
      expect(pane?.querySelector("iframe")?.closest(".hidden")).not.toBeNull();
    }

    clickButton(paneA as ParentNode, "端末");

    // 会話へ切り替えて端末へ戻っても、同じiframe要素が残っている
    // (作り直されていない = ttydが再接続していない証拠。要素の同一性で確認する)
    expect(localStorage.getItem(STORAGE_KEY_SPLIT_LEFT_MODE)).toBe("terminal");
    expect(paneA?.querySelector("iframe")).toBe(iframeBeforeA);
    expect(paneB?.querySelector("iframe")).toBe(iframeBeforeB);
  });

  it("localStorage 書き込み失敗時も全セッションへ選択モードを通知する", () => {
    localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "terminal");
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

    // 書き込みは失敗し、保存値は切り替え前のまま
    expect(localStorage.getItem(STORAGE_KEY_SPLIT_LEFT_MODE)).toBe("terminal");
    for (const pane of [paneA, paneB]) {
      expect(
        pane
          ?.querySelector('button[aria-label="会話"]')
          ?.getAttribute("aria-pressed")
      ).toBe("true");
    }
  });

  it("active session と left mode に応じて会話購読と端末 D&D を一枚だけ有効にする", async () => {
    localStorage.setItem(STORAGE_KEY_SPLIT_LEFT_MODE, "terminal");
    const sessions = [makeSession("a"), makeSession("b")];
    const container = mount(renderSessions("a", sessions));
    const root = mountedRoots.at(-1)?.root;
    expect(root).toBeDefined();

    expect(latestChatProps("a").isActive).toBe(false);
    expect(latestChatProps("b").isActive).toBe(false);

    act(() => dispatchFileDrop("active-a.txt"));
    await waitForTerminalUploadPreview(
      container.querySelector('[data-testid="pane-a"]') as ParentNode
    );
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

    act(() => dispatchFileDrop("must-not-be-read.txt"));

    expect(readSpy).not.toHaveBeenCalled();
    expect(hasTerminalUploadPreview(container)).toBe(false);

    // 陽性対照: 同じペインを端末表示に戻せば、同じ window drop が処理される。
    clickButton(container, "端末");
    act(() => dispatchFileDrop("visible-terminal.txt"));
    expect(readSpy).toHaveBeenCalledTimes(1);
    await waitForTerminalUploadPreview(container);
    expect(hasTerminalUploadPreview(container)).toBe(true);
  });
});

function makeWorktree(branch: string): Worktree {
  return {
    id: "worktree-header",
    path: "/worktrees/header",
    branch,
    commit: "0000000",
    isMain: false,
    isBare: false,
  };
}

describe("PC上部バー", () => {
  it("主ラベルは表示名、無ければリポジトリ名。ブランチと状態チップを並べる", () => {
    const session = makeSession("header");
    const container = mount(
      paneSection(session, true, {
        displayName: "ログイン画面",
        repoName: "recipe-app",
        worktree: makeWorktree("feature/login"),
        bridgeStatus: "AWAITING",
      })
    );

    const header = container.querySelector("header");
    expect(header?.textContent).toContain("ログイン画面");
    expect(header?.textContent).not.toContain("recipe-app");
    expect(header?.textContent).toContain("feature/login");
    expect(header?.textContent).toContain("確認待ち");

    const root = mountedRoots.at(-1)?.root;
    act(() =>
      root?.render(
        paneSection(session, true, {
          displayName: null,
          repoName: "recipe-app",
          worktree: makeWorktree("feature/login"),
          bridgeStatus: "AWAITING",
        })
      )
    );
    expect(container.querySelector("header")?.textContent).toContain(
      "recipe-app"
    );
  });

  it("端末 / 会話の切り替え・図の開閉・その他の操作を上部バーに置く", () => {
    // 図を開くとSplitViewPaneが幅の追従にResizeObserverを使う (jsdomに無い)
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    const container = mount(paneSection(makeSession("header-actions"), true));
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    const scope = header as ParentNode;
    expect(scope.querySelector('button[aria-label="端末"]')).not.toBeNull();
    expect(scope.querySelector('button[aria-label="会話"]')).not.toBeNull();
    expect(
      scope.querySelector('button[aria-label="その他の操作"]')
    ).not.toBeNull();
    expect(
      scope
        .querySelector('button[aria-label="図"]')
        ?.getAttribute("aria-pressed")
    ).toBe("false");

    clickButton(scope, "図");

    expect(
      scope
        .querySelector('button[aria-label="図"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="diagram-pane"]')
    ).not.toBeNull();
  });
});

describe("PC上部バーの1タップ操作", () => {
  const QUICK_LABELS = [
    "ファイルを添付",
    "画像を貼り付け",
    "メッセージのショートカット",
  ];

  it("端末モードでは添付・画像・ショートカットを図の手前に並べる", () => {
    writeSavedSplitViewLeftMode("terminal");
    const container = mount(paneSection(makeSession("quick-terminal"), true));
    const scope = container.querySelector("header") as ParentNode;

    const labels = headerButtonLabels(scope);
    expect(labels).toContain("ファイルを添付");
    expect(labels).toContain("画像を貼り付け");
    expect(labels).toContain("メッセージのショートカット");
    for (const label of QUICK_LABELS) {
      expect(labels.indexOf(label)).toBeLessThan(labels.indexOf("図"));
    }
  });

  it("会話モードの添付と画像は会話の入力欄が担うので、ショートカットだけ置く", () => {
    writeSavedSplitViewLeftMode("chat");
    const container = mount(paneSection(makeSession("quick-chat"), true));
    const scope = container.querySelector("header") as ParentNode;

    const labels = headerButtonLabels(scope);
    expect(labels).not.toContain("ファイルを添付");
    expect(labels).not.toContain("画像を貼り付け");
    expect(labels).toContain("メッセージのショートカット");
  });

  it("アップロードできない環境では、端末モードでも添付と画像を出さない", () => {
    writeSavedSplitViewLeftMode("terminal");
    const container = mount(
      paneSection(makeSession("quick-no-upload"), true, {
        onUploadFile: undefined,
      })
    );
    const scope = container.querySelector("header") as ParentNode;

    const labels = headerButtonLabels(scope);
    expect(labels).not.toContain("ファイルを添付");
    expect(labels).not.toContain("画像を貼り付け");
    expect(labels).toContain("メッセージのショートカット");
  });

  it("添付のボタンは端末ペインのファイル選択を開く", () => {
    writeSavedSplitViewLeftMode("terminal");
    const container = mount(paneSection(makeSession("quick-attach"), true));
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const click = vi.spyOn(input as HTMLInputElement, "click");

    clickButton(
      container.querySelector("header") as ParentNode,
      "ファイルを添付"
    );

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("画像のボタンはクリップボードを読みに行く", () => {
    writeSavedSplitViewLeftMode("terminal");
    const read = vi.fn(async () => []);
    Object.defineProperty(navigator, "clipboard", {
      value: { read },
      configurable: true,
    });
    const container = mount(paneSection(makeSession("quick-paste"), true));

    clickButton(
      container.querySelector("header") as ParentNode,
      "画像を貼り付け"
    );

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("ショートカットのボタンは1タップで一覧を出す", () => {
    writeSavedSplitViewLeftMode("chat");
    const container = mount(
      paneSection(makeSession("quick-shortcuts"), true, {
        messageShortcuts: [
          {
            id: "sc-1",
            message: "続けて",
            sortOrder: 1,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      })
    );

    openDropdown(
      container
        .querySelector("header")
        ?.querySelector('button[aria-label="メッセージのショートカット"]')
    );

    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain(
      "続けて"
    );
  });

  it("ショートカットの管理ダイアログは上部バーの外で開く (メニューが閉じても残る)", () => {
    writeSavedSplitViewLeftMode("chat");
    const container = mount(paneSection(makeSession("quick-manage"), true));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    openDropdown(
      container
        .querySelector("header")
        ?.querySelector('button[aria-label="メッセージのショートカット"]')
    );
    const manage = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find(el => el.textContent === "ショートカットを管理");
    act(() => manage?.click());

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("`…` からはショートカット・添付・画像を外し、端末の操作と削除を残す", () => {
    writeSavedSplitViewLeftMode("terminal");
    const container = mount(
      paneSection(makeSession("quick-rest"), true, {
        onCopyBuffer: vi.fn(async () => "buffer"),
      })
    );

    openDropdown(
      container
        .querySelector("header")
        ?.querySelector('button[aria-label="その他の操作"]')
    );

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).not.toContain("メッセージショートカット");
    expect(menu?.textContent).not.toContain("ファイルを添付");
    expect(menu?.textContent).not.toContain("画像を貼り付け");
    expect(menu?.textContent).toContain("端末のバッファをコピー");
    expect(menu?.textContent).toContain("端末を再読み込み");
    expect(menu?.textContent).toContain("入力バーを表示");
    expect(menu?.textContent).toContain("セッションを削除");
  });
});
