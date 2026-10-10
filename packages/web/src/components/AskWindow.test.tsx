// @vitest-environment jsdom

import type { AskState } from "@ark/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskWindow, type AskWindowProps } from "./AskWindow";

let container: HTMLDivElement;
let root: Root;

const EMPTY: AskState = { messages: [], busy: false, error: null };

function render(overrides: Partial<AskWindowProps> = {}) {
  const props: AskWindowProps = {
    state: EMPTY,
    sendError: null,
    focusSeq: 1,
    onSend: vi.fn(),
    onReset: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<AskWindow {...props} />));
  return props;
}
const input = () => document.querySelector<HTMLTextAreaElement>("textarea");
function type(text: string) {
  const el = input();
  if (!el) throw new Error("no input");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    input()?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    );
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("AskWindow", () => {
  it("開いたら入力欄にフォーカスを置き、開き直すたびに置き直す", () => {
    const props = render();
    expect(document.activeElement).toBe(input());
    input()?.blur();
    render({ ...props, focusSeq: 2 });
    expect(document.activeElement).toBe(input());
  });

  it("ダイアログにしない (後ろの画面とノーマルモードのキーを止めない)", () => {
    render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("[data-ask-window]")).not.toBeNull();
  });

  it("発話を並べ、Claude の答えは Markdown として描く", () => {
    render({
      state: {
        messages: [
          { id: "u1", role: "user", text: "一覧にして" },
          { id: "a1", role: "assistant", text: "- **太字**の項目" },
        ],
        busy: false,
        error: null,
      },
    });
    expect(document.querySelector('[data-role="user"]')?.textContent).toBe(
      "一覧にして"
    );
    expect(
      document.querySelector('[data-role="assistant"] li strong')?.textContent
    ).toBe("太字");
  });

  it("答えを待つ間は、その旨を出す", () => {
    render({ state: { ...EMPTY, busy: true } });
    expect(document.body.textContent).toContain("考えています");
  });

  it("失敗を出す (送る前に弾かれた理由を先に)", () => {
    render({
      state: { ...EMPTY, error: "裏の Claude が起動しませんでした" },
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "裏の Claude が起動しませんでした"
    );
    render({
      state: { ...EMPTY, error: "裏の Claude が起動しませんでした" },
      sendError: "サーバーに未接続です",
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "サーバーに未接続です"
    );
  });

  it("Enter で続けて聞き、入力欄を空にする", () => {
    const props = render();
    type("  もう少し詳しく  ");
    press("Enter");
    expect(props.onSend).toHaveBeenCalledWith("もう少し詳しく");
    expect(input()?.value).toBe("");
  });

  it("空の文と、変換の確定の Enter では送らない", () => {
    const props = render();
    press("Enter");
    type("にほんご");
    press("Enter", { isComposing: true });
    expect(props.onSend).not.toHaveBeenCalled();
    expect(input()?.value).toBe("にほんご");
  });

  it("Esc で閉じ、「新しく聞く」でまっさらにする", () => {
    const props = render({
      state: {
        messages: [{ id: "u1", role: "user", text: "やあ" }],
        busy: false,
        error: null,
      },
    });
    document
      .querySelector<HTMLButtonElement>('button[aria-label="新しく聞く"]')
      ?.click();
    expect(props.onReset).toHaveBeenCalledTimes(1);
    press("Escape");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("会話が無いときは「新しく聞く」を押せない", () => {
    render();
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="新しく聞く"]'
      )?.disabled
    ).toBe(true);
  });
});
