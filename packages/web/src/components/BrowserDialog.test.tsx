// @vitest-environment jsdom

import type { BrowserDialogInfo } from "@ark/shared";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserDialog,
  DIALOG_KEY_GUARD_MS,
  PROMPT_MAX_LENGTH,
} from "./BrowserDialog";

let root: Root;
let container: HTMLDivElement;
const onRespond = vi.fn<(accept: boolean, promptText?: string) => void>();

/** `performance.now` が返す時刻。テストから進める */
let now = 1000;

type Extra = Partial<Parameters<typeof BrowserDialog>[0]>;

/**
 * 描いたあと、出た直後のキーを無視する時間が過ぎたところまで時刻を進める。
 * `settle: false` なら進めない。
 */
function render(
  dialog: BrowserDialogInfo,
  origin = "localhost:5173",
  { settle = true, ...extra }: Extra & { settle?: boolean } = {}
) {
  act(() =>
    root.render(
      <BrowserDialog
        dialog={dialog}
        origin={origin}
        onRespond={onRespond}
        {...extra}
      />
    )
  );
  if (settle) now += DIALOG_KEY_GUARD_MS;
}

function panel(): HTMLElement {
  return container.querySelector('[role="alertdialog"]') as HTMLElement;
}

function dialogOf(
  kind: BrowserDialogInfo["kind"],
  message = "よろしいですか?",
  defaultPrompt = ""
): BrowserDialogInfo {
  return { id: 1, kind, message, defaultPrompt };
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
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("BrowserDialog", () => {
  it("ペインの中のダイアログとして、どのページのものかを見出しに出す", () => {
    render(dialogOf("alert", "保存しました"));
    const dialog = container.querySelector('[role="alertdialog"]');

    // アプリの全体を止めるものではない (ツールバーは使える) ので、モーダルとは名乗らない
    expect(dialog?.hasAttribute("aria-modal")).toBe(false);
    const title = document.getElementById(
      dialog?.getAttribute("aria-labelledby") ?? ""
    );
    expect(title?.textContent).toBe("localhost:5173の内容");
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
    const backdrop = panel().parentElement as HTMLElement;
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

  it("出た直後 (300ms) のEnter、Space、Escapeは、応答にしない", () => {
    render(dialogOf("confirm"), "localhost:5173", { settle: false });
    const ok = buttonNamed("OK");
    now += DIALOG_KEY_GUARD_MS - 1;
    // 既定の動作 (ボタンを押す) も止める
    expect(press(ok, "Enter").defaultPrevented).toBe(true);
    expect(press(ok, " ").defaultPrevented).toBe(true);
    expect(press(ok, "Escape").defaultPrevented).toBe(true);
    expect(onRespond).not.toHaveBeenCalled();

    now += 1;
    expect(press(ok, "Enter").defaultPrevented).toBe(false);
    press(ok, "Escape");
    expect(onRespond.mock.calls).toEqual([[false]]);
  });

  it("押したままの繰り返しのキーは、応答にしない", () => {
    render(dialogOf("prompt", "名前は?", "太郎"));
    const field = container.querySelector("input") as HTMLInputElement;
    expect(press(field, "Enter", { repeat: true }).defaultPrevented).toBe(true);
    press(field, "Escape", { repeat: true });
    expect(
      press(buttonNamed("OK"), " ", { repeat: true }).defaultPrevented
    ).toBe(true);

    expect(onRespond).not.toHaveBeenCalled();
  });

  it("入力欄では、出た直後でも繰り返しでも、空白を打てる", () => {
    render(dialogOf("prompt", "名前は?"), "localhost:5173", { settle: false });
    const field = container.querySelector("input") as HTMLInputElement;

    expect(press(field, " ").defaultPrevented).toBe(false);
    expect(press(field, " ", { repeat: true }).defaultPrevented).toBe(false);
  });

  it("別のダイアログに替わったら、無視する時間を計り直す", () => {
    render(dialogOf("confirm", "1つめ"));
    render(dialogOf("confirm", "2つめ"), "localhost:5173", { settle: false });
    press(buttonNamed("OK"), "Escape");
    expect(onRespond).not.toHaveBeenCalled();

    // 同じダイアログの描き直しでは、計り直さない
    const same = dialogOf("confirm", "3つめ");
    render(same);
    render(same, "localhost:5173", { settle: false });
    press(buttonNamed("OK"), "Escape");
    expect(onRespond.mock.calls).toEqual([[false]]);
  });

  it("`focusMode` が `panel` なら、ボタンではなくダイアログの枠にフォーカスし、Enterでは応答しない", () => {
    const focusMode = vi.fn(() => "panel" as const);
    render(dialogOf("prompt", "名前は?", "太郎"), "localhost:5173", {
      focusMode,
    });

    expect(focusMode).toHaveBeenCalled();
    expect(panel().tabIndex).toBe(-1);
    expect(document.activeElement).toBe(panel());
    expect(press(panel(), "Enter").defaultPrevented).toBe(false);
    expect(onRespond).not.toHaveBeenCalled();

    // 枠からのTabは、中の最初と最後へ移る
    const back = press(panel(), "Tab", { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttonNamed("OK"));
    // Escapeは、枠にいても効く
    press(panel(), "Escape");
    expect(onRespond.mock.calls).toEqual([[false]]);
  });

  it("別のダイアログに替わったら、フォーカスを入れ直す", () => {
    render(dialogOf("alert", "1つめ"));
    act(() => (document.activeElement as HTMLElement).blur());
    render(dialogOf("confirm", "2つめ"));

    expect(document.activeElement).toBe(buttonNamed("OK"));
  });

  it("応答済みの間は、ボタンと入力欄を無効にし、キーでも応答しない", () => {
    const dialog = dialogOf("prompt", "名前は?", "太郎");
    render(dialog);
    render(dialog, "localhost:5173", { answered: true });
    const field = container.querySelector("input") as HTMLInputElement;

    expect(field.disabled).toBe(true);
    expect(buttons().map(el => el.disabled)).toEqual([true, true]);
    // フォーカスは、無効になった部品に残さず、枠へ移す
    expect(document.activeElement).toBe(panel());
    press(panel(), "Escape");
    press(panel(), "Enter");
    click(buttonNamed("OK"));
    expect(onRespond).not.toHaveBeenCalled();
    // 押せる部品が無い間のTabは、枠に留める
    expect(press(panel(), "Tab").defaultPrevented).toBe(true);

    // 別のダイアログに替わったら、また応答できる
    render(dialogOf("confirm", "次"), "localhost:5173", { answered: false });
    click(buttonNamed("OK"));
    expect(onRespond.mock.calls).toEqual([[true]]);
  });

  it("長すぎる `defaultPrompt` は、サーバーが受け取る長さに切り詰めて入力欄に入れる", () => {
    render(dialogOf("prompt", "長い?", "あ".repeat(PROMPT_MAX_LENGTH + 5)));
    const field = container.querySelector("input") as HTMLInputElement;

    expect(field.value).toHaveLength(PROMPT_MAX_LENGTH);
    click(buttonNamed("OK"));
    expect(onRespond.mock.calls[0][1]).toHaveLength(PROMPT_MAX_LENGTH);
  });

  it("変換を確定するEnterでは、`prompt` に応答しない", () => {
    render(dialogOf("prompt", "名前は?"));
    const field = container.querySelector("input") as HTMLInputElement;
    act(() => {
      field.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      );
    });
    press(field, "Enter", { isComposing: true, keyCode: 229 });
    // 変換を取り消すEscapeも、ダイアログの取り消しにしない
    press(field, "Escape", { isComposing: true, keyCode: 229 });

    expect(onRespond).not.toHaveBeenCalled();
  });

  it.each([
    ["Enter", { isComposing: true }],
    ["Enter", { keyCode: 229 }],
    ["Escape", { isComposing: true }],
    ["Escape", { keyCode: 229 }],
  ] as const)(
    "変換の始まりを受け取っていなくても、変換中の%s (%o) では `prompt` に応答しない",
    (key, init) => {
      render(dialogOf("prompt", "名前は?", "太郎"));
      const field = container.querySelector("input") as HTMLInputElement;

      press(field, key, init);

      expect(onRespond).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(field);
    }
  );

  it("`StrictMode` でも、フォーカスを取り、1回の操作で1回だけ応答する", () => {
    act(() =>
      root.render(
        <StrictMode>
          <BrowserDialog
            dialog={dialogOf("prompt", "名前は?", "太郎")}
            origin="localhost:5173"
            onRespond={onRespond}
          />
        </StrictMode>
      )
    );
    now += DIALOG_KEY_GUARD_MS;
    const field = container.querySelector("input") as HTMLInputElement;

    expect(document.activeElement).toBe(field);
    press(field, "Enter");
    expect(onRespond.mock.calls).toEqual([[true, "太郎"]]);
  });
});
