import { describe, expect, it } from "vitest";
import {
  DIAGRAM_DOC_EDITOR_MARKER,
  injectDiagramDocEditor,
} from "./diagram-doc-editor.js";

const page = `<!doctype html><html><head></head><body><p data-ark-id="p1">本文</p></body></html>`;

describe("injectDiagramDocEditor", () => {
  it("</body> の前に編集層を差し込む", () => {
    const out = injectDiagramDocEditor(page);
    expect(out).toContain(DIAGRAM_DOC_EDITOR_MARKER);
    expect(out.indexOf(DIAGRAM_DOC_EDITOR_MARKER)).toBeLessThan(
      out.indexOf("</body>")
    );
  });

  it("二重に注入しない", () => {
    const once = injectDiagramDocEditor(page);
    expect(injectDiagramDocEditor(once)).toBe(once);
  });

  it("注入する script に data-ark-harness-ui を付ける", () => {
    expect(injectDiagramDocEditor(page)).toMatch(
      new RegExp(
        `<script[^>]*id="${DIAGRAM_DOC_EDITOR_MARKER}"[^>]*data-ark-harness-ui="1"`
      )
    );
  });

  it("外部リソースを参照しない", () => {
    const out = injectDiagramDocEditor(page);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/Content-Security-Policy/i);
  });

  it("注入後のサイズが 48KiB 未満に収まる", () => {
    expect(
      Buffer.byteLength(injectDiagramDocEditor(page), "utf8")
    ).toBeLessThan(48 * 1024);
  });

  it("コメント層が本文へ直接書き込む引用ハイライトと選択中クラスを送信前に剥がす", () => {
    // コメント層はこれまで読み取り専用の上に乗るだけだったので、本文へ書く
    // ark-comment-highlight span や ark-comment-anchor-active class は
    // data-ark-harness-ui が無くても焼き付かなかった。doc が編集可能になった今は
    // submissionHtml() 側でこれらも剥がす必要がある（診断は静的な文字列検査で行う。
    // 本ファイルの他のテストと同じくランタイム DOM は実行しない）。
    const out = injectDiagramDocEditor(page);
    expect(out).toContain(
      'ark-comment-highlight[data-ark-comment-owned="true"]'
    );
    expect(out).toContain("ark-comment-anchor-active");
  });
});
