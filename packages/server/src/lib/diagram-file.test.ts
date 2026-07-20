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
});
