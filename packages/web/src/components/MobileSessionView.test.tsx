// @vitest-environment jsdom

import type { ManagedSession, Worktree } from "@ark/shared";
import {
  act,
  type ComponentProps,
  createElement,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveAuq } from "../lib/ask-user-question-state";
import {
  createDiagramOpenRequest,
  getViewModeForDiagramOpenRequest,
  normalizeMobileSessionViewMode,
  readSavedViewMode,
  STORAGE_KEY_MOBILE_VIEW,
  shouldOpenTerminalForViewerTab,
  writeSavedViewMode,
} from "../lib/mobile-session-view-mode";
import { MobileSessionView } from "./MobileSessionView";
import {
  MOBILE_SESSION_VIEW_MODES,
  MobileSessionViewModeToggle,
} from "./MobileSessionViewModeToggle";
import type { SplitChatPaneHandle } from "./SplitChatPane";

interface ObservedChatProps {
  isActive: boolean;
  liveTail?: string;
  layout?: "pane" | "mobile";
  composerAccessory?: ReactNode;
  onOpenTerminal?: () => void;
  onActiveAuqChange?: (auq: ActiveAuq | null) => void;
  onEventsChange?: (events: unknown[], hasSnapshot: boolean) => void;
  ref?: Ref<SplitChatPaneHandle>;
}

const testDoubles = vi.hoisted(() => ({
  splitChatPane: vi.fn(),
  /** 端末の窓の中身 (タブバー) が描画された回数を数える */
  viewerTabBarRender: vi.fn(),
  chatOpenFilePicker: vi.fn(),
  chatPasteImage: vi.fn(),
}));

const toastDoubles = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastDoubles }));

// 会話ビューの中身は Task 9 のテストで確かめる。ここでは受け取った props と、
// ガラスバーの上段に置かれる composerAccessory の描画、そして下部バーから
// 呼ばれる取っ手 (SplitChatPaneHandle) だけを見る
vi.mock("./SplitChatPane", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    SplitChatPane: (props: ObservedChatProps) => {
      testDoubles.splitChatPane(props);
      useImperativeHandle(props.ref, () => ({
        openFilePicker: testDoubles.chatOpenFilePicker,
        pasteImage: testDoubles.chatPasteImage,
      }));
      return <div data-testid="chat-pane">{props.composerAccessory}</div>;
    },
  };
});

vi.mock("./DiagramPane", () => ({
  DiagramPane: () => <div data-testid="diagram-pane" />,
}));

// タブバーは本物を使い、描画された回数だけを数える
vi.mock("./ViewerTabBar", async importOriginal => {
  const actual = await importOriginal<typeof import("./ViewerTabBar")>();
  const { createElement: h } = await import("react");
  return {
    ...actual,
    ViewerTabBar: (props: ComponentProps<typeof actual.ViewerTabBar>) => {
      testDoubles.viewerTabBarRender();
      return h(actual.ViewerTabBar, props);
    },
  };
});

vi.mock("../hooks/useTerminalLinkInjection", () => ({
  useTerminalLinkInjection: () => undefined,
}));

vi.mock("../hooks/useTtydReconnect", () => ({
  useTtydReconnect: () => undefined,
}));

const voiceDoubles = vi.hoisted(() => ({
  supported: false,
  enter: vi.fn(),
  pushEvents: vi.fn(),
}));

vi.mock("../hooks/useVoiceMode", async () => {
  const { INITIAL_VOICE_STATE } = await import("../lib/voice-mode-machine");
  return {
    useVoiceMode: () => ({
      state: INITIAL_VOICE_STATE,
      supported: voiceDoubles.supported,
      enter: voiceDoubles.enter,
      exit: vi.fn(),
      tapMic: vi.fn(),
      cancel: vi.fn(),
      sendNow: vi.fn(),
      stopSpeaking: vi.fn(),
      expand: vi.fn(),
      resume: vi.fn(),
      retryUnsent: vi.fn(),
      dismissUnsent: vi.fn(),
      rate: 1.3,
      cycleRate: vi.fn(),
      subscribeLevel: () => () => undefined,
      pushEvents: voiceDoubles.pushEvents,
    }),
  };
});

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

const SAMPLE_AUQ: ActiveAuq = {
  toolUseId: "hook:1",
  questions: [
    {
      question: "どちらにしますか？",
      multiSelect: false,
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

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

/** 会話の帯を押して端末の窓を開く (帯は `SplitChatPane` の中なので、渡した関数を直接呼ぶ) */
function openTerminalWindow(): void {
  const open = latestChatProps().onOpenTerminal;
  expect(open).toBeDefined();
  act(() => open?.());
}

function terminalWindowOf(container: HTMLDivElement): HTMLElement {
  const backdrop = container.querySelector<HTMLElement>(
    '[data-testid="floating-terminal"]'
  );
  expect(backdrop).not.toBeNull();
  return backdrop as HTMLElement;
}

function isTerminalWindowOpen(container: HTMLDivElement): boolean {
  return terminalWindowOf(container).className !== "hidden";
}

/** 自分か祖先が `hidden` で隠れていないか (jsdomはレイアウトを持たないのでclassで見る) */
function isHiddenByClass(element: Element, root: Element): boolean {
  for (
    let node: Element | null = element;
    node && node !== root.parentElement;
    node = node.parentElement
  ) {
    if (node.classList.contains("hidden")) return true;
  }
  return false;
}

function terminalTab() {
  return { type: "terminal" as const, id: "terminal-s1" };
}

function fileTab() {
  return {
    type: "file" as const,
    id: "file-1",
    filePath: "/tmp/a.txt",
    content: "hello",
    mimeType: "text/plain",
    size: 5,
  };
}

function diagramTab() {
  return {
    type: "diagram" as const,
    id: "diagram-1",
    worktreePath: "/repos/recipe-app-login",
    relPath: ".claude/diagrams/a.diagram.html",
  };
}

/**
 * Radix の DropdownMenuTrigger は pointerdown で開くため、素の click() だけでは
 * 開かない (jsdom で確認済み)。開いた内容は Portal で document.body 直下に出る。
 */
function openDropdown(trigger: Element | null | undefined): void {
  expect(trigger).not.toBeNull();
  expect(trigger).toBeDefined();
  act(() => {
    (trigger as HTMLElement).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true })
    );
    (trigger as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    );
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  testDoubles.splitChatPane.mockClear();
  testDoubles.viewerTabBarRender.mockClear();
  voiceDoubles.supported = false;
  voiceDoubles.enter.mockClear();
  voiceDoubles.pushEvents.mockClear();
  testDoubles.chatOpenFilePicker.mockClear();
  testDoubles.chatPasteImage.mockClear();
  toastDoubles.success.mockClear();
  toastDoubles.info.mockClear();
  toastDoubles.error.mockClear();
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("mobile session view mode", () => {
  it("chat / board を正規化し、保存済みの terminal と不正値は chat として読む", () => {
    expect(MOBILE_SESSION_VIEW_MODES.map(option => option.value)).toEqual([
      "chat",
      "board",
    ]);
    expect(normalizeMobileSessionViewMode("chat")).toBe("chat");
    expect(normalizeMobileSessionViewMode("terminal")).toBe("chat");
    expect(normalizeMobileSessionViewMode("board")).toBe("board");
    expect(normalizeMobileSessionViewMode("unknown")).toBe("chat");
    expect(normalizeMobileSessionViewMode(null)).toBe("chat");
    expect(readSavedViewMode({ getItem: () => "terminal" })).toBe("chat");
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
    "active な %s ビューワータブは、端末の窓を開いて見せる",
    activeTabType => {
      expect(shouldOpenTerminalForViewerTab(activeTabType)).toBe(true);
    }
  );

  it("terminal / diagram タブと、タブなしでは端末の窓を開かない", () => {
    expect(shouldOpenTerminalForViewerTab("terminal")).toBe(false);
    expect(shouldOpenTerminalForViewerTab("diagram")).toBe(false);
    expect(shouldOpenTerminalForViewerTab(undefined)).toBe(false);
  });

  it("現在モードが分かる2択のセグメントを、絵文字を使わずに表示する。「端末」は無い", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileSessionViewModeToggle, {
        value: "board",
        onChange: vi.fn(),
      })
    );

    expect(markup.match(/<button/g)).toHaveLength(2);
    for (const label of ["会話", "図"]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).not.toContain('aria-label="端末"');
    expect(markup).toMatch(
      /aria-label="図"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="図"/
    );
    expect(markup).not.toMatch(/💬|🖥|📐/);
  });

  it("PCの作業エリアのタブと同じ lucide アイコンを使い、端末のアイコンは置かない", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileSessionViewModeToggle, {
        value: "chat",
        onChange: vi.fn(),
      })
    );

    // 会話=MessagesSquare / 図=Workflow (lib/view-mode-icons.ts)
    expect(markup).toContain("lucide-messages-square");
    expect(markup).toContain("lucide-workflow");
    expect(markup).not.toContain("lucide-square-terminal");
    expect(markup).not.toMatch(/lucide-message-circle|lucide-shapes\b/);
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
    // PCの `…` (SessionHeaderMenu) と同じ aria-label にそろえる
    expect(
      header?.querySelector('button[aria-label="その他の操作"]')
    ).not.toBeNull();
    expect(
      header?.querySelector('button[title="セッションを削除"]')
    ).toBeNull();
    expect(
      header?.querySelector('button[title="メッセージショートカット"]')
    ).toBeNull();
  });
});

function stripText(scope: ParentNode): string | null | undefined {
  return scope.querySelector(
    '[data-testid="mobile-status-strip"] [role="status"]'
  )?.textContent;
}

describe("MobileSessionView の状態の帯", () => {
  it("入力待ちでは帯を出さない", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "IDLE" })} />
    );
    expect(
      container.querySelector('[data-testid="mobile-status-strip"]')
    ).toBeNull();
  });

  it("考え中は「考えています」を出す", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "THINK" })} />
    );
    expect(stripText(container)).toBe("考えています");
  });

  it("サーバーと切断中はほかの状態より優先する", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({ bridgeStatus: "TOOL", isConnected: false })}
      />
    );
    expect(stripText(container)).toBe("サーバーとつながっていません");
  });

  it("会話モードで質問カードが出ていれば「質問があります」にし、ボタンは付けない", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "AWAITING" })} />
    );
    expect(stripText(container)).toBe("確認を求めています");

    act(() => latestChatProps().onActiveAuqChange?.(SAMPLE_AUQ));

    expect(stripText(container)).toBe("質問があります");
    expect(
      container.querySelector('[data-testid="mobile-status-strip"] button')
    ).toBeNull();
  });

  it("端末の窓を開いている間も会話の購読を続け、質問カードが閉じたことを帯に反映する", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "AWAITING" })} />
    );
    openTerminalWindow();
    // 購読を止めると、端末の窓で答えた質問の解決が届かず「質問があります」が残る
    expect(latestChatProps().isActive).toBe(true);

    act(() => latestChatProps().onActiveAuqChange?.(SAMPLE_AUQ));
    expect(stripText(container)).toBe("質問があります");

    act(() => latestChatProps().onActiveAuqChange?.(null));
    expect(stripText(container)).toBe("確認を求めています");
  });

  it("図モードで確認を求められたら「会話で答える」で会話モードへ切り替える", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "board");
    const container = mount(
      <MobileSessionView {...makeProps({ bridgeStatus: "AWAITING" })} />
    );
    expect(
      container.querySelector('[data-testid="mobile-view-chat"]')?.className
    ).toBe("hidden");

    const button = Array.from(
      container.querySelectorAll('[data-testid="mobile-status-strip"] button')
    ).find(b => b.textContent?.includes("会話で答える"));
    click(button);

    expect(
      container.querySelector('[data-testid="mobile-view-chat"]')?.className
    ).not.toBe("hidden");
    expect(localStorage.getItem(STORAGE_KEY_MOBILE_VIEW)).toBe("chat");
    expect(
      container.querySelector('[data-testid="mobile-status-strip"] button')
    ).toBeNull();
  });
});

describe("MobileSessionView の下部バー", () => {
  it("会話モードは SplitChatPane のガラスバーの上段にセグメントを渡し、ヘッダーには置かない", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);

    expect(
      container.querySelector('header button[aria-label="会話"]')
    ).toBeNull();
    expect(latestChatProps().layout).toBe("mobile");
    const chat = container.querySelector('[data-testid="mobile-view-chat"]');
    expect(
      chat
        ?.querySelector('[data-testid="chat-pane"] button[aria-label="会話"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("セグメントに「端末」は無く、モードを切り替えると保存して図の本文を出す", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    const chat = container.querySelector('[data-testid="mobile-view-chat"]');

    expect(container.querySelector('button[aria-label="端末"]')).toBeNull();
    click(chat?.querySelector('button[aria-label="図"]'));

    expect(localStorage.getItem(STORAGE_KEY_MOBILE_VIEW)).toBe("board");
    expect(
      container.querySelector('[data-testid="mobile-view-board"]')?.className
    ).not.toContain("hidden");
    expect(
      container.querySelector('[data-testid="mobile-view-chat"]')?.className
    ).toBe("hidden");
  });

  it("保存済みの「端末」モードは会話として開き、端末の窓は閉じたままにする", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "terminal");
    const container = mount(<MobileSessionView {...makeProps()} />);

    expect(
      container.querySelector('[data-testid="mobile-view-chat"]')?.className
    ).not.toBe("hidden");
    expect(isTerminalWindowOpen(container)).toBe(false);
  });

  it("端末の窓は不透明なバーにQuick Keys・入力欄を置き、セグメントは置かない。空のまま送るとEnterを送る", () => {
    const onSendMessage = vi.fn();
    const container = mount(
      <MobileSessionView {...makeProps({ onSendMessage })} />
    );
    openTerminalWindow();
    const bar = container.querySelector('[data-testid="mobile-terminal-bar"]');

    expect(terminalWindowOf(container).contains(bar)).toBe(true);
    expect(bar?.hasAttribute("data-mobile-bottom-bar")).toBe(true);
    expect(bar?.className).not.toContain("glass-bar");
    expect(bar?.querySelector('button[aria-label="会話"]')).toBeNull();
    expect(bar?.querySelector('button[aria-label="図"]')).toBeNull();
    expect(bar?.textContent).toContain("Ctrl+C");
    expect(bar?.querySelector("input")?.className).not.toContain("font-mono");

    // jsdom は submit ボタンの click で form の submit イベントを発火する (React の onSubmit が受ける)
    click(bar?.querySelector('button[aria-label="送信"]'));
    expect(onSendMessage).toHaveBeenCalledWith("");
  });

  it("端末の背景は ttyd と同じ暖色の暗色にする", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    openTerminalWindow();

    expect(
      container.querySelector("iframe")?.parentElement?.style.backgroundColor
    ).toBe("rgb(28, 26, 23)");
  });

  it("図モードはセグメントだけのバーを図の下に置く", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "board");
    const container = mount(<MobileSessionView {...makeProps()} />);
    const board = container.querySelector('[data-testid="mobile-view-board"]');
    const bar = board?.querySelector('[data-testid="mobile-board-bar"]');

    expect(bar?.hasAttribute("data-mobile-bottom-bar")).toBe(true);
    // セグメント2つ + 1タップ操作 (アップロードできないので添付と画像は出ない)
    expect(bar?.querySelectorAll("button")).toHaveLength(4);
    expect(
      bar
        ?.querySelector('button[aria-label="図"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(board?.lastElementChild).toBe(bar);
  });
});

describe("MobileSessionView の端末の窓", () => {
  it("会話の帯から全面の窓で開き、閉じるボタンで閉じる。開閉の状態は保存しない", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    expect(isTerminalWindowOpen(container)).toBe(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    openTerminalWindow();

    expect(isTerminalWindowOpen(container)).toBe(true);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("端末");
    // 全面の窓: 親の領域いっぱいで、背後を暗くする背景は持たない
    expect(dialog?.className).toContain("h-full");
    expect(dialog?.className).toContain("w-full");
    expect(terminalWindowOf(container).className).not.toContain(
      "bg-foreground"
    );
    // 会話モードのまま、上に重ねる
    expect(
      container.querySelector('[data-testid="mobile-view-chat"]')?.className
    ).not.toBe("hidden");

    click(dialog?.querySelector('button[aria-label="端末を閉じる"]'));

    expect(isTerminalWindowOpen(container)).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY_MOBILE_VIEW)).toBeNull();
  });

  it("窓はセッションの画面の直下に重なり、どのモードでも隠れた要素の中に入らない (閉じるボタンに届く)", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    const root = container.firstElementChild as HTMLElement;
    const backdrop = terminalWindowOf(container);
    // 位置の基準はセッションの画面のルート。モードごとの本文 (`hidden` で切り替わる) の中には置かない
    expect(backdrop.parentElement).toBe(root);
    expect(root.className).toContain("relative");

    openTerminalWindow();
    const closeInChat = backdrop.querySelector(
      'button[aria-label="端末を閉じる"]'
    );
    expect(closeInChat).not.toBeNull();
    expect(isHiddenByClass(closeInChat as Element, root)).toBe(false);
    click(closeInChat);

    // 図モードから開いても同じ
    click(
      container.querySelector(
        '[data-testid="chat-pane"] button[aria-label="図"]'
      )
    );
    openTerminalWindow();
    expect(isTerminalWindowOpen(container)).toBe(true);
    const closeInBoard = backdrop.querySelector(
      'button[aria-label="端末を閉じる"]'
    );
    expect(isHiddenByClass(closeInBoard as Element, root)).toBe(false);
    click(closeInBoard);
    expect(isTerminalWindowOpen(container)).toBe(false);
  });

  it("開閉で端末のiframeをアンマウントも付け替えもしない", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    const iframe = container.querySelector("iframe");
    const parent = iframe?.parentElement;
    expect(iframe).not.toBeNull();
    expect(terminalWindowOf(container).contains(iframe)).toBe(true);

    openTerminalWindow();
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(iframe?.parentElement).toBe(parent);

    click(container.querySelector('button[aria-label="端末を閉じる"]'));
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(iframe?.parentElement).toBe(parent);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("このセッションが表示中でなくなったら閉じ、戻ってきても閉じたまま", () => {
    const props = makeProps();
    const container = mount(<MobileSessionView {...props} />);
    const { root } = mountedRoots.at(-1) as { root: Root };
    openTerminalWindow();
    expect(isTerminalWindowOpen(container)).toBe(true);

    // 一覧へ戻る・別のセッションを開くと、`MobileLayout` が `isActive` をfalseにする
    act(() => root.render(<MobileSessionView {...props} isActive={false} />));
    expect(isTerminalWindowOpen(container)).toBe(false);

    act(() => root.render(<MobileSessionView {...props} isActive={true} />));
    expect(isTerminalWindowOpen(container)).toBe(false);
  });

  it("窓を開いている間に図を開く通知が来たら、窓を閉じて図モードを見せる", () => {
    const props = makeProps();
    const container = mount(<MobileSessionView {...props} />);
    const { root } = mountedRoots.at(-1) as { root: Root };
    openTerminalWindow();

    const request = createDiagramOpenRequest(
      null,
      "s1",
      ".claude/diagrams/a.diagram.html"
    );
    act(() =>
      root.render(<MobileSessionView {...props} diagramOpenRequest={request} />)
    );

    expect(isTerminalWindowOpen(container)).toBe(false);
    expect(
      container.querySelector('[data-testid="mobile-view-board"]')?.className
    ).not.toBe("hidden");
  });

  it("窓の中のタブで図を選んだら、窓を閉じて図モードを見せる", () => {
    const onTabSelect = vi.fn();
    const container = mount(
      <MobileSessionView
        {...makeProps({ tabs: [terminalTab(), diagramTab()], onTabSelect })}
      />
    );
    openTerminalWindow();

    const tab = Array.from(
      terminalWindowOf(container).querySelectorAll<HTMLElement>(
        "button, [role='tab']"
      )
    ).find(el => el.textContent?.includes("a.diagram.html"));
    click(tab);

    expect(onTabSelect).toHaveBeenCalledWith(1);
    expect(isTerminalWindowOpen(container)).toBe(false);
    expect(
      container.querySelector('[data-testid="mobile-view-board"]')?.className
    ).not.toBe("hidden");
  });

  it("ファイルのタブが選ばれたら、ビューアを持つ端末の窓を開いて見せる", () => {
    const props = makeProps();
    const container = mount(<MobileSessionView {...props} />);
    const { root } = mountedRoots.at(-1) as { root: Root };
    expect(isTerminalWindowOpen(container)).toBe(false);

    act(() =>
      root.render(
        <MobileSessionView
          {...props}
          tabs={[terminalTab(), fileTab()]}
          activeTabIndex={1}
        />
      )
    );

    expect(isTerminalWindowOpen(container)).toBe(true);
    expect(terminalWindowOf(container).textContent).toContain("hello");
  });

  it.each([
    ["ファイル", fileTab()],
    ["HTML", { type: "html" as const, id: "html-1", filePath: "/tmp/a.html" }],
  ])(
    "%sのタブが選ばれたままマウントしても、窓は開かない。帯から開けばそのタブが出る",
    (_label, tab) => {
      const props = makeProps({
        tabs: [terminalTab(), tab],
        activeTabIndex: 1,
      });
      const container = mount(<MobileSessionView {...props} />);
      const { root } = mountedRoots.at(-1) as { root: Root };

      expect(isTerminalWindowOpen(container)).toBe(false);

      // 画面末尾の更新などで描画し直しても、勝手には開かない
      act(() => root.render(<MobileSessionView {...props} liveTail="$ ls" />));
      expect(isTerminalWindowOpen(container)).toBe(false);

      openTerminalWindow();
      expect(isTerminalWindowOpen(container)).toBe(true);
      // 端末ではなく、選ばれているタブのビューアが出ている
      expect(
        terminalWindowOf(container).querySelector<HTMLElement>(
          'iframe[title^="Terminal"]'
        )?.parentElement?.style.display
      ).toBe("none");
    }
  );

  it("ファイルのタブが選ばれたままマウントしたあと、別の種類のタブを経てファイルを開けば窓を開く", () => {
    const props = makeProps({
      tabs: [terminalTab(), fileTab()],
      activeTabIndex: 1,
    });
    const container = mount(<MobileSessionView {...props} />);
    const { root } = mountedRoots.at(-1) as { root: Root };
    expect(isTerminalWindowOpen(container)).toBe(false);

    act(() => root.render(<MobileSessionView {...props} activeTabIndex={0} />));
    expect(isTerminalWindowOpen(container)).toBe(false);

    act(() => root.render(<MobileSessionView {...props} activeTabIndex={1} />));
    expect(isTerminalWindowOpen(container)).toBe(true);
    expect(terminalWindowOf(container).textContent).toContain("hello");
  });

  it("図モードで添付を選ぶと、確認ダイアログを持つ端末の窓を開く", async () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "board");
    const container = mount(
      <MobileSessionView
        {...makeProps({
          onUploadFile: async () => ({
            path: "/uploads/a.txt",
            filename: "a.txt",
          }),
        })}
      />
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "a.txt", { type: "text/plain" })],
      configurable: true,
    });

    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(isTerminalWindowOpen(container)).toBe(true);
    });
    expect(terminalWindowOf(container).textContent).toContain("a.txt");
  });

  it("窓を開いても閉じても、フォーカスを動かさない (ソフトキーボードを勝手に出さない)", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    const before = document.activeElement;

    openTerminalWindow();
    expect(document.activeElement).toBe(before);

    click(container.querySelector('button[aria-label="端末を閉じる"]'));
    expect(document.activeElement).toBe(before);
  });
});

describe("MobileSessionView のショートカット", () => {
  function openShortcuts(container: HTMLDivElement): Element | null {
    const bar = container.querySelector('[data-testid="chat-pane"]');
    openDropdown(
      bar?.querySelector('button[aria-label="メッセージのショートカット"]')
    );
    return document.body.querySelector('[role="menu"]');
  }

  it("ショートカットが無ければ、PCと同じ文言を出す", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ messageShortcuts: [] })} />
    );

    expect(openShortcuts(container)?.textContent).toContain(
      "ショートカットがありません"
    );
  });

  it("ショートカットがあれば一覧を出し、無いことの文言は出さない", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({
          messageShortcuts: [
            {
              id: "sc-1",
              message: "続けて",
              sortOrder: 1,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        })}
      />
    );

    const menu = openShortcuts(container);
    expect(menu?.textContent).toContain("続けて");
    expect(menu?.textContent).not.toContain("ショートカットがありません");
  });
});

describe("MobileSessionView の下部バーの1タップ操作", () => {
  const uploadFile = async () => ({
    path: "/uploads/a.png",
    filename: "a.png",
  });

  function barOf(
    container: HTMLDivElement,
    mode: "chat" | "terminal" | "board"
  ) {
    const selector =
      mode === "chat"
        ? '[data-testid="mobile-view-chat"] [data-testid="chat-pane"]'
        : `[data-testid="mobile-${mode === "terminal" ? "terminal" : "board"}-bar"]`;
    const bar = container.querySelector(selector);
    expect(bar).not.toBeNull();
    return bar as ParentNode;
  }

  function labelsOf(scope: ParentNode): string[] {
    return Array.from(scope.querySelectorAll("button"))
      .map(button => button.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);
  }

  /** 1タップの操作の行だけを並び順で取る (同じバーのセグメントや送信ボタンを含めない) */
  function quickLabelsOf(scope: ParentNode): string[] {
    const row = scope.querySelector('[data-testid="mobile-quick-actions"]');
    expect(row).not.toBeNull();
    return labelsOf(row as ParentNode);
  }

  /** 端末の窓の上端のバー (見出しと操作と閉じるボタン) */
  function titleBarOf(container: HTMLDivElement): HTMLElement {
    const bar = terminalWindowOf(container).querySelector("h2")?.parentElement;
    expect(bar).not.toBeNull();
    expect(bar).toBeDefined();
    return bar as HTMLElement;
  }

  it("端末の操作 (コピー・再読み込み) は窓の上端のバーに、閉じるボタンの手前に、指で押せる大きさで並べる", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({
          onUploadFile: uploadFile,
          onCopyBuffer: async () => "buffer",
        })}
      />
    );
    // 閉じている間は、端末用の操作をどこにも出さない
    expect(
      container.querySelector('button[aria-label="端末のバッファをコピー"]')
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="端末を再読み込み"]')
    ).toBeNull();

    openTerminalWindow();

    expect(labelsOf(titleBarOf(container))).toEqual([
      "端末のバッファをコピー",
      "端末を再読み込み",
      "端末を閉じる",
    ]);
    for (const label of ["端末のバッファをコピー", "端末を再読み込み"]) {
      const buttons = container.querySelectorAll(
        `button[aria-label="${label}"]`
      );
      // 下部バーの行には残さない (同じ操作を2か所に置かない)
      expect(buttons).toHaveLength(1);
      // 44px
      expect(buttons[0].className).toContain("size-11");
    }
  });

  it("端末の窓の下部バーの行は、端末へ打ち込むための操作だけを並べる", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({
          onUploadFile: uploadFile,
          onCopyBuffer: async () => "buffer",
        })}
      />
    );
    openTerminalWindow();

    expect(quickLabelsOf(barOf(container, "terminal"))).toEqual([
      "ファイルを添付",
      "画像を貼り付け",
      "メッセージのショートカット",
      "スラッシュコマンド",
    ]);
  });

  it("図モードの添付は端末の窓と同じ流儀だが、端末の操作は出さない", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "board");
    const container = mount(
      <MobileSessionView
        {...makeProps({
          onUploadFile: uploadFile,
          onCopyBuffer: async () => "buffer",
        })}
      />
    );

    expect(quickLabelsOf(barOf(container, "board"))).toEqual([
      "ファイルを添付",
      "画像を貼り付け",
      "メッセージのショートカット",
      "スラッシュコマンド",
    ]);
  });

  it("バッファを取れない環境では、端末の窓でもコピーだけを出さない", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ onUploadFile: uploadFile })} />
    );
    openTerminalWindow();

    expect(labelsOf(titleBarOf(container))).toEqual([
      "端末を再読み込み",
      "端末を閉じる",
    ]);
  });

  it("コピーのボタンは tmux バッファをクリップボードへ書く", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onCopyBuffer = vi.fn(async () => "端末の中身");
    const container = mount(
      <MobileSessionView {...makeProps({ onCopyBuffer })} />
    );
    openTerminalWindow();

    click(
      titleBarOf(container).querySelector(
        'button[aria-label="端末のバッファをコピー"]'
      )
    );

    expect(onCopyBuffer).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("端末の中身");
    });
  });

  it("再読み込みのボタンは ttyd の iframe を貼り直す", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    openTerminalWindow();
    const before = container.querySelector("iframe");
    expect(before).not.toBeNull();

    click(
      titleBarOf(container).querySelector(
        'button[aria-label="端末を再読み込み"]'
      )
    );

    // key が変わって作り直される = ttyd へ繋ぎ直す (要素の同一性で確認する)
    expect(container.querySelector("iframe")).not.toBe(before);
  });

  it("会話モードは添付を出さない (会話の入力欄が自前のボタンを持つため)。画像・ショートカット・スラッシュコマンドは出す", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ onUploadFile: uploadFile })} />
    );

    const labels = labelsOf(barOf(container, "chat"));
    expect(labels).not.toContain("ファイルを添付");
    expect(labels).toContain("画像を貼り付け");
    expect(labels).toContain("メッセージのショートカット");
    expect(labels).toContain("スラッシュコマンド");
  });

  it("アップロードできない環境では、ファイルの操作を出さない", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    openTerminalWindow();
    const labels = labelsOf(barOf(container, "terminal"));

    expect(labels).not.toContain("ファイルを添付");
    expect(labels).not.toContain("画像を貼り付け");
    expect(labels).toContain("メッセージのショートカット");
    expect(labels).toContain("スラッシュコマンド");
  });

  it("会話モードの画像は、会話の入力欄の流儀 (@path) で処理する。添付は行に出さない (会話の入力欄が自前のボタンを持つため)", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ onUploadFile: uploadFile })} />
    );
    const bar = barOf(container, "chat");

    expect(bar.querySelector('button[aria-label="ファイルを添付"]')).toBeNull();

    click(bar.querySelector('button[aria-label="画像を貼り付け"]'));
    expect(testDoubles.chatPasteImage).toHaveBeenCalledTimes(1);
  });

  it("端末の窓の添付は、端末側の確認ダイアログへ渡すファイル選択を開く", () => {
    const container = mount(
      <MobileSessionView {...makeProps({ onUploadFile: uploadFile })} />
    );
    openTerminalWindow();
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const inputClick = vi.spyOn(input as HTMLInputElement, "click");

    click(
      barOf(container, "terminal").querySelector(
        'button[aria-label="ファイルを添付"]'
      )
    );

    expect(inputClick).toHaveBeenCalledTimes(1);
    expect(testDoubles.chatOpenFilePicker).not.toHaveBeenCalled();
  });

  it("図モードの添付も、端末の窓と同じファイル選択 (端末側の確認ダイアログの流儀) を開く", () => {
    localStorage.setItem(STORAGE_KEY_MOBILE_VIEW, "board");
    const container = mount(
      <MobileSessionView {...makeProps({ onUploadFile: uploadFile })} />
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const inputClick = vi.spyOn(input as HTMLInputElement, "click");

    click(
      barOf(container, "board").querySelector(
        'button[aria-label="ファイルを添付"]'
      )
    );

    expect(inputClick).toHaveBeenCalledTimes(1);
    expect(testDoubles.chatOpenFilePicker).not.toHaveBeenCalled();
  });

  it("端末の窓の画像の貼り付けは、クリップボードに画像が無いとトーストで知らせる", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: vi.fn(async () => [{ types: ["text/plain"], getType: vi.fn() }]),
      },
      configurable: true,
    });
    const container = mount(
      <MobileSessionView {...makeProps({ onUploadFile: uploadFile })} />
    );
    openTerminalWindow();

    click(
      barOf(container, "terminal").querySelector(
        'button[aria-label="画像を貼り付け"]'
      )
    );

    await vi.waitFor(() => {
      expect(toastDoubles.info).toHaveBeenCalledWith(
        "クリップボードに画像がありません"
      );
    });
  });

  it("端末の窓の画像の貼り付けは、クリップボード読み取りに失敗するとトーストで知らせる", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        read: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
      configurable: true,
    });
    const container = mount(
      <MobileSessionView {...makeProps({ onUploadFile: uploadFile })} />
    );
    openTerminalWindow();

    click(
      barOf(container, "terminal").querySelector(
        'button[aria-label="画像を貼り付け"]'
      )
    );

    await vi.waitFor(() => {
      expect(toastDoubles.error).toHaveBeenCalledWith(
        "クリップボードを読み取れませんでした"
      );
    });
  });

  it("ショートカットとスラッシュコマンドは1タップで一覧を出し、選ぶと送る", () => {
    const onSendMessage = vi.fn();
    const container = mount(
      <MobileSessionView
        {...makeProps({
          onSendMessage,
          messageShortcuts: [
            {
              id: "sc-1",
              message: "続けて",
              sortOrder: 1,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        })}
      />
    );
    const bar = barOf(container, "chat");

    openDropdown(
      bar.querySelector('button[aria-label="メッセージのショートカット"]')
    );
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain(
      "続けて"
    );
    click(
      Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
      ).find(el => el.textContent === "続けて")
    );
    expect(onSendMessage).toHaveBeenCalledWith("続けて");

    openDropdown(bar.querySelector('button[aria-label="スラッシュコマンド"]'));
    const clear = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find(el => el.textContent === "/clear");
    click(clear);
    expect(onSendMessage).toHaveBeenCalledWith("/clear");
  });

  it("`…` からは端末に関する操作をすべて外し、セッション全体の操作だけを残す", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({
          onUploadFile: uploadFile,
          onCopyBuffer: async () => "buffer",
          onRestartSession: vi.fn(),
          messageShortcuts: [
            {
              id: "sc-1",
              message: "続けて",
              sortOrder: 1,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        })}
      />
    );

    openDropdown(
      container
        .querySelector("header")
        ?.querySelector('button[aria-label="その他の操作"]')
    );

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).not.toContain("メッセージショートカット");
    expect(menu?.textContent).not.toContain("続けて");
    expect(menu?.textContent).not.toContain("ファイルを添付");
    expect(menu?.textContent).not.toContain("画像を貼り付け");
    expect(menu?.textContent).not.toContain("/clear");
    expect(menu?.textContent).not.toContain("端末のバッファをコピー");
    expect(menu?.textContent).not.toContain("端末を再読み込み");
    expect(menu?.textContent).toContain("セッションを再起動");
    expect(menu?.textContent).toContain("セッションを削除");
  });

  it("出す項目が削除だけのときは、`…` の先頭に区切り線を残さない", () => {
    // 通知APIの無い環境 (iOS Safari 等) で、かつ再起動を出せないセッション
    const container = mount(<MobileSessionView {...makeProps()} />);

    openDropdown(
      container
        .querySelector("header")
        ?.querySelector('button[aria-label="その他の操作"]')
    );

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("セッションを削除");
    expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(0);
  });

  it("再起動を出せない環境では、`…` の区切り線が2本並ばない", () => {
    const container = mount(
      <MobileSessionView
        {...makeProps({
          notificationsSupported: true,
          onNotificationsEnabledChange: vi.fn(),
        })}
      />
    );

    openDropdown(
      container
        .querySelector("header")
        ?.querySelector('button[aria-label="その他の操作"]')
    );

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });
});

describe("MobileSessionView の音声モード", () => {
  it("音声が使えるブラウザでは、会話モードの1タップ操作に音声モードを出し、押すと入る", () => {
    voiceDoubles.supported = true;
    const container = mount(<MobileSessionView {...makeProps()} />);
    const voiceButton = container.querySelector(
      'button[aria-label="音声モード"]'
    );
    click(voiceButton);
    expect(voiceDoubles.enter).toHaveBeenCalledTimes(1);
  });

  it("音声が使えないブラウザでは音声モードを出さない", () => {
    const container = mount(<MobileSessionView {...makeProps()} />);
    expect(
      container.querySelector('button[aria-label="音声モード"]')
    ).toBeNull();
  });

  it("会話ビューのイベント列を音声モードへ渡す", () => {
    mount(<MobileSessionView {...makeProps()} />);
    expect(latestChatProps().onEventsChange).toBe(voiceDoubles.pushEvents);
  });
});

describe("MobileSessionView の画面末尾の更新と再描画", () => {
  it("liveTail だけが変わっても、端末の窓の中身は描画し直さない (親が毎回新しい関数を渡しても)", () => {
    const base = makeProps({
      onUploadFile: async () => ({ path: "/uploads/a.txt", filename: "a.txt" }),
      onCopyBuffer: async () => "buffer",
      liveTail: "$ pnpm test",
    });
    // MobileLayout と同じく、描画のたびに新しい関数を渡す
    const element = (liveTail: string) => (
      <MobileSessionView
        {...base}
        liveTail={liveTail}
        onSendMessage={() => undefined}
        onSendKey={() => undefined}
        onTabSelect={() => undefined}
        onTabClose={() => undefined}
        onDeleteSession={() => undefined}
        onUploadFile={async () => ({
          path: "/uploads/a.txt",
          filename: "a.txt",
        })}
        onCopyBuffer={async () => "buffer"}
      />
    );
    const container = mount(element("$ pnpm test"));
    const { root } = mountedRoots.at(-1) as { root: Root };
    openTerminalWindow();
    const tabBarRenders = testDoubles.viewerTabBarRender.mock.calls.length;
    expect(tabBarRenders).toBeGreaterThan(0);

    act(() => root.render(element("$ pnpm test\nPASS")));

    // 画面末尾は会話 (帯) まで届いている
    expect(latestChatProps().liveTail).toBe("$ pnpm test\nPASS");
    expect(testDoubles.viewerTabBarRender.mock.calls.length).toBe(
      tabBarRenders
    );
    expect(isTerminalWindowOpen(container)).toBe(true);
  });

  it("関数を差し替えられても、端末の窓の中身は最新の関数を呼ぶ", () => {
    const first = vi.fn();
    const second = vi.fn();
    const props = makeProps({ onSendKey: first });
    const container = mount(<MobileSessionView {...props} />);
    const { root } = mountedRoots.at(-1) as { root: Root };
    act(() => root.render(<MobileSessionView {...props} onSendKey={second} />));
    openTerminalWindow();

    const esc = Array.from(
      terminalWindowOf(container).querySelectorAll("button")
    ).find(button => button.textContent === "Esc");
    click(esc);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("Escape");
  });
});
