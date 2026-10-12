// @vitest-environment jsdom

import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitViewPane } from "./SplitViewPane";

interface ObservedChatProps {
  session: ManagedSession;
  isActive: boolean;
  bridgeStatus?: BridgeSessionStatus;
  awaitingText?: string;
  liveTail?: string;
  onOpenTerminal?: () => void;
}

/** SplitViewPane が読みも書きもしない保存キー (値が残っていても無視する) */
const LEGACY_LEFT_MODE_KEY = "ark-split-left-mode";

const testDoubles = vi.hoisted(() => ({
  splitChatPane: vi.fn(),
}));

vi.mock("./SplitChatPane", () => ({
  SplitChatPane: (props: ObservedChatProps) => {
    testDoubles.splitChatPane(props);
    // 帯 (端末を開くボタン) と入力欄だけを持つ代役
    return (
      <div data-testid={`chat-${props.session.id}`}>
        <button
          type="button"
          aria-label="端末を開く"
          onClick={props.onOpenTerminal}
        />
        <textarea data-keynav="chat-input" aria-label="メッセージ" />
      </div>
    );
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

const floatingOf = (scope: ParentNode) =>
  scope.querySelector<HTMLElement>('[data-testid="floating-terminal"]');
/** 開いている端末の窓 (閉じている間は null) */
const dialogOf = (scope: ParentNode) =>
  scope.querySelector<HTMLElement>('[role="dialog"][aria-label="端末"]');
const terminalIframe = (scope: ParentNode) =>
  scope.querySelector<HTMLIFrameElement>('iframe[data-keynav="terminal"]');
const isTerminalHidden = (scope: ParentNode) =>
  terminalIframe(scope)?.closest(".hidden") != null;

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
  // navigator.clipboard は Object.defineProperty で差し替えているので、
  // vi.restoreAllMocks() では戻らない。明示的に外して他のテストへ漏れないようにする
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("PC 会話と端末の窓", () => {
  it("SplitViewPane から会話ビューへ bridgeStatus / awaitingText / liveTail と、端末を開く口を渡す", () => {
    const session = makeSession("wiring");

    mount(
      paneSection(session, true, {
        bridgeStatus: "AWAITING",
        awaitingText: "レビューを続けますか？",
        liveTail: "❯ pnpm test",
      })
    );

    expect(latestChatProps(session.id)).toMatchObject({
      isActive: true,
      bridgeStatus: "AWAITING",
      awaitingText: "レビューを続けますか？",
      liveTail: "❯ pnpm test",
    });
    expect(latestChatProps(session.id).onOpenTerminal).toBeTypeOf("function");
  });

  it("上部バーに端末 / 会話の切り替えは無く、保存済みの「端末」の選択は無視して会話を出す", () => {
    localStorage.setItem(LEGACY_LEFT_MODE_KEY, "terminal");
    const container = mount(paneSection(makeSession("legacy"), true));
    const left = container.querySelector('[data-testid="split-view-left"]');

    expect(container.querySelector("fieldset")).toBeNull();
    expect(left?.querySelector('button[aria-label="端末"]')).toBeNull();
    expect(left?.querySelector('button[aria-label="会話"]')).toBeNull();
    // 左ペインは会話だけ。端末は隠したままマウントしておく
    expect(
      left?.querySelector('[data-testid="chat-legacy"]')?.closest(".hidden")
    ).toBeNull();
    expect(left?.querySelector("iframe")).toBeNull();
    expect(terminalIframe(container)).not.toBeNull();
    expect(isTerminalHidden(container)).toBe(true);
    expect(dialogOf(container)).toBeNull();
    // 古い値は読まず、書き換えもしない
    expect(localStorage.getItem(LEGACY_LEFT_MODE_KEY)).toBe("terminal");
  });

  it("帯から端末の窓を開き、閉じるボタンで閉じる。端末のiframeは同じ要素のまま", () => {
    const sessions = [makeSession("a"), makeSession("b")];
    const container = mount(renderSessions("a", sessions));
    const paneA = container.querySelector('[data-testid="pane-a"]') as Element;
    const paneB = container.querySelector('[data-testid="pane-b"]') as Element;
    const iframeBeforeA = terminalIframe(paneA);
    const iframeBeforeB = terminalIframe(paneB);
    expect(iframeBeforeA).not.toBeNull();
    expect(iframeBeforeB).not.toBeNull();
    const parentBeforeA = iframeBeforeA?.parentElement;

    clickButton(paneA, "端末を開く");

    expect(dialogOf(paneA)).not.toBeNull();
    expect(isTerminalHidden(paneA)).toBe(false);
    // 会話は窓の後ろに出したまま
    expect(
      paneA.querySelector('[data-testid="chat-a"]')?.closest(".hidden")
    ).toBeNull();
    // 窓は左ペインの中ではなく、セッションの画面全体に重ねる
    expect(
      paneA
        .querySelector('[data-testid="split-view-left"]')
        ?.contains(dialogOf(paneA))
    ).toBe(false);
    expect(
      paneA
        .querySelector('[data-testid="split-view-body"]')
        ?.contains(dialogOf(paneA))
    ).toBe(false);
    // 開閉はセッションごと。別のセッションの窓は開かない
    expect(dialogOf(paneB)).toBeNull();
    expect(isTerminalHidden(paneB)).toBe(true);

    clickButton(dialogOf(paneA) as ParentNode, "端末を閉じる");

    expect(dialogOf(paneA)).toBeNull();
    expect(isTerminalHidden(paneA)).toBe(true);
    // 同じiframe要素が同じ親の下に残っている
    // (作り直されていない = ttydが再接続していない証拠。要素の同一性で確認する)
    expect(terminalIframe(paneA)).toBe(iframeBeforeA);
    expect(terminalIframe(paneA)?.parentElement).toBe(parentBeforeA);
    expect(terminalIframe(paneB)).toBe(iframeBeforeB);
    // 開閉の状態は保存しない
    expect(localStorage.length).toBe(0);
  });

  it("窓の外 (暗くした部分) を押すと閉じる", () => {
    const container = mount(paneSection(makeSession("backdrop"), true));
    clickButton(container, "端末を開く");
    expect(dialogOf(container)).not.toBeNull();

    act(() => {
      floatingOf(container)?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true })
      );
    });

    expect(dialogOf(container)).toBeNull();
    expect(isTerminalHidden(container)).toBe(true);
  });

  it("このセッションが選ばれなくなったら閉じ、選び直しても閉じたまま", () => {
    const session = makeSession("deselect");
    const container = mount(paneSection(session, true));
    const root = mountedRoots.at(-1)?.root;
    const iframe = terminalIframe(container);
    clickButton(container, "端末を開く");
    expect(dialogOf(container)).not.toBeNull();

    act(() => root?.render(paneSection(session, false)));
    expect(dialogOf(container)).toBeNull();
    expect(isTerminalHidden(container)).toBe(true);

    act(() => root?.render(paneSection(session, true)));
    expect(dialogOf(container)).toBeNull();
    expect(isTerminalHidden(container)).toBe(true);
    expect(terminalIframe(container)).toBe(iframe);
  });

  it("開いたら端末へ、閉じたら会話の入力欄へフォーカスを移す", () => {
    const container = mount(paneSection(makeSession("focus"), true));

    clickButton(container, "端末を開く");
    expect(document.activeElement).toBe(terminalIframe(container));

    clickButton(dialogOf(container) as ParentNode, "端末を閉じる");
    expect(document.activeElement).toBe(
      container.querySelector('textarea[data-keynav="chat-input"]')
    );
  });

  it("選択が外れて閉じたときは、フォーカスを動かさない", () => {
    const session = makeSession("focus-deselect");
    const container = mount(paneSection(session, true));
    const root = mountedRoots.at(-1)?.root;
    clickButton(container, "端末を開く");
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();

    act(() => root?.render(paneSection(session, false)));

    expect(dialogOf(container)).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("会話は選択中のセッションだけが購読し、端末のD&Dは窓を開いた選択中の1枚だけが受ける", async () => {
    const sessions = [makeSession("a"), makeSession("b")];
    const container = mount(renderSessions("a", sessions));
    const root = mountedRoots.at(-1)?.root;
    expect(root).toBeDefined();
    const paneA = container.querySelector('[data-testid="pane-a"]') as Element;
    const paneB = container.querySelector('[data-testid="pane-b"]') as Element;

    expect(latestChatProps("a").isActive).toBe(true);
    expect(latestChatProps("b").isActive).toBe(false);

    // 窓を開いても、後ろの会話は購読を続ける
    clickButton(paneA, "端末を開く");
    expect(latestChatProps("a").isActive).toBe(true);
    expect(latestChatProps("b").isActive).toBe(false);

    act(() => dispatchFileDrop("active-a.txt"));
    await waitForTerminalUploadPreview(paneA);
    expect(hasTerminalUploadPreview(paneA)).toBe(true);
    expect(hasTerminalUploadPreview(paneB)).toBe(false);

    act(() => root?.render(renderSessions("b", sessions)));
    expect(latestChatProps("a").isActive).toBe(false);
    expect(latestChatProps("b").isActive).toBe(true);
  });

  it("窓を閉じている間の TerminalPane は window drop を処理しない", async () => {
    const session = makeSession("hidden-terminal");
    const container = mount(paneSection(session, true));
    const readSpy = vi.spyOn(FileReader.prototype, "readAsDataURL");

    act(() => dispatchFileDrop("must-not-be-read.txt"));

    expect(readSpy).not.toHaveBeenCalled();
    expect(hasTerminalUploadPreview(container)).toBe(false);

    // 陽性対照: 同じペインで窓を開けば、同じ window drop が処理される。
    clickButton(container, "端末を開く");
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

  it("パネルの開閉・その他の操作を上部バーに置き、端末 / 会話の切り替えは置かない", () => {
    // パネルを開くとSplitViewPaneが幅の追従にResizeObserverを使う (jsdomに無い)
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
    expect(scope.querySelector('button[aria-label="端末"]')).toBeNull();
    expect(scope.querySelector('button[aria-label="会話"]')).toBeNull();
    expect(
      scope.querySelector('button[aria-label="その他の操作"]')
    ).not.toBeNull();
    expect(
      scope
        .querySelector('button[aria-label="パネル"]')
        ?.getAttribute("aria-pressed")
    ).toBe("false");
    // 図とファイルの開閉は 1 つにまとめた (上部バーに個別のトグルは置かない)
    expect(scope.querySelector('button[aria-label="図"]')).toBeNull();
    expect(scope.querySelector('button[aria-label="ファイル"]')).toBeNull();

    clickButton(scope, "パネル");

    expect(
      scope
        .querySelector('button[aria-label="パネル"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="diagram-pane"]')
    ).not.toBeNull();
  });
});

describe("PC上部バーの狭い幅の畳み方", () => {
  // jsdom はコンテナクエリを解決しないので、ここで見るのは
  // 「どこに何のclassを付けたか」と「読み上げから消えていないこと」。
  // 実際に畳まれる幅はブラウザでの実測で決める
  it("狭いときアイコンだけにする文言は、読み上げには残す", () => {
    const container = mount(
      paneSection(makeSession("narrow"), true, {
        displayName: "ログイン画面",
        worktree: makeWorktree("feature/login"),
        bridgeStatus: "AWAITING",
      })
    );
    const header = container.querySelector("header") as HTMLElement;

    for (const label of ["feature/login", "確認待ち", "パネル"]) {
      // 文言そのものを持つ一番内側の span を見る
      // (状態チップは外側の span も同じ textContent を持つ)
      const span = Array.from(header.querySelectorAll("span")).find(
        el => el.textContent === label && el.childElementCount === 0
      );
      expect(span?.className).toContain("@max-2xl:sr-only");
    }
    // sr-only は視覚的に隠すだけなので、文言そのものは残る
    expect(header.textContent).toContain("feature/login");
    expect(header.textContent).toContain("確認待ち");
  });

  it("パネルのボタンは文言を隠しても aria-label と title を保つ", () => {
    const container = mount(paneSection(makeSession("narrow-board"), true));
    const button = container
      .querySelector("header")
      ?.querySelector('button[aria-label="パネル"]');

    expect(button?.getAttribute("title")).toBe("パネルを開く");
  });

  it("左のまとまりは、縮みきったぶんを箱の中で抱える (上部バーを横に溢れさせない)", () => {
    const container = mount(paneSection(makeSession("narrow-left"), true));
    const left = container
      .querySelector("header")
      ?.querySelector("div.min-w-0");

    expect(left?.className).toContain("overflow-hidden");
    expect(left?.className).toContain("min-w-0");
  });
});

describe("PC上部バーの1タップ操作と、端末の窓の操作", () => {
  /** 端末の窓の上端に並ぶ3つ。入力バーはPCの初期状態 (非表示) の文言で引く */
  const TERMINAL_LABELS = [
    "端末のバッファをコピー",
    "端末を再読み込み",
    "入力バーを表示",
  ];

  /** 窓を開いて、その中 (ダイアログ) を返す */
  function openTerminal(container: ParentNode): HTMLElement {
    clickButton(container, "端末を開く");
    const dialog = dialogOf(container);
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  }

  it("上部バーの1タップ操作はショートカットだけで、パネルの手前に置く", () => {
    const container = mount(
      paneSection(makeSession("quick-header"), true, {
        onCopyBuffer: vi.fn(async () => "buffer"),
      })
    );
    const scope = container.querySelector("header") as ParentNode;

    const labels = headerButtonLabels(scope);
    expect(labels).toEqual([
      "メッセージのショートカット",
      "パネル",
      "その他の操作",
    ]);
  });

  it("端末の操作 (コピー・再読み込み・入力バー) は窓の上端に、閉じるボタンの手前に並べる", () => {
    const container = mount(
      paneSection(makeSession("quick-terminal"), true, {
        onCopyBuffer: vi.fn(async () => "buffer"),
      })
    );
    const dialog = openTerminal(container);
    const bar = dialog.querySelector("h2")?.parentElement as ParentNode;

    // 並び順も固定する (端末の操作が先、閉じるボタンが最後)
    expect(headerButtonLabels(bar)).toEqual([
      ...TERMINAL_LABELS,
      "端末を閉じる",
    ]);
  });

  it("添付と画像の貼り付けは、上部バーにも窓の上端にも置かない (会話の入力欄が担う)", () => {
    const container = mount(
      paneSection(makeSession("quick-no-attach"), true, {
        onCopyBuffer: vi.fn(async () => "buffer"),
      })
    );
    const dialog = openTerminal(container);
    const bar = dialog.querySelector("h2")?.parentElement as ParentNode;

    for (const scope of [
      container.querySelector("header") as ParentNode,
      bar,
    ]) {
      const labels = headerButtonLabels(scope);
      expect(labels).not.toContain("ファイルを添付");
      expect(labels).not.toContain("画像を貼り付け");
    }
  });

  it("バッファを取れない環境では、コピーだけを出さない", () => {
    const container = mount(paneSection(makeSession("quick-no-copy"), true));
    const dialog = openTerminal(container);

    const labels = headerButtonLabels(dialog);
    expect(labels).not.toContain("端末のバッファをコピー");
    expect(labels).toContain("端末を再読み込み");
    expect(labels).toContain("入力バーを表示");
  });

  it("コピーのボタンは tmux バッファをクリップボードへ書く", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onCopyBuffer = vi.fn(async () => "端末の中身");
    const container = mount(
      paneSection(makeSession("quick-copy"), true, { onCopyBuffer })
    );

    clickButton(openTerminal(container), "端末のバッファをコピー");

    expect(onCopyBuffer).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("端末の中身");
    });
  });

  it("再読み込みのボタンは ttyd の iframe を貼り直す", () => {
    const container = mount(paneSection(makeSession("quick-reload"), true));
    const dialog = openTerminal(container);
    const before = terminalIframe(container);
    expect(before).not.toBeNull();

    clickButton(dialog, "端末を再読み込み");

    // key が変わって作り直される = ttyd へ繋ぎ直す (要素の同一性で確認する)
    expect(terminalIframe(container)).not.toBeNull();
    expect(terminalIframe(container)).not.toBe(before);
  });

  it("入力バーのボタンは押すたびに文言と aria-pressed が入れ替わる", () => {
    const container = mount(paneSection(makeSession("quick-input-bar"), true));
    const scope = openTerminal(container);
    // PCの入力バーは既定で隠れている (TerminalPane)
    expect(
      scope
        .querySelector('button[aria-label="入力バーを表示"]')
        ?.getAttribute("aria-pressed")
    ).toBe("false");

    clickButton(scope, "入力バーを表示");

    expect(
      scope.querySelector('button[aria-label="入力バーを表示"]')
    ).toBeNull();
    expect(
      scope
        .querySelector('button[aria-label="入力バーを隠す"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("ショートカットのボタンは1タップで一覧を出す", () => {
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

  it("`…` には端末の操作を残さず、セッション全体の操作だけを置く", () => {
    const container = mount(
      paneSection(makeSession("quick-rest"), true, {
        onCopyBuffer: vi.fn(async () => "buffer"),
        notificationsSupported: true,
        onNotificationsEnabledChange: vi.fn(),
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
    expect(menu?.textContent).not.toContain("端末のバッファをコピー");
    expect(menu?.textContent).not.toContain("端末を再読み込み");
    expect(menu?.textContent).not.toContain("入力バー");
    expect(menu?.textContent).toContain("このセッションの通知をオフにする");
    expect(menu?.textContent).toContain("セッションを削除");
  });
});

describe("PC 右の作業エリア (図 / ファイル)", () => {
  const filePane = (visible: boolean) => (
    <div data-testid="file-pane" data-visible={String(visible)} />
  );
  const peek = (visible: boolean) => (
    <div data-testid="peek" data-visible={String(visible)} />
  );
  const filePaneEl = (scope: ParentNode) =>
    scope.querySelector<HTMLElement>('[data-testid="file-pane"]');
  const diagramEl = (scope: ParentNode) =>
    scope.querySelector<HTMLElement>('[data-testid="diagram-pane"]');
  const peekEl = (scope: ParentNode) =>
    scope.querySelector<HTMLElement>('[data-testid="peek"]');
  /** 見せていない中身は外さず、hidden の付いた祖先の下に残す */
  const isHidden = (el: Element | null) => el?.closest(".hidden") != null;
  const header = (scope: ParentNode) =>
    scope.querySelector("header") as HTMLElement;
  const toggle = (scope: ParentNode) =>
    header(scope).querySelector('button[aria-label="パネル"]');
  const tab = (scope: ParentNode, label: string) => {
    const found = Array.from(
      scope.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find(el => el.textContent === label);
    expect(found).toBeDefined();
    return found as HTMLButtonElement;
  };
  const clickTab = (scope: ParentNode, label: string) =>
    act(() =>
      tab(scope, label).dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    );
  const selectedTab = (scope: ParentNode) =>
    scope.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
  const resizers = (scope: ParentNode) =>
    scope.querySelectorAll<HTMLElement>('button[aria-label="左右の幅を調整"]');
  /** 作業エリアの箱 (リサイザの次の要素) */
  const leftPane = (scope: ParentNode) =>
    scope.querySelector('[data-testid="split-view-left"]') as HTMLElement;
  const workArea = (scope: ParentNode) =>
    resizers(scope)[0]?.nextElementSibling as HTMLElement;
  const stubContainerRect = (scope: ParentNode, width: number) => {
    const body = scope.querySelector(
      '[data-testid="split-view-body"]'
    ) as HTMLElement;
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: width,
      width,
      top: 0,
      bottom: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  };
  const withDiagram = (id: string, restoredOnLoad?: boolean) => ({
    tabs: [
      { type: "terminal" as const, id: "terminal" },
      {
        type: "diagram" as const,
        id,
        worktreePath: "/worktrees/x",
        relPath: "a.diagram.html",
        restoredOnLoad,
      },
    ],
  });

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
  });

  it("「パネル」のトグル 1 つで開閉し、開閉を localStorage に残す", () => {
    const container = mount(
      paneSection(makeSession("wa-toggle"), true, { filePane })
    );
    expect(toggle(container)?.getAttribute("title")).toBe("パネルを開く");
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(diagramEl(container)).toBeNull();

    clickButton(header(container), "パネル");
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle(container)?.getAttribute("title")).toBe("パネルを閉じる");
    expect(localStorage.getItem("ark-split-show-board")).toBe("1");
    // 既定のタブは図
    expect(selectedTab(container)).toBe("図");
    expect(diagramEl(container)).not.toBeNull();
    expect(isHidden(diagramEl(container))).toBe(false);
    expect(resizers(container).length).toBe(1);

    clickButton(header(container), "パネル");
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("ark-split-show-board")).toBe("0");
    // 図は従来どおり、閉じたら外す
    expect(diagramEl(container)).toBeNull();
  });

  it("タブ列の × で閉じる", () => {
    localStorage.setItem("ark-split-show-board", "1");
    const container = mount(
      paneSection(makeSession("wa-close"), true, { filePane })
    );
    expect(diagramEl(container)).not.toBeNull();

    clickButton(workArea(container), "パネルを閉じる");
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("ark-split-show-board")).toBe("0");
    expect(diagramEl(container)).toBeNull();
  });

  it("タブで図 / ファイルを替え、選んだタブを localStorage に残す", () => {
    localStorage.setItem("ark-split-show-board", "1");
    const container = mount(
      paneSection(makeSession("wa-tabs"), true, { filePane })
    );
    expect(filePaneEl(container)).toBeNull();
    const diagram = diagramEl(container);

    clickTab(container, "ファイル");
    expect(selectedTab(container)).toBe("ファイル");
    expect(localStorage.getItem("ark-split-right-tab")).toBe("files");
    expect(filePaneEl(container)?.dataset.visible).toBe("true");
    expect(isHidden(filePaneEl(container))).toBe(false);
    // 図は外さずに隠す (iframe を作り直さない)
    expect(diagramEl(container)).toBe(diagram);
    expect(isHidden(diagramEl(container))).toBe(true);

    clickTab(container, "図");
    expect(localStorage.getItem("ark-split-right-tab")).toBe("board");
    expect(diagramEl(container)).toBe(diagram);
    expect(isHidden(diagramEl(container))).toBe(false);
    expect(isHidden(filePaneEl(container))).toBe(true);
    expect(filePaneEl(container)?.dataset.visible).toBe("false");
  });

  it("タブは選択中だけ Tab キーで入れ、←/→ で隣へ移る", () => {
    localStorage.setItem("ark-split-show-board", "1");
    const container = mount(
      paneSection(makeSession("wa-keys"), true, { filePane })
    );
    expect(tab(container, "図").tabIndex).toBe(0);
    expect(tab(container, "ファイル").tabIndex).toBe(-1);
    const press = (label: string, key: string) =>
      act(() =>
        tab(container, label).dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true })
        )
      );

    press("図", "ArrowRight");
    expect(selectedTab(container)).toBe("ファイル");
    expect(document.activeElement).toBe(tab(container, "ファイル"));
    expect(tab(container, "ファイル").tabIndex).toBe(0);
    expect(tab(container, "図").tabIndex).toBe(-1);

    press("ファイル", "ArrowLeft");
    expect(selectedTab(container)).toBe("図");
    expect(document.activeElement).toBe(tab(container, "図"));
  });

  it("保存済みの開閉とタブで開く", () => {
    localStorage.setItem("ark-split-show-board", "1");
    localStorage.setItem("ark-split-right-tab", "files");
    const container = mount(
      paneSection(makeSession("wa-saved"), true, { filePane })
    );
    expect(selectedTab(container)).toBe("ファイル");
    expect(filePaneEl(container)?.dataset.visible).toBe("true");
    // 図は「図」のタブを見せるまでマウントしない
    expect(diagramEl(container)).toBeNull();
  });

  it("filePane が無ければ「ファイル」のタブを出さず、保存値が files でも図を見せる", () => {
    localStorage.setItem("ark-split-show-board", "1");
    localStorage.setItem("ark-split-right-tab", "files");
    const container = mount(paneSection(makeSession("wa-none"), true));
    expect(
      Array.from(container.querySelectorAll('[role="tab"]')).map(
        el => el.textContent
      )
    ).toEqual(["図"]);
    expect(isHidden(diagramEl(container))).toBe(false);
  });

  it("ファイルは初めて見せるまでマウントせず、見せたあとは閉じても外さない", () => {
    const container = mount(
      paneSection(makeSession("wa-keep"), true, { filePane })
    );
    clickButton(header(container), "パネル");
    // 開いただけ (図のタブ) ではマウントしない
    expect(filePaneEl(container)).toBeNull();

    clickTab(container, "ファイル");
    const opened = filePaneEl(container);
    expect(opened).not.toBeNull();

    // 閉じても同じ要素が残る (未保存の編集を持つエディタを外さない)。リサイザも隠す
    clickButton(header(container), "パネル");
    expect(filePaneEl(container)).toBe(opened);
    expect(isHidden(filePaneEl(container))).toBe(true);
    expect(filePaneEl(container)?.dataset.visible).toBe("false");
    expect(resizers(container).length).toBe(1);
    expect(resizers(container)[0].className).toContain("hidden");

    clickButton(header(container), "パネル");
    expect(filePaneEl(container)).toBe(opened);
    expect(isHidden(filePaneEl(container))).toBe(false);
    expect(filePaneEl(container)?.dataset.visible).toBe("true");
    expect(resizers(container)[0].className).not.toContain("hidden");
  });

  it("選択中でないセッションでは、ファイルのタブでも見せるまでマウントしない", () => {
    localStorage.setItem("ark-split-show-board", "1");
    localStorage.setItem("ark-split-right-tab", "files");
    const session = makeSession("wa-inactive");
    const container = mount(paneSection(session, false, { filePane }));
    const root = mountedRoots.at(-1)?.root;
    expect(filePaneEl(container)).toBeNull();

    act(() => root?.render(paneSection(session, true, { filePane })));
    expect(filePaneEl(container)?.dataset.visible).toBe("true");

    // 選択が外れてもマウントは保ち、見えていないことだけ伝える
    act(() => root?.render(paneSection(session, false, { filePane })));
    expect(filePaneEl(container)?.dataset.visible).toBe("false");
  });

  it("fileOpenSeq は初回の値では開かず、増えたら開いて「ファイル」へ替える", () => {
    const session = makeSession("wa-seq");
    const container = mount(
      paneSection(session, true, { filePane, fileOpenSeq: 3 })
    );
    const root = mountedRoots.at(-1)?.root;
    expect(filePaneEl(container)).toBeNull();
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("false");

    act(() =>
      root?.render(paneSection(session, true, { filePane, fileOpenSeq: 4 }))
    );
    expect(selectedTab(container)).toBe("ファイル");
    expect(isHidden(filePaneEl(container))).toBe(false);
    expect(filePaneEl(container)?.dataset.visible).toBe("true");
    expect(localStorage.getItem("ark-split-show-board")).toBe("1");
    expect(localStorage.getItem("ark-split-right-tab")).toBe("files");

    // 図へ替えて閉じたあと、同じ値の再描画では開き直さない
    clickTab(container, "図");
    clickButton(header(container), "パネル");
    act(() =>
      root?.render(paneSection(session, true, { filePane, fileOpenSeq: 4 }))
    );
    expect(isHidden(filePaneEl(container))).toBe(true);
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("false");

    // 閉じて残している間に増えたら、同じ要素のまま開いて「ファイル」へ戻す
    act(() =>
      root?.render(paneSection(session, true, { filePane, fileOpenSeq: 5 }))
    );
    expect(selectedTab(container)).toBe("ファイル");
    expect(isHidden(filePaneEl(container))).toBe(false);
    expect(filePaneEl(container)?.dataset.visible).toBe("true");
  });

  it("図の activation id が変わったら開いて「図」へ替える。復元 (restoredOnLoad) では開かない", () => {
    localStorage.setItem("ark-split-right-tab", "files");
    const session = makeSession("wa-diagram");
    const container = mount(paneSection(session, true, { filePane }));
    const root = mountedRoots.at(-1)?.root;

    act(() =>
      root?.render(
        paneSection(session, true, {
          filePane,
          ...withDiagram("diagram-restored", true),
        })
      )
    );
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("false");
    expect(diagramEl(container)).toBeNull();

    act(() =>
      root?.render(
        paneSection(session, true, { filePane, ...withDiagram("diagram-1") })
      )
    );
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(selectedTab(container)).toBe("図");
    expect(isHidden(diagramEl(container))).toBe(false);

    // 「ファイル」を見ている間に同じ図を開き直しても (id が変わる)、図へ戻す
    clickTab(container, "ファイル");
    act(() =>
      root?.render(
        paneSection(session, true, { filePane, ...withDiagram("diagram-2") })
      )
    );
    expect(selectedTab(container)).toBe("図");
    expect(isHidden(diagramEl(container))).toBe(false);
  });

  it("ピークは渡されたときだけ、図のタブの中に図と並べて出す", () => {
    localStorage.setItem("ark-split-show-board", "1");
    const session = makeSession("wa-peek");
    const container = mount(paneSection(session, true, { filePane }));
    const root = mountedRoots.at(-1)?.root;
    expect(peekEl(container)).toBeNull();

    act(() => root?.render(paneSection(session, true, { filePane, peek })));
    expect(peekEl(container)?.dataset.visible).toBe("true");
    // 図と同じタブパネルの中で、図のあとに並ぶ
    const panel = diagramEl(container)?.closest('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    expect(peekEl(container)?.closest('[role="tabpanel"]')).toBe(panel);
    expect(
      (diagramEl(container) as Node).compareDocumentPosition(
        peekEl(container) as Node
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // リサイザは増やさない
    expect(resizers(container).length).toBe(1);

    // 「ファイル」のタブでは隠れる
    clickTab(container, "ファイル");
    expect(isHidden(peekEl(container))).toBe(true);
    expect(peekEl(container)?.dataset.visible).toBe("false");

    act(() =>
      root?.render(paneSection(session, true, { filePane, peek: null }))
    );
    expect(peekEl(container)).toBeNull();
  });

  it("peekSeq は初回の値では開かず、増えたら開いて「図」へ替える", () => {
    localStorage.setItem("ark-split-right-tab", "files");
    const session = makeSession("wa-peek-seq");
    const container = mount(
      paneSection(session, true, { filePane, peek, peekSeq: 2 })
    );
    const root = mountedRoots.at(-1)?.root;
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("false");
    expect(peekEl(container)?.dataset.visible).toBe("false");

    act(() =>
      root?.render(paneSection(session, true, { filePane, peek, peekSeq: 3 }))
    );
    expect(toggle(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(selectedTab(container)).toBe("図");
    expect(isHidden(peekEl(container))).toBe(false);
    expect(peekEl(container)?.dataset.visible).toBe("true");
    expect(isHidden(diagramEl(container))).toBe(false);
  });

  it("ピークは作業エリアを閉じても外さない (未保存の編集を保つ)", () => {
    localStorage.setItem("ark-split-show-board", "1");
    const container = mount(
      paneSection(makeSession("wa-peek-keep"), true, { peek })
    );
    const opened = peekEl(container);
    expect(opened).not.toBeNull();

    clickButton(header(container), "パネル");
    expect(peekEl(container)).toBe(opened);
    expect(isHidden(peekEl(container))).toBe(true);
    expect(peekEl(container)?.dataset.visible).toBe("false");
    expect(diagramEl(container)).toBeNull();
  });

  it("ピークを出しても、左ペインの幅は変わらない (作業エリアが残りを埋める)", () => {
    localStorage.setItem("ark-split-show-board", "1");
    localStorage.setItem("ark-split-left-width", "500");
    const session = makeSession("wa-peek-width");
    const container = mount(paneSection(session, true, { filePane }));
    const root = mountedRoots.at(-1)?.root;
    expect(leftPane(container).style.width).toBe("500px");
    // 作業エリアは幅を持たず、残りを埋める
    expect(workArea(container).style.width).toBe("");
    expect(workArea(container).className).toContain("flex-1");

    act(() => root?.render(paneSection(session, true, { filePane, peek })));
    expect(leftPane(container).style.width).toBe("500px");

    clickTab(container, "ファイル");
    expect(leftPane(container).style.width).toBe("500px");
    expect(localStorage.getItem("ark-split-left-width")).toBe("500");
  });

  it("作業エリアを閉じている間は、左ペインが全幅を使う", () => {
    localStorage.setItem("ark-split-left-width", "500");
    const container = mount(
      paneSection(makeSession("wa-closed-width"), true, { filePane })
    );

    expect(leftPane(container).style.width).toBe("");
    expect(leftPane(container).className).toContain("flex-1");
  });

  describe("「Git」のタブ", () => {
    const gitPane = (visible: boolean) => (
      <div data-testid="git-pane" data-visible={String(visible)} />
    );
    const gitPaneEl = (scope: ParentNode) =>
      scope.querySelector<HTMLElement>('[data-testid="git-pane"]');
    const tabLabels = (scope: ParentNode) =>
      Array.from(scope.querySelectorAll('[role="tab"]')).map(
        el => el.textContent
      );

    it("gitPane を渡したときだけタブを出す", () => {
      localStorage.setItem("ark-split-show-board", "1");
      const session = makeSession("git-tab");
      const container = mount(paneSection(session, true, { filePane }));
      expect(tabLabels(container)).toEqual(["図", "ファイル"]);

      const root = mountedRoots.at(-1)?.root;
      act(() =>
        root?.render(paneSection(session, true, { filePane, gitPane }))
      );
      expect(tabLabels(container)).toEqual(["図", "ファイル", "Git"]);
    });

    it("gitPane が無ければ、保存値が git でも図を見せる", () => {
      localStorage.setItem("ark-split-show-board", "1");
      localStorage.setItem("ark-split-right-tab", "git");
      const container = mount(
        paneSection(makeSession("git-none"), true, { filePane })
      );
      expect(selectedTab(container)).toBe("図");
      expect(isHidden(diagramEl(container))).toBe(false);
      expect(filePaneEl(container)).toBeNull();
    });

    it("初めて見せるまでマウントせず、見せたあとはタブを替えても閉じても外さない", () => {
      const container = mount(
        paneSection(makeSession("git-keep"), true, { filePane, gitPane })
      );
      clickButton(header(container), "パネル");
      // 開いただけ (図のタブ) ではマウントしない
      expect(gitPaneEl(container)).toBeNull();

      clickTab(container, "Git");
      expect(selectedTab(container)).toBe("Git");
      expect(localStorage.getItem("ark-split-right-tab")).toBe("git");
      const opened = gitPaneEl(container);
      expect(opened?.dataset.visible).toBe("true");
      expect(isHidden(opened)).toBe(false);
      // ファイルは見せていないのでマウントしない
      expect(filePaneEl(container)).toBeNull();

      // タブを替えても同じ要素が残り、見えていないことだけ伝える
      clickTab(container, "ファイル");
      expect(gitPaneEl(container)).toBe(opened);
      expect(isHidden(gitPaneEl(container))).toBe(true);
      expect(gitPaneEl(container)?.dataset.visible).toBe("false");

      // 閉じても外さない
      clickTab(container, "Git");
      clickButton(header(container), "パネル");
      expect(gitPaneEl(container)).toBe(opened);
      expect(isHidden(gitPaneEl(container))).toBe(true);
      expect(gitPaneEl(container)?.dataset.visible).toBe("false");
      expect(resizers(container)[0].className).toContain("hidden");

      clickButton(header(container), "パネル");
      expect(gitPaneEl(container)).toBe(opened);
      expect(gitPaneEl(container)?.dataset.visible).toBe("true");
    });

    it("保存したタブ (git) で開く。選択中でないセッションでは見せるまでマウントしない", () => {
      localStorage.setItem("ark-split-show-board", "1");
      localStorage.setItem("ark-split-right-tab", "git");
      const session = makeSession("git-saved");
      const container = mount(
        paneSection(session, false, { filePane, gitPane })
      );
      const root = mountedRoots.at(-1)?.root;
      expect(selectedTab(container)).toBe("Git");
      expect(gitPaneEl(container)).toBeNull();

      act(() =>
        root?.render(paneSection(session, true, { filePane, gitPane }))
      );
      expect(gitPaneEl(container)?.dataset.visible).toBe("true");
      // 図とファイルは見せるまでマウントしない
      expect(diagramEl(container)).toBeNull();
      expect(filePaneEl(container)).toBeNull();

      act(() =>
        root?.render(paneSection(session, false, { filePane, gitPane }))
      );
      expect(gitPaneEl(container)?.dataset.visible).toBe("false");
    });

    it("←/→ は 3 つのタブを巡る", () => {
      localStorage.setItem("ark-split-show-board", "1");
      const container = mount(
        paneSection(makeSession("git-keys"), true, { filePane, gitPane })
      );
      const press = (label: string, key: string) =>
        act(() =>
          tab(container, label).dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true })
          )
        );
      press("図", "ArrowLeft");
      expect(selectedTab(container)).toBe("Git");
      expect(document.activeElement).toBe(tab(container, "Git"));
      press("Git", "ArrowRight");
      expect(selectedTab(container)).toBe("図");
    });

    it("Git のタブからでも、fileOpenSeq が増えたら「ファイル」へ替える (「ファイルで開く」)", () => {
      localStorage.setItem("ark-split-show-board", "1");
      localStorage.setItem("ark-split-right-tab", "git");
      const session = makeSession("git-open-file");
      const container = mount(
        paneSection(session, true, { filePane, gitPane, fileOpenSeq: 1 })
      );
      const root = mountedRoots.at(-1)?.root;
      expect(selectedTab(container)).toBe("Git");

      act(() =>
        root?.render(
          paneSection(session, true, { filePane, gitPane, fileOpenSeq: 2 })
        )
      );
      expect(selectedTab(container)).toBe("ファイル");
      expect(localStorage.getItem("ark-split-right-tab")).toBe("files");
      expect(filePaneEl(container)?.dataset.visible).toBe("true");
      // Git は外さずに隠す
      expect(isHidden(gitPaneEl(container))).toBe(true);
      expect(gitPaneEl(container)?.dataset.visible).toBe("false");
    });

    it("図の activation やピークでは「図」へ替わり、自動で Git へ替わることは無い", () => {
      localStorage.setItem("ark-split-show-board", "1");
      localStorage.setItem("ark-split-right-tab", "git");
      const session = makeSession("git-auto");
      const container = mount(
        paneSection(session, true, { filePane, gitPane, peekSeq: 1 })
      );
      const root = mountedRoots.at(-1)?.root;
      act(() =>
        root?.render(
          paneSection(session, true, { filePane, gitPane, peek, peekSeq: 2 })
        )
      );
      expect(selectedTab(container)).toBe("図");
      expect(isHidden(gitPaneEl(container))).toBe(true);
    });

    it("Git のタブに替えても、左ペインの幅は変わらない", () => {
      localStorage.setItem("ark-split-show-board", "1");
      localStorage.setItem("ark-split-left-width", "500");
      const container = mount(
        paneSection(makeSession("git-width"), true, { filePane, gitPane })
      );
      expect(leftPane(container).style.width).toBe("500px");

      clickTab(container, "Git");
      expect(leftPane(container).style.width).toBe("500px");
      clickTab(container, "図");
      expect(leftPane(container).style.width).toBe("500px");
    });
  });

  it("ドラッグ中は左ペインも作業エリアも pointer-events-none になる", () => {
    localStorage.setItem("ark-split-show-board", "1");
    const container = mount(
      paneSection(makeSession("wa-drag"), true, { filePane })
    );
    const body = container.querySelector(
      '[data-testid="split-view-body"]'
    ) as HTMLElement;
    const panes = () =>
      Array.from(body.children).filter(el => el.tagName === "DIV");
    expect(panes().length).toBe(2);
    expect(panes().some(p => p.className.includes("pointer-events-none"))).toBe(
      false
    );

    act(() =>
      resizers(container)[0].dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      )
    );
    expect(
      panes().every(p => p.className.includes("pointer-events-none"))
    ).toBe(true);
    act(() => window.dispatchEvent(new MouseEvent("mouseup")));
    expect(panes().some(p => p.className.includes("pointer-events-none"))).toBe(
      false
    );
  });

  it("ドラッグした幅は両方の最小幅 (360px) を残すところで止め、離したときに保存する", () => {
    localStorage.setItem("ark-split-show-board", "1");
    localStorage.setItem("ark-split-left-width", "400");
    const container = mount(
      paneSection(makeSession("wa-drag-width"), true, { filePane })
    );
    stubContainerRect(container, 1000);
    act(() =>
      resizers(container)[0].dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      )
    );

    // 収まる範囲ならカーソルの位置どおり (左ペインの幅 = 左端からカーソルまで)
    act(() =>
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }))
    );
    expect(leftPane(container).style.width).toBe("500px");
    // 離すまでは保存しない
    expect(localStorage.getItem("ark-split-left-width")).toBe("400");

    // 左端近くまで引いても、左ペインの最小幅 (360px) は割らない
    act(() =>
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }))
    );
    expect(leftPane(container).style.width).toBe("360px");

    act(() => window.dispatchEvent(new MouseEvent("mouseup")));
    expect(localStorage.getItem("ark-split-left-width")).toBe("360");

    // 右端まで寄せても、作業エリア 360px + リサイザ 8px を残す (1000 - 360 - 8)
    act(() =>
      resizers(container)[0].dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      )
    );
    act(() =>
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 950 }))
    );
    act(() => window.dispatchEvent(new MouseEvent("mouseup")));
    expect(localStorage.getItem("ark-split-left-width")).toBe("632");
  });
});
