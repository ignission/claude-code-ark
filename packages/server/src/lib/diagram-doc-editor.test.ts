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
    // 意図は「編集層が自分で CSP meta を宣言しない」こと。素の語句一致だと
    // サーバーが配信時に足す CSP meta を保存前に剥がすための正しいセレクタ
    // （meta[http-equiv="Content-Security-Policy" i]、JS 文字列リテラルとして
    // ソースに残る）まで違反にしてしまうため、<meta ...> の形に絞る。
    expect(out).not.toMatch(/<meta[^>]+Content-Security-Policy/i);
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

  it("選択中クラスを除去して空になった class 属性ごと落とす", () => {
    // classList.remove だけだと class="" が残る。空の属性でもファイルの
    // git diff にノイズが出るので、空になったら属性ごと外す。
    const out = injectDiagramDocEditor(page);
    expect(out).toMatch(
      /classList\.remove\("ark-comment-anchor-active"\)[\s\S]{0,120}removeAttribute\("class"\)/
    );
  });

  it("送信前に編集層自身の痕跡（harness UI・contenteditable・wired 印・CSP meta）を剥がすロジックを持つ", () => {
    const out = injectDiagramDocEditor(page);
    expect(out).toContain('querySelectorAll("[data-ark-harness-ui]")');
    expect(out).toContain('removeAttribute("contenteditable")');
    expect(out).toContain('querySelectorAll("[data-ark-doc-wired]")');
    expect(out).toContain('meta[http-equiv="Content-Security-Policy" i]');
  });

  it("本文にマーカーの語がただのテキストとして含まれていても、本物の script タグが無ければ注入する", () => {
    // html.includes(MARKER) だけの判定だと、board の本文に偶然
    // 'ark-diagram-doc-editor' という語が書かれているだけで、以後その board は
    // 無言で編集不能になる。コメント層と同じく、実際に注入済みの script タグが
    // あるかどうかで判定する。
    const withMentionOnly = `<!doctype html><html><head></head><body><p data-ark-id="p1">${DIAGRAM_DOC_EDITOR_MARKER} という語がここにあります</p></body></html>`;
    const out = injectDiagramDocEditor(withMentionOnly);
    expect(out).toMatch(
      new RegExp(`<script[^>]*id="${DIAGRAM_DOC_EDITOR_MARKER}"`)
    );
  });
});
