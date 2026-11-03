// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { focusInput } from "./focus-input";

function mount({ terminalOpen = false } = {}) {
  document.body.innerHTML = `
    <div class="hidden"><textarea data-focus-target="chat-input" id="other-input"></textarea></div>
    <textarea data-focus-target="chat-input" id="input"></textarea>
    <div class="${terminalOpen ? "" : "hidden"}">
      <div data-focus-target="terminal-window" tabindex="-1">
        <iframe data-focus-target="terminal"></iframe>
      </div>
    </div>
  `;
}

const focusedTarget = () =>
  document.activeElement?.getAttribute("data-focus-target");

describe("focusInput", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("端末の窓が閉じていれば、見えている会話の入力欄に置く", () => {
    mount();
    focusInput(document);
    expect(document.activeElement?.id).toBe("input");
  });

  it("端末の窓が開いていれば、端末に置く", () => {
    mount({ terminalOpen: true });
    focusInput(document);
    expect(document.activeElement?.tagName).toBe("IFRAME");
  });

  it("窓が開いているのに端末がまだ無ければ、窓そのものに置く (会話の入力欄へは置かない)", () => {
    mount({ terminalOpen: true });
    document.querySelector('iframe[data-focus-target="terminal"]')?.remove();
    document.getElementById("input")?.focus();

    focusInput(document);

    expect(focusedTarget()).toBe("terminal-window");
  });

  it("端末がフォーカスを受けられないときも、会話の入力欄ではなく窓に置く", () => {
    mount({ terminalOpen: true });
    const iframe = document.querySelector<HTMLElement>(
      'iframe[data-focus-target="terminal"]'
    );
    // フォーカスを受けられない端末 (display:none の中) を、focus が効かないことで表す
    if (iframe) iframe.focus = () => undefined;
    document.getElementById("input")?.focus();

    focusInput(document);

    expect(focusedTarget()).toBe("terminal-window");
  });
});
