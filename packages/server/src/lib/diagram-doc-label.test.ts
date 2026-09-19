import { describe, expect, it } from "vitest";
import { refreshDocLabels } from "./diagram-doc-label.js";
import type { DiagramModel } from "./diagram-model.js";

const docModel = (label: string): DiagramModel =>
  ({
    version: 1,
    type: "doc",
    title: "t",
    nodes: [{ id: "p1", label, kind: "paragraph" }],
    edges: [],
    groups: [],
  }) as DiagramModel;

describe("refreshDocLabels", () => {
  it("本文から抜粋を作り直す", () => {
    const html = `<p data-ark-id="p1">あたらしい本文</p>`;
    expect(refreshDocLabels(docModel("ふるい抜粋"), html).nodes[0]?.label).toBe(
      "あたらしい本文"
    );
  });

  it("80文字で切る", () => {
    const html = `<p data-ark-id="p1">${"あ".repeat(120)}</p>`;
    expect(refreshDocLabels(docModel("x"), html).nodes[0]?.label).toBe(
      `${"あ".repeat(79)}…`
    );
  });

  it("本文が空のブロックは label を変えない", () => {
    const html = `<p data-ark-id="p1"></p>`;
    expect(refreshDocLabels(docModel("のこす"), html).nodes[0]?.label).toBe(
      "のこす"
    );
  });

  it("doc でないモデルは同じ参照を返す", () => {
    const model = { ...docModel("x"), type: "flow" } as DiagramModel;
    expect(refreshDocLabels(model, `<p data-ark-id="p1">かわらない</p>`)).toBe(
      model
    );
  });

  it("容器ブロックの label は子孫本文のこだまで上書きしない", () => {
    // extractDocBlocks は容器 (子孫に別の data-ark-id を持つ要素) の text を
    // 子孫本文の連結にする。容器の label をそれで上書きすると、人間が書いた
    // 見出し的な label が子孫の地の文で静かに消える
    const html = `<section data-ark-id="s1"><p data-ark-id="s1-p1">あたらしい段落</p></section>`;
    const model: DiagramModel = {
      version: 1,
      type: "doc",
      nodes: [
        { id: "s1", label: "ふるい容器ラベル" },
        { id: "s1-p1", label: "ふるい段落ラベル" },
      ],
      edges: [],
      groups: [],
    };
    const refreshed = refreshDocLabels(model, html);
    expect(refreshed.nodes.find(n => n.id === "s1")?.label).toBe(
      "ふるい容器ラベル"
    );
    expect(refreshed.nodes.find(n => n.id === "s1-p1")?.label).toBe(
      "あたらしい段落"
    );
  });
});
