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
});
