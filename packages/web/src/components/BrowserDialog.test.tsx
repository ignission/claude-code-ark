// @vitest-environment jsdom

import type { BrowserDialogInfo } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserDialog } from "./BrowserDialog";

let root: Root;
let container: HTMLDivElement;
const onRespond = vi.fn<(accept: boolean, promptText?: string) => void>();

function render(dialog: BrowserDialogInfo, origin = "localhost:5173") {
  act(() =>
    root.render(
      <BrowserDialog dialog={dialog} origin={origin} onRespond={onRespond} />
    )
  );
}

function dialogOf(
  kind: BrowserDialogInfo["kind"],
  message = "よろしいですか?",
  defaultPrompt = ""
): BrowserDialogInfo {
  return { kind, message, defaultPrompt };
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = buttons().find(el => el.textContent === name);
  if (!found) throw new Error(`ボタンがありません: ${name}`);
  return found;
}

function click(target: Element) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
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

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  onRespond.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BrowserDialog", () => {
  it("モーダルのダイアログとして、どのページのものかを見出しに出す", () => {
    render(dialogOf("alert", "保存しました"));
    const dialog = container.querySelector('[role="alertdialog"]');

    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(
      dialog?.getAttribute("aria-labelledby") ?? ""
    );
    expect(title?.textContent).toBe("localhost:5173 の内容");
    const body = document.getElementById(
      dialog?.getAttribute("aria-describedby") ?? ""
    );
    expect(body?.textContent).toBe("保存しました");
  });

  it("ページの文字列は、HTMLとして解釈せず、改行を保って出す", () => {
    render(dialogOf("alert", '<img src=x onerror="alert(1)">\n2行目'));
    const dialog = container.querySelector('[role="alertdialog"]');
    const body = document.getElementById(
      dialog?.getAttribute("aria-describedby") ?? ""
    ) as HTMLElement;

    expect(container.querySelector("img")).toBeNull();
    expect(body.textContent).toBe('<img src=x onerror="alert(1)">\n2行目');
    expect(body.className.split(" ")).toEqual(
      expect.arrayContaining(["whitespace-pre-wrap", "overflow-y-auto"])
    );
  });

  it("`alert` はOKだけで、押すと受け入れる", () => {
    render(dialogOf("alert"));
    expect(buttons().map(el => el.textContent)).toEqual(["OK"]);
    expect(document.activeElement).toBe(buttonNamed("OK"));
    click(buttonNamed("OK"));

    expect(onRespond.mock.calls).toEqual([[true]]);
  });

  it("`alert` のEscapeは、閉じる (受け入れる) として送る", () => {
    render(dialogOf("alert"));
    const pressed = press(buttonNamed("OK"), "Escape");

    expect(pressed.defaultPrevented).toBe(true);
    expect(onRespond.mock.calls).toEqual([[true]]);
  });

  it("`confirm` はOKとキャンセルで、Escapeはキャンセル", () => {
    render(dialogOf("confirm"));
    expect(buttons().map(el => el.textContent)).toEqual(["キャンセル", "OK"]);
    click(buttonNamed("OK"));
    click(buttonNamed("キャンセル"));
    press(buttonNamed("OK"), "Escape");

    expect(onRespond.mock.calls).toEqual([[true], [false], [false]]);
  });

  it("`beforeunload` は決まった文言を出し、離れるかとどまるかを選ぶ", () => {
    render(dialogOf("beforeunload", "ページが渡した文字列"));
    const dialog = container.querySelector('[role="alertdialog"]');

    expect(dialog?.textContent).toContain("このページを離れますか?");
    expect(dialog?.textContent).toContain(
      "行った変更が保存されない可能性があります。"
    );
    expect(dialog?.textContent).not.toContain("ページが渡した文字列");
    click(buttonNamed("このページを離れる"));
    click(buttonNamed("とどまる"));

    expect(onRespond.mock.calls).toEqual([[true], [false]]);
  });

  it("`prompt` は初期値の入った入力欄にフォーカスし、EnterでOK、Escapeでキャンセル", () => {
    render(dialogOf("prompt", "名前は?", "太郎"));
    const field = container.querySelector("input") as HTMLInputElement;

    expect(field.value).toBe("太郎");
    expect(document.activeElement).toBe(field);
    type(field, "花子");
    const enter = press(field, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    press(field, "Escape");

    expect(onRespond.mock.calls).toEqual([[true, "花子"], [false]]);
  });

  it("`prompt` のOKボタンも、入力した文字列を送る", () => {
    render(dialogOf("prompt", "名前は?", "太郎"));
    click(buttonNamed("OK"));
    click(buttonNamed("キャンセル"));

    expect(onRespond.mock.calls).toEqual([[true, "太郎"], [false]]);
  });

  it("同じダイアログで描き直しても、入力中の文字列を保つ。別のダイアログなら初期値に戻す", () => {
    const first = dialogOf("prompt", "名前は?", "太郎");
    render(first);
    const field = container.querySelector("input") as HTMLInputElement;
    type(field, "花子");
    render(first);
    expect(field.value).toBe("花子");

    render(dialogOf("prompt", "年齢は?", "20"));
    expect((container.querySelector("input") as HTMLInputElement).value).toBe(
      "20"
    );
  });

  it("Tabのフォーカスは、ダイアログの中を回る", () => {
    render(dialogOf("prompt", "名前は?"));
    const field = container.querySelector("input") as HTMLInputElement;
    const ok = buttonNamed("OK");

    act(() => ok.focus());
    const forward = press(ok, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);

    const backward = press(field, "Tab", { shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ok);

    // 途中の要素では、ブラウザの既定の動きに任せる
    act(() => buttonNamed("キャンセル").focus());
    expect(press(buttonNamed("キャンセル"), "Tab").defaultPrevented).toBe(
      false
    );
  });

  it("まわりを押しても、フォーカスをダイアログから外さない", () => {
    render(dialogOf("confirm"));
    const backdrop = container.querySelector(
      "[data-browser-overlay]"
    ) as HTMLElement;
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      backdrop.dispatchEvent(down);
    });

    expect(down.defaultPrevented).toBe(true);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("どのページのものか分からなければ、見出しを決まった文言にする", () => {
    render(dialogOf("alert"), "");
    expect(container.textContent).toContain("ページからのメッセージ");
  });
});
