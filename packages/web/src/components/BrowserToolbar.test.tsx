// @vitest-environment jsdom

import type {
  BrowserClientMessage,
  BrowserPageInfo,
  BrowserTabInfo,
} from "@ark/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserToolbar } from "./BrowserToolbar";

const PAGE: BrowserPageInfo = {
  url: "http://localhost:5173/",
  title: "アプリ",
  loading: false,
  canGoBack: true,
  canGoForward: false,
};

const TAB_A: BrowserTabInfo = {
  id: "A",
  title: "アプリ",
  url: "http://localhost:5173/",
};
const TAB_B: BrowserTabInfo = { id: "B", title: "", url: "about:blank" };
const TAB_C: BrowserTabInfo = { id: "C", title: "", url: "" };

let root: Root;
let container: HTMLDivElement;
const onSend = vi.fn<(msg: BrowserClientMessage) => void>();

function render(element: ReactElement) {
  act(() => root.render(element));
}

function toolbar(
  props: Partial<Parameters<typeof BrowserToolbar>[0]> = {}
): ReactElement {
  return (
    <BrowserToolbar
      page={PAGE}
      tabs={[TAB_A]}
      activeId="A"
      onSend={onSend}
      {...props}
    />
  );
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`ボタンがありません: ${label}`);
  return found as HTMLButtonElement;
}

function urlField(): HTMLInputElement {
  return container.querySelector('input[aria-label="URL"]') as HTMLInputElement;
}

function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(
  target: Element,
  key: string,
  init: KeyboardEventInit = {}
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function click(target: Element, init: MouseEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ...init })
    );
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  onSend.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BrowserToolbar", () => {
  it("戻ると進むは、`canGoBack` と `canGoForward` で無効にする", () => {
    render(toolbar());
    expect(button("戻る").disabled).toBe(false);
    expect(button("進む").disabled).toBe(true);

    render(
      toolbar({ page: { ...PAGE, canGoBack: false, canGoForward: true } })
    );
    expect(button("戻る").disabled).toBe(true);
    expect(button("進む").disabled).toBe(false);
  });

  it("ページの状態が届くまでは、戻ると進むを無効にし、URLを空にする", () => {
    render(toolbar({ page: null }));
    expect(button("戻る").disabled).toBe(true);
    expect(button("進む").disabled).toBe(true);
    expect(urlField().value).toBe("");
  });

  it("戻る、進む、再読み込みは `nav` を送る", () => {
    render(toolbar({ page: { ...PAGE, canGoForward: true } }));
    click(button("戻る"));
    click(button("進む"));
    click(button("再読み込み"));

    expect(onSend.mock.calls.map(([msg]) => msg)).toEqual([
      { t: "nav", type: "back" },
      { t: "nav", type: "forward" },
      { t: "nav", type: "reload" },
    ]);
  });

  it("読み込み中は、再読み込みが中止に変わる", () => {
    render(toolbar({ page: { ...PAGE, loading: true } }));
    expect(
      container.querySelector('button[aria-label="再読み込み"]')
    ).toBeNull();
    click(button("読み込みを中止"));

    expect(onSend).toHaveBeenCalledWith({ t: "nav", type: "stop" });
  });

  it("アイコンだけのボタンには、名前と同じツールチップを付ける", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B] }));
    for (const el of container.querySelectorAll("button")) {
      expect(el.getAttribute("aria-label") || el.textContent).toBeTruthy();
      if (el.getAttribute("role") !== "tab") {
        expect(el.title).toBe(el.getAttribute("aria-label"));
      }
    }
  });

  it("入力欄は、フォーカスが無い間は `page.url` を表示する", () => {
    render(toolbar());
    expect(urlField().value).toBe("http://localhost:5173/");

    render(toolbar({ page: { ...PAGE, url: "http://localhost:5173/next" } }));
    expect(urlField().value).toBe("http://localhost:5173/next");
  });

  it("入力欄は、モバイルで勝手に直されない設定にする", () => {
    render(toolbar());
    const field = urlField();
    expect(field.type).toBe("text");
    expect(field.getAttribute("inputmode")).toBe("url");
    expect(field.getAttribute("autocapitalize")).toBe("off");
    expect(field.getAttribute("autocorrect")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
  });

  it("フォーカスすると全体を選び、フォーカス中は `page.url` で上書きしない", () => {
    render(toolbar());
    const field = urlField();
    act(() => field.focus());
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("http://localhost:5173/".length);

    type(field, "localhost:3000/a");
    // 続けて2回届いても、入力と、フォーカスと、カーソルを保つ
    render(toolbar({ page: { ...PAGE, loading: true } }));
    render(toolbar({ page: { ...PAGE, url: "http://localhost:5173/next" } }));

    expect(urlField()).toBe(field);
    expect(field.value).toBe("localhost:3000/a");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe("localhost:3000/a".length);
  });

  it("Enterで入力のまま `goto` を送り、フォーカスを外す", () => {
    render(toolbar());
    const field = urlField();
    act(() => field.focus());
    type(field, " localhost:3000/a ");
    const enter = press(field, "Enter");

    expect(enter.defaultPrevented).toBe(true);
    expect(onSend.mock.calls.map(([msg]) => msg)).toEqual([
      { t: "nav", type: "goto", url: " localhost:3000/a " },
    ]);
    expect(document.activeElement).not.toBe(field);
    // フォーカスが外れたら、サーバーが知らせたURLに戻る
    expect(field.value).toBe("http://localhost:5173/");
  });

  it("空のままEnterを押しても送らない", () => {
    render(toolbar());
    const field = urlField();
    act(() => field.focus());
    type(field, "   ");
    press(field, "Enter");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("Escapeで元のURLへ戻し、フォーカスを外す", () => {
    render(toolbar());
    const field = urlField();
    act(() => field.focus());
    type(field, "localhost:3000/a");
    press(field, "Escape");

    expect(onSend).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(field);
    expect(field.value).toBe("http://localhost:5173/");
  });

  it("入力欄で打ったキーは、`nav` のほかには何も送らない", () => {
    render(toolbar());
    const field = urlField();
    act(() => field.focus());
    press(field, "a");
    press(field, "Backspace");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("タブが1つなら、並びを出さず、+ をツールバーの右端に置く", () => {
    render(toolbar());
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    click(button("新しいタブ"));

    expect(onSend).toHaveBeenCalledWith({ t: "tab", type: "new" });
  });

  it("タブが2つ以上なら並びを出し、+ は並びの右端に置く", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B, TAB_C] }));
    const list = container.querySelector('[role="tablist"]') as HTMLElement;
    const tabs = [...list.querySelectorAll('[role="tab"]')];

    // タイトルが空ならURL、それも空なら「新しいタブ」
    expect(tabs.map(tab => tab.textContent)).toEqual([
      "アプリ",
      "about:blank",
      "新しいタブ",
    ]);
    expect(tabs.map(tab => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(
      container.querySelectorAll('button[aria-label="新しいタブ"]')
    ).toHaveLength(1);
    expect(list.contains(button("新しいタブ"))).toBe(false);
    expect(
      list.parentElement?.parentElement?.contains(button("新しいタブ"))
    ).toBe(true);
  });

  it("`tablist` の直接の子はタブだけで、閉じるボタンはタブの外に置く", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B, TAB_C] }));
    const list = container.querySelector('[role="tablist"]') as HTMLElement;

    expect([...list.children].map(el => el.getAttribute("role"))).toEqual([
      "tab",
      "tab",
      "tab",
    ]);
    expect(list.querySelectorAll('[role="tab"] button')).toHaveLength(0);
    const closers = [
      ...container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="タブを閉じる: "]'
      ),
    ];
    expect(closers.map(el => el.getAttribute("aria-label"))).toEqual([
      "タブを閉じる: アプリ",
      "タブを閉じる: about:blank",
      "タブを閉じる: 新しいタブ",
    ]);
    for (const closer of closers) {
      expect(list.contains(closer)).toBe(false);
      // キーボードでは、タブの上のDeleteで閉じる。Tabでは止まらない
      expect(closer.tabIndex).toBe(-1);
    }
    // 見た目の順は、タブ、そのタブを閉じるボタン、次のタブ
    const tabs = [...list.children] as HTMLElement[];
    expect(tabs.map(el => el.style.order)).toEqual(["0", "2", "4"]);
    expect(closers.map(el => el.style.order)).toEqual(["1", "3", "5"]);
  });

  it("Tabで止まるのは映しているタブだけで、左右の矢印でタブの間を移る", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B, TAB_C], activeId: "B" }));
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map(el => el.tabIndex)).toEqual([-1, 0, -1]);

    act(() => tabs[1].focus());
    const right = press(tabs[1], "ArrowRight");
    expect(right.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tabs[2]);
    // 端からは、反対の端へ回る
    press(tabs[2], "ArrowRight");
    expect(document.activeElement).toBe(tabs[0]);
    press(tabs[0], "ArrowLeft");
    expect(document.activeElement).toBe(tabs[2]);
    // 移るだけでは、タブを切り替えない
    expect(onSend).not.toHaveBeenCalled();
  });

  it("映しているタブが一覧に無ければ、最初のタブでTabを止める", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B], activeId: null }));
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map(el => el.tabIndex)).toEqual([0, -1]);
  });

  it("タブの上のDeleteで閉じ、フォーカスを隣のタブへ移す", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B, TAB_C] }));
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    act(() => tabs[1].focus());
    const pressed = press(tabs[1], "Delete");

    expect(pressed.defaultPrevented).toBe(true);
    expect(onSend.mock.calls.map(([msg]) => msg)).toEqual([
      { t: "tab", type: "close", id: "B" },
    ]);
    expect(document.activeElement).toBe(tabs[2]);

    act(() => tabs[2].focus());
    press(tabs[2], "Delete");
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("EnterとEscapeのあと、`onUrlDone` を呼ぶ (フォーカスの行き先は親が決める)", () => {
    const onUrlDone = vi.fn(() => {
      // 呼ぶのは、入力欄のフォーカスを外したあと
      expect(document.activeElement).not.toBe(urlField());
    });
    render(toolbar({ onUrlDone }));
    const field = urlField();
    act(() => field.focus());
    type(field, "localhost:3000/a");
    press(field, "Enter");
    expect(onUrlDone).toHaveBeenCalledTimes(1);

    act(() => field.focus());
    press(field, "Escape");
    expect(onUrlDone).toHaveBeenCalledTimes(2);
    press(field, "a");
    expect(onUrlDone).toHaveBeenCalledTimes(2);
  });

  it("変換を確定するEnterでは、遷移しない", () => {
    const onUrlDone = vi.fn();
    render(toolbar({ onUrlDone }));
    const field = urlField();
    act(() => field.focus());
    type(field, "ろーかる");
    act(() => {
      field.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      );
    });
    press(field, "Enter", { isComposing: true, keyCode: 229 });

    expect(onSend).not.toHaveBeenCalled();
    expect(onUrlDone).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("ろーかる");
  });

  it("長いタイトルは省略して1行に収め、全体をツールチップで読める", () => {
    const title = "とても長いタイトル".repeat(20);
    render(toolbar({ tabs: [{ ...TAB_A, title }, TAB_B] }));
    const tab = container.querySelector('[role="tab"]') as HTMLElement;

    expect(tab.className.split(" ")).toContain("truncate");
    expect(tab.title).toBe(title);
  });

  it("タブを押すと `activate`、× で `close`、+ で `new` を送る", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B] }));
    const tabs = container.querySelectorAll('[role="tab"]');
    click(tabs[1]);
    click(button("タブを閉じる: about:blank"));
    click(button("新しいタブ"));

    expect(onSend.mock.calls.map(([msg]) => msg)).toEqual([
      { t: "tab", type: "activate", id: "B" },
      { t: "tab", type: "close", id: "B" },
      { t: "tab", type: "new" },
    ]);
  });

  it("タブを中ボタンで押すと閉じる", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B] }));
    const tab = container.querySelectorAll('[role="tab"]')[1];
    act(() => {
      tab.dispatchEvent(
        new MouseEvent("auxclick", {
          bubbles: true,
          cancelable: true,
          button: 1,
        })
      );
      // 右ボタンでは閉じない
      tab.dispatchEvent(
        new MouseEvent("auxclick", {
          bubbles: true,
          cancelable: true,
          button: 2,
        })
      );
    });

    expect(onSend.mock.calls.map(([msg]) => msg)).toEqual([
      { t: "tab", type: "close", id: "B" },
    ]);
  });

  it("`disabled` の間は、どの操作も受けない", () => {
    render(toolbar({ tabs: [TAB_A, TAB_B], disabled: true }));
    for (const el of container.querySelectorAll("button")) {
      expect(el.disabled).toBe(true);
    }
    expect(urlField().disabled).toBe(true);
  });
});
