import { describe, expect, it } from "vitest";
import { validateDiagramGraphKinds } from "./diagram-graph-kinds.js";
import type { DiagramModel } from "./diagram-model.js";

function model(): DiagramModel {
  return {
    version: 1,
    nodes: [
      { id: "x", label: "X", kind: "b" },
      { id: "without-kind", label: "Kind 未定義" },
    ],
    edges: [],
    groups: [],
  };
}

describe("validateDiagramGraphKinds", () => {
  it("投影の data-kind が model の node.kind と異なる場合は違反にする", () => {
    const result = validateDiagramGraphKinds(
      '<article data-model-id="x" data-kind="a">X</article>',
      model()
    );

    expect(result.ok).toBe(false);
  });

  it("同じ node の複数投影のうち片方だけ異なる場合も違反にする", () => {
    const result = validateDiagramGraphKinds(
      '<article data-model-id="x" data-kind="b"><h2 data-model-id="x" data-kind="a">X</h2></article>',
      model()
    );

    expect(result.ok).toBe(false);
  });

  it("data-kind を持たない data-model-id 要素は違反にしない", () => {
    expect(
      validateDiagramGraphKinds('<li data-model-id="x">field</li>', model())
    ).toEqual({ ok: true });
  });

  it("node として解決できない data-model-id は違反にしない", () => {
    const html =
      '<path data-model-id="edge-1" data-kind="edge"></path>' +
      '<li data-model-id="x--f1" data-kind="field"></li>' +
      '<i data-model-id="unknown" data-kind="mystery"></i>';

    expect(validateDiagramGraphKinds(html, model())).toEqual({ ok: true });
  });

  it("node.kind が未定義の要素は違反にしない", () => {
    expect(
      validateDiagramGraphKinds(
        '<article data-model-id="without-kind" data-kind="note"></article>',
        model()
      )
    ).toEqual({ ok: true });
  });

  it("すべての data-kind が node.kind と一致する図は成功する", () => {
    const html =
      '<article data-model-id="x" data-kind="b">' +
      '<h2 data-model-id="x" data-kind="b">X</h2>' +
      '<li data-model-id="x--f1">field</li></article>';

    expect(validateDiagramGraphKinds(html, model())).toEqual({ ok: true });
  });

  it("エラーに node id と model・投影両側の値を含める", () => {
    const result = validateDiagramGraphKinds(
      '<article data-model-id="x" data-kind="a">X</article>',
      model()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("x");
      expect(result.error).toContain("a");
      expect(result.error).toContain("b");
      expect(result.error).toContain("model");
      expect(result.error).toContain("投影");
    }
  });
});
