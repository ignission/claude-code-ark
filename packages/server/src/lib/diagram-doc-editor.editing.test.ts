/**
 * DOC_EDITOR_LAYER のランタイム挙動を、実際に配信される（圧縮済みの）script で
 * 検証する。injectDiagramDocEditor() の出力からそのまま script を取り出して
 * 評価するため、minify が挙動を壊す種類のバグもここで捕まる。
 *
 * テストごとに独立した JSDOM window を新規に作る。委譲 listener は document に
 * 1つだけ付くため、window/document を使い回すとテストをまたいで listener が
 * 残り、二重発火系のバグを隠してしまう（#4）。
 */
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  DIAGRAM_DOC_EDITOR_MARKER,
  injectDiagramDocEditor,
} from "./diagram-doc-editor.js";

/** injectDiagramDocEditor() の出力から、実際に配信される script 本文を取り出す。 */
function extractInjectedScript(html: string): string {
  const idAttr = `id="${DIAGRAM_DOC_EDITOR_MARKER}"`;
  const idIndex = html.indexOf(idAttr);
  if (idIndex < 0) throw new Error("編集層が注入されていません");
  const tagEnd = html.indexOf(">", idIndex) + 1;
  const closeIndex = html.indexOf("</script>", tagEnd);
  if (tagEnd <= 0 || closeIndex < 0) {
    throw new Error("script タグの境界を特定できません");
  }
  return html.slice(tagEnd, closeIndex);
}

/**
 * 実際に配信される（圧縮済みの）script を、独立した JSDOM window 上で評価する。
 * bodyHtml・headExtra を injectDiagramDocEditor() に通してから script を
 * 取り出すので、常に「配信される成果物」を評価する。
 */
function runInjectedDocEditor(bodyHtml: string, headExtra = "") {
  const page = `<!doctype html><html><head>${headExtra}</head><body>${bodyHtml}</body></html>`;
  const injected = injectDiagramDocEditor(page);
  const script = extractInjectedScript(injected);
  const dom = new JSDOM(page, { runScripts: "dangerously" });
  // biome-ignore lint/suspicious/noExplicitAny: jsdom の Window 型は eval を持たない
  (dom.window as any).eval(script);
  if (dom.window.document.readyState === "loading") {
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  }
  return dom;
}

describe("DOC_EDITOR_LAYER の contenteditable 配線", () => {
  it("入れ子ブロックでは最内側の葉だけを編集可能にし、入力しても葉だけが human になる", () => {
    const dom = runInjectedDocEditor(
      '<main data-ark-id="s1" data-ark-author="claude">' +
        '<table data-ark-id="s1-t1">' +
        '<tr data-ark-id="s1-t1-r1">' +
        '<td data-ark-id="s1-t1-r1-c1">x</td>' +
        "</tr>" +
        "</table>" +
        "</main>"
    );
    const { document } = dom.window;
    const root = document.querySelector('[data-ark-id="s1"]') as HTMLElement;
    const table = document.querySelector(
      '[data-ark-id="s1-t1"]'
    ) as HTMLElement;
    const row = document.querySelector(
      '[data-ark-id="s1-t1-r1"]'
    ) as HTMLElement;
    const leaf = document.querySelector(
      '[data-ark-id="s1-t1-r1-c1"]'
    ) as HTMLElement;

    expect(leaf.contentEditable).toBe("true");
    expect(root.contentEditable).not.toBe("true");
    expect(table.contentEditable).not.toBe("true");
    expect(row.contentEditable).not.toBe("true");

    leaf.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    expect(leaf.getAttribute("data-ark-author")).toBe("human");
    expect(root.getAttribute("data-ark-author")).toBe("claude");
    expect(table.hasAttribute("data-ark-author")).toBe(false);
    expect(row.hasAttribute("data-ark-author")).toBe(false);
  });
});

describe("DOC_EDITOR_LAYER の貼り付け・ドロップ処理", () => {
  it("貼り付けは inline style 等を持ち込まず plain text だけを挿入する（execCommand が使える場合）", () => {
    const dom = runInjectedDocEditor('<p data-ark-id="p1">x</p>');
    const { document } = dom.window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    const execCommand = vi.fn().mockReturnValue(true);
    // jsdom は execCommand を実装していない（本番のブラウザには存在する）
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = execCommand;

    const pasteEvent = new dom.window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "plain pasted text" },
    });
    leaf.dispatchEvent(pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(execCommand).toHaveBeenCalledWith(
      "insertText",
      false,
      "plain pasted text"
    );
  });

  it("execCommand が false を返す/例外を投げるときは Selection API で直接挿入する", () => {
    const dom = runInjectedDocEditor('<p data-ark-id="p1">before</p>');
    const { document } = dom.window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = vi.fn().mockReturnValue(false);

    const textNode = leaf.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, textNode.textContent?.length ?? 0);
    range.setEnd(textNode, textNode.textContent?.length ?? 0);
    const selection = dom.window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const pasteEvent = new dom.window.Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "PASTED" },
    });
    leaf.dispatchEvent(pasteEvent);

    expect(leaf.textContent).toBe("beforePASTED");
  });

  it("ドロップも paste と同じく inline style 等を持ち込まず plain text だけを挿入する", () => {
    const dom = runInjectedDocEditor('<p data-ark-id="p1">x</p>');
    const { document } = dom.window;
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    const execCommand = vi.fn().mockReturnValue(true);
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = execCommand;

    const dropEvent = new dom.window.Event("drop", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { getData: () => "dropped text" },
    });
    leaf.dispatchEvent(dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(execCommand).toHaveBeenCalledWith(
      "insertText",
      false,
      "dropped text"
    );
  });
});

describe("submissionHtml() の焼き付き防止（実際の submit 経路で検証）", () => {
  it("著者バッジ・引用ハイライト・選択中クラス・CSP meta・contenteditable・wired 印を1つも残さず、本文は保持する", () => {
    const dom = runInjectedDocEditor(
      '<script type="application/json" id="ark-diagram-model">' +
        '{"version":1,"nodes":[{"id":"p1"}]}' +
        "</script>" +
        '<p data-ark-id="p1" class="ark-comment-anchor-active">' +
        '<span class="ark-author-badge" data-ark-harness-ui="1" data-author="claude">Claude</span>' +
        "見出しの" +
        '<span class="ark-comment-highlight" data-thread-id="t1" data-ark-comment-owned="true" data-active="false">本文</span>' +
        "です</p>",
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">'
    );
    const { window } = dom;
    const { document } = window;

    const fakePort = { start: vi.fn(), postMessage: vi.fn() };
    const initEvent = new window.MessageEvent("message", {
      data: { type: "ark:diagram-init" },
    });
    Object.defineProperty(initEvent, "ports", { value: [fakePort] });
    window.dispatchEvent(initEvent);

    const submitButton = document.querySelector(
      "#ark-doc-bar button"
    ) as HTMLElement;
    submitButton.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(fakePort.postMessage).toHaveBeenCalledTimes(1);
    const message = fakePort.postMessage.mock.calls[0]?.[0] as {
      type: string;
      html: string;
    };
    expect(message.type).toBe("ark:diagram-submit");
    const html = message.html;

    expect(html).not.toContain("ark-author-badge");
    expect(html).not.toContain("ark-comment-highlight");
    expect(html).not.toContain("data-ark-comment-owned");
    expect(html).not.toContain("ark-comment-anchor-active");
    expect(html).not.toContain("contenteditable");
    expect(html).not.toContain("data-ark-doc-wired");
    expect(html).not.toContain("data-ark-harness-ui");
    expect(html).not.toContain(DIAGRAM_DOC_EDITOR_MARKER);
    expect(html).not.toMatch(/<meta[^>]+Content-Security-Policy/i);
    expect(html).not.toMatch(/class=""/);

    // ハイライト span を剥がすときに中身ごと落としていないか
    expect(html).toContain("見出しの本文です");
  });
});
