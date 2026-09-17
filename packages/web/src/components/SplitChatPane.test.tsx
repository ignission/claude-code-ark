// @vitest-environment jsdom

import type { ManagedSession } from "@ark/shared";
import { act, type ComponentProps, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitChatPane, type SplitChatPaneHandle } from "./SplitChatPane";

type ChatSocket = NonNullable<ComponentProps<typeof SplitChatPane>["socket"]>;

/** on / off / emitだけを持つsocketの偽物。サーバーからのpushはemitServerで起こす */
function createFakeSocket() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const fake = {
    on(event: string, handler: (data: unknown) => void) {
      const set = handlers.get(event) ?? new Set<(data: unknown) => void>();
      set.add(handler);
      handlers.set(event, set);
      return fake;
    },
    off(event: string, handler: (data: unknown) => void) {
      handlers.get(event)?.delete(handler);
      return fake;
    },
    emit: vi.fn(),
  };
  const emitServer = (event: string, data: unknown) => {
    act(() => {
      for (const handler of handlers.get(event) ?? []) handler(data);
    });
  };
  return { socket: fake as unknown as ChatSocket, emitServer };
}

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
    createdAt: new Date("2026-09-17T00:00:00Z"),
    tmuxSessionName: `tmux-${id}`,
    ttydPort: 4100,
    ttydUrl: `/ttyd/${id}/`,
  };
}

function renderChat(
  overrides: Partial<ComponentProps<typeof SplitChatPane>> = {}
) {
  const { socket, emitServer } = createFakeSocket();
  const onSendMessage = vi.fn();
  const onSendKey = vi.fn();
  const container = mount(
    <SplitChatPane
      socket={socket}
      session={makeSession("s1")}
      isActive
      onSendMessage={onSendMessage}
      onSendKey={onSendKey}
      {...overrides}
    />
  );
  return { container, emitServer, onSendMessage, onSendKey };
}

const line = (record: unknown) => JSON.stringify(record);

/** 依頼 → Read (完了) とBash (実行中) の2件のツール呼び出し */
const TOOL_SNAPSHOT = [
  line({
    type: "user",
    uuid: "u1",
    message: { role: "user", content: "テストを直して" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "src/app.ts" },
        },
        {
          type: "tool_use",
          id: "t2",
          name: "Bash",
          input: { command: "pnpm test" },
        },
      ],
    },
  }),
  line({
    type: "user",
    uuid: "r1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  }),
];

function findButtonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(b =>
    b.textContent?.includes(text)
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

/** 制御されたtextareaに値を入れてReactのonChangeを起こす */
function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  act(() => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("SplitChatPane: ツール行の折りたたみ", () => {
  it("連続するツール呼び出しを「作業N件」の1行に畳み、実行中の最新の1件だけを下に出す", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: TOOL_SNAPSHOT,
    });

    const summary = findButtonByText(container, "作業2件");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).not.toContain("src/app.ts");
  });

  it("押すと既存のツール行が開き、実行中の行を二重に出さない", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: TOOL_SNAPSHOT,
    });

    const summary = findButtonByText(container, "作業2件");
    act(() => summary.click());

    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("src/app.ts");
    expect(container.textContent?.split("pnpm test")).toHaveLength(2);
  });

  it("末尾にいるとき、最後の「作業N件」を開くと末尾まで追従する", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: TOOL_SNAPSHOT,
    });

    // スクロール領域は本文 (chat-scroll-content) の親
    const scrollEl = container.querySelector<HTMLElement>(
      '[data-testid="chat-scroll-content"]'
    )?.parentElement;
    if (!scrollEl) throw new Error("スクロール領域が見つからない");

    // jsdomはレイアウトを計算しないため、scrollHeight/clientHeightを
    // 差し替えて「末尾付近にいる」状態を作る
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 100,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "scrollHeight", {
      value: 200,
      configurable: true,
    });
    scrollEl.scrollTop = 100; // 200 - 100 - 100 = 0 (< 100) → 末尾付近
    act(() => scrollEl.dispatchEvent(new Event("scroll")));

    const summary = findButtonByText(container, "作業2件");

    // 展開でまとまりの行が増え、コンテンツの高さが伸びたことを再現する
    Object.defineProperty(scrollEl, "scrollHeight", {
      value: 500,
      configurable: true,
    });
    act(() => summary.click());

    expect(scrollEl.scrollTop).toBe(500);
  });

  it("開いたまとまりでも実行中の行に「実行中」を示す", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: TOOL_SNAPSHOT,
    });

    const summary = findButtonByText(container, "作業2件");
    act(() => summary.click());

    const runningLabels = Array.from(
      container.querySelectorAll<HTMLElement>(".sr-only")
    ).filter(el => el.textContent === "実行中:");
    expect(runningLabels).toHaveLength(1);
  });
});

describe("SplitChatPane: ヘッダー行と質問カードの通知", () => {
  it("自前のヘッダー行 (busy表示・購読ドット) を出さない", () => {
    const { container } = renderChat({ bridgeStatus: "TOOL" });

    expect(container.querySelector("header")).toBeNull();
    expect(container.textContent).not.toContain("ツール実行中");
    expect(container.querySelector('[title="JSONL 購読中"]')).toBeNull();
  });

  it("質問カードの表示有無が変わるたびにonActiveAuqChangeを呼ぶ", () => {
    const at = Date.parse("2026-09-17T00:00:00Z");
    const questions = [
      {
        question: "どちらにしますか？",
        options: [{ label: "A" }, { label: "B" }],
      },
    ];
    const onActiveAuqChange = vi.fn();
    const { emitServer } = renderChat({ onActiveAuqChange });
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(false);

    emitServer("session:auq", {
      sessionId: "s1",
      at,
      questions,
      screen: null,
    });
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(true);

    // 回答がJSONLに書かれるとカードが閉じる
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: [
        line({
          type: "assistant",
          uuid: "q1",
          timestamp: new Date(at + 1000).toISOString(),
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "auq1",
                name: "AskUserQuestion",
                input: { questions },
              },
            ],
          },
        }),
        line({
          type: "user",
          uuid: "q1r",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "auq1",
                content: '"どちらにしますか？"="A"',
              },
            ],
          },
        }),
      ],
    });
    expect(onActiveAuqChange).toHaveBeenLastCalledWith(false);
  });
});

/** 要約・外部画像・サブエージェント・回答済みの質問を含む履歴 */
const DECORATED_SNAPSHOT = [
  line({
    type: "user",
    uuid: "c1",
    isCompactSummary: true,
    message: { role: "user", content: "これまでの要約" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "図です ![構成図](https://example.com/a.png)" },
      ],
    },
  }),
  line({
    type: "assistant",
    uuid: "sc1",
    isSidechain: true,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "調べた結果" }],
    },
  }),
  line({
    type: "assistant",
    uuid: "q1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "auq1",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "どちらにしますか？",
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          },
        },
      ],
    },
  }),
  line({
    type: "user",
    uuid: "q1r",
    toolUseResult: { answers: { "どちらにしますか？": "A" } },
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "auq1",
          content: '"どちらにしますか？"="A"',
        },
      ],
    },
  }),
];

describe("SplitChatPane: アイコン", () => {
  it("絵文字をアイコンに使わない", () => {
    const { container, emitServer } = renderChat();
    emitServer("session:jsonl-snapshot", {
      sessionId: "s1",
      lines: DECORATED_SNAPSHOT,
    });

    const text = container.textContent ?? "";
    expect(text).toContain("会話を要約しました");
    expect(text).toContain("構成図");
    expect(text).toContain("サブエージェント");
    expect(text).toContain("質問への回答");
    expect(text).not.toMatch(/⚙|❓|⏳|🧵|🖼|✂|🎨|🖥|▸|▾/u);
  });
});

describe("SplitChatPane: 入力欄", () => {
  it("送信ボタンは空のあいだ押せず、入力して押すと送信し、送信中の吹き出しを出す", () => {
    const { container, onSendMessage } = renderChat();
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="メッセージ"]'
    );
    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="送信"]'
    );
    expect(textarea).not.toBeNull();
    expect(send?.disabled).toBe(true);

    typeInto(textarea as HTMLTextAreaElement, "ログイン画面を作って");
    expect(send?.disabled).toBe(false);

    act(() => send?.click());
    expect(onSendMessage).toHaveBeenCalledWith("ログイン画面を作って");
    expect(container.querySelector('svg[aria-label="送信中"]')).not.toBeNull();
    expect(container.textContent).toContain("ログイン画面を作って");
  });
});

describe("SplitChatPane: 作業中の表示", () => {
  const indicator = (container: HTMLElement) =>
    container.querySelector('[data-testid="chat-working-indicator"]');

  it("考えている間と作業している間は、会話の最後に呼吸する3点と文言を出す", () => {
    const thinking = renderChat({ bridgeStatus: "THINK" });
    expect(indicator(thinking.container)?.textContent).toContain(
      "考えています"
    );
    expect(
      indicator(thinking.container)?.querySelectorAll(".status-dots > span")
    ).toHaveLength(3);
    expect(indicator(thinking.container)?.getAttribute("role")).toBe("status");

    const working = renderChat({ bridgeStatus: "TOOL" });
    expect(indicator(working.container)?.textContent).toContain(
      "作業しています"
    );
  });

  it("入力待ち・待機・停止・問題・状態未着では出さない", () => {
    for (const bridgeStatus of [
      "IDLE",
      "READY",
      "STOP",
      "ERR",
      undefined,
    ] as const) {
      const { container } = renderChat({ bridgeStatus });
      expect(indicator(container)).toBeNull();
    }
  });

  it("送信中の吹き出しがあっても、確認待ち・停止・問題のときは出さない", () => {
    for (const bridgeStatus of ["AWAITING", "STOP", "ERR"] as const) {
      const { container } = renderChat({ bridgeStatus });
      const textarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="メッセージ"]'
      );
      typeInto(textarea as HTMLTextAreaElement, "テスト");
      act(() =>
        container
          .querySelector<HTMLButtonElement>('button[aria-label="送信"]')
          ?.click()
      );
      expect(
        container.querySelector('svg[aria-label="送信中"]')
      ).not.toBeNull();
      expect(indicator(container)).toBeNull();
    }
  });

  it("PCでは切り替わる文言ではなく固定の文を1つの読み上げ領域で伝える", () => {
    const { container } = renderChat({ bridgeStatus: "TOOL" });
    const el = indicator(container);
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.querySelector(".sr-only")?.textContent).toBe(
      "Claudeが作業しています"
    );
    const visible = Array.from(el?.querySelectorAll("span") ?? []).find(
      span => span.textContent === "作業しています"
    );
    expect(visible?.getAttribute("aria-hidden")).toBe("true");
  });

  it("モバイルでは状態の帯が読み上げるので、3点と文言は出しても読み上げ領域にしない", () => {
    const { container } = renderChat({
      bridgeStatus: "THINK",
      layout: "mobile",
    });
    const el = indicator(container);
    expect(el).not.toBeNull();
    expect(el?.getAttribute("role")).toBeNull();
    expect(el?.getAttribute("aria-hidden")).toBe("true");
  });

  it("送った直後、状態が切り替わる前でも送信中の吹き出しがある間は「考えています」を出す", () => {
    const { container } = renderChat({ bridgeStatus: "IDLE" });
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="メッセージ"]'
    );
    typeInto(textarea as HTMLTextAreaElement, "テスト");
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="送信"]')
        ?.click()
    );
    expect(indicator(container)?.textContent).toContain("考えています");
  });

  it("質問カードが出ている間は出さない", () => {
    const { container, emitServer } = renderChat({ bridgeStatus: "THINK" });
    emitServer("session:auq", {
      sessionId: "s1",
      at: Date.parse("2026-09-17T00:00:00Z"),
      questions: [
        {
          question: "どちらにしますか？",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
      screen: null,
    });
    expect(indicator(container)).toBeNull();
  });
});

describe("SplitChatPane: 確認待ちのカード", () => {
  it("質問カードが無い確認待ちは「確認待ち」のチップ付きのカードで出し、キーを送れる", () => {
    const { container, onSendKey } = renderChat({
      bridgeStatus: "AWAITING",
      awaitingText: "Do you want to proceed?\n  1. Yes\n  2. No",
    });

    expect(container.textContent).toContain("確認待ち");
    expect(container.querySelector("pre")?.textContent).toContain(
      "Do you want to proceed?"
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title^="1を送信"]')
        ?.click()
    );
    expect(onSendKey).toHaveBeenCalledWith("1");
  });
});

describe('SplitChatPane: layout="mobile"', () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("入力欄を浮かぶガラスバーに入れ、composerAccessoryを入力欄の上段に置く", () => {
    const { container } = renderChat({
      layout: "mobile",
      composerAccessory: <div data-testid="accessory">会話 / 端末 / 図</div>,
    });

    const bar = container.querySelector("[data-mobile-bottom-bar]");
    expect(bar?.classList.contains("glass-bar")).toBe(true);
    const accessory = bar?.querySelector('[data-testid="accessory"]');
    const textarea = bar?.querySelector('textarea[aria-label="メッセージ"]');
    expect(accessory).not.toBeNull();
    expect(textarea).not.toBeNull();
    expect(accessory?.compareDocumentPosition(textarea as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("バーを下端から浮かせ、本文の下端にバーの高さと下端からの距離を足した余白を取る", () => {
    const { container } = renderChat({ layout: "mobile" });

    const stack = container.querySelector<HTMLElement>(
      '[data-testid="floating-composer"]'
    );
    const content = container.querySelector<HTMLElement>(
      '[data-testid="chat-scroll-content"]'
    );
    expect(stack?.style.bottom).toBe("max(12px, env(safe-area-inset-bottom))");
    expect(content?.style.paddingBottom).toContain(
      "env(safe-area-inset-bottom)"
    );
  });

  it("質問カードはガラスバーの外 (上) に積む", () => {
    const { container } = renderChat({
      layout: "mobile",
      bridgeStatus: "AWAITING",
    });

    const stack = container.querySelector('[data-testid="floating-composer"]');
    const bar = stack?.querySelector("[data-mobile-bottom-bar]");
    expect(bar).not.toBeNull();
    expect(stack?.textContent).toContain("確認待ち");
    expect(bar?.textContent).not.toContain("確認待ち");
  });

  it("layoutを渡さない (PC) ときはガラスバーもaccessoryも出さず、本文の余白も足さない", () => {
    const { container } = renderChat({
      composerAccessory: <div data-testid="accessory" />,
    });

    expect(container.querySelector(".glass-bar")).toBeNull();
    expect(container.querySelector("[data-mobile-bottom-bar]")).toBeNull();
    expect(container.querySelector('[data-testid="accessory"]')).toBeNull();
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="chat-scroll-content"]'
      )?.style.paddingBottom
    ).toBe("");
  });
});

describe("SplitChatPane: 外のバーから呼ぶ添付の操作 (ref)", () => {
  const uploaded = {
    path: "/uploads/pasted-image.png",
    filename: "pasted-image.png",
  };

  function renderWithHandle() {
    const ref = createRef<SplitChatPaneHandle>();
    const onUploadFile = vi.fn(async () => uploaded);
    const { socket } = createFakeSocket();
    const container = mount(
      <SplitChatPane
        ref={ref}
        socket={socket}
        session={makeSession("s1")}
        isActive
        onSendMessage={vi.fn()}
        onSendKey={vi.fn()}
        onUploadFile={onUploadFile}
      />
    );
    return { ref, container, onUploadFile };
  }

  /** FileReader と fetch のマイクロタスクが片付くまで待つ */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  it("openFilePicker は入力欄の隠しファイル選択を開く", () => {
    const { ref, container } = renderWithHandle();
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const click = vi.spyOn(input as HTMLInputElement, "click");

    act(() => ref.current?.openFilePicker());

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("pasteImage はクリップボードの画像を上げて、入力欄に @path を足す", async () => {
    const blob = new Blob(["dummy"], { type: "image/png" });
    const read = vi.fn(async () => [
      { types: ["image/png"], getType: async () => blob },
    ]);
    Object.defineProperty(navigator, "clipboard", {
      value: { read },
      configurable: true,
    });
    const { ref, container, onUploadFile } = renderWithHandle();

    act(() => {
      ref.current?.pasteImage();
    });
    await settle();
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(onUploadFile).toHaveBeenCalledTimes(1);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.value).toContain("@/uploads/pasted-image.png");
  });
});
