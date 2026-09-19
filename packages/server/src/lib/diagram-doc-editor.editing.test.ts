// @vitest-environment jsdom
/**
 * DOC_EDITOR_LAYER のランタイム挙動そのものを jsdom 上で検証する。
 * 他の diagram-doc-editor.test.ts は注入後の文字列だけを見る静的検査だが、
 * 「入れ子ブロックで祖先まで human に上書きされないか」は文字列検査では
 * 守れない（#C-1）ため、ここだけ実際に script を評価し DOM イベントを起こす。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOC_EDITOR_LAYER } from "./diagram-doc-editor.js";

const scriptContentStart = DOC_EDITOR_LAYER.indexOf(">") + 1;
const scriptContentEnd = DOC_EDITOR_LAYER.lastIndexOf("</script>");
const RAW_SCRIPT = DOC_EDITOR_LAYER.slice(scriptContentStart, scriptContentEnd);

/** DOC_EDITOR_LAYER の生 JS を素の document/window に対して評価する。 */
function evalDocEditor(): void {
  // 注入層自身のソース（自分たちの定数、外部入力ではない）をそのまま評価する
  new Function(RAW_SCRIPT)();
  if (document.readyState === "loading") {
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("DOC_EDITOR_LAYER の contenteditable 配線", () => {
  it("入れ子ブロックでは最内側の葉だけを編集可能にし、入力しても葉だけが human になる", () => {
    document.body.innerHTML =
      '<main data-ark-id="s1" data-ark-author="claude">' +
      '<table data-ark-id="s1-t1">' +
      '<tr data-ark-id="s1-t1-r1">' +
      '<td data-ark-id="s1-t1-r1-c1">x</td>' +
      "</tr>" +
      "</table>" +
      "</main>";
    evalDocEditor();

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

    // 葉だけが contenteditable。祖先は編集ホストにならない
    expect(leaf.contentEditable).toBe("true");
    expect(root.contentEditable).not.toBe("true");
    expect(table.contentEditable).not.toBe("true");
    expect(row.contentEditable).not.toBe("true");

    // 葉に input を起こす（bubbles: true で document の delegated listener まで届かせる）
    leaf.dispatchEvent(new Event("input", { bubbles: true }));

    expect(leaf.getAttribute("data-ark-author")).toBe("human");
    // 祖先の data-ark-author は書き換わらない（#C-1 の再発防止）
    expect(root.getAttribute("data-ark-author")).toBe("claude");
    expect(table.hasAttribute("data-ark-author")).toBe(false);
    expect(row.hasAttribute("data-ark-author")).toBe(false);
  });
});

describe("DOC_EDITOR_LAYER の貼り付け処理", () => {
  it("貼り付けは inline style 等を持ち込まず plain text だけを挿入する", () => {
    document.body.innerHTML = '<p data-ark-id="p1">x</p>';
    evalDocEditor();
    const leaf = document.querySelector('[data-ark-id="p1"]') as HTMLElement;
    // jsdom は execCommand を実装していない（本番のブラウザには存在する）ので
    // テスト用に自前で生やして spy する。
    const execCommand = vi.fn().mockReturnValue(true);
    // biome-ignore lint/suspicious/noExplicitAny: jsdom Document 型に無いテスト用スタブ
    (document as any).execCommand = execCommand;

    const pasteEvent = new Event("paste", {
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
});
