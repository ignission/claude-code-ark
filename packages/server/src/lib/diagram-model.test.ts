import { describe, expect, it } from "vitest";
import { parseDiagramModel } from "./diagram-model.js";

describe("parseDiagramModel", () => {
  it("コア語彙のモデルを受け付ける", () => {
    const json = JSON.stringify({
      version: 1,
      title: "購買フロー",
      nodes: [
        {
          id: "order",
          label: "Order",
          fields: [
            { id: "f_id", label: "id" },
            { id: "f_status", label: "status" },
          ],
        },
      ],
      edges: [{ id: "e1", from: "order", to: "order", label: "self" }],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.title).toBe("購買フロー");
      expect(result.model.nodes[0]?.fields?.[1]?.label).toBe("status");
    }
  });

  it("図種固有の情報は ext に保持する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [{ id: "n1", label: "N", ext: { cardinality: "1..N" } }],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.nodes[0]?.ext).toEqual({ cardinality: "1..N" });
    }
  });

  it("id が重複するモデルを拒否する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { id: "dup", label: "A" },
        { id: "dup", label: "B" },
      ],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("dup");
  });

  it("存在しないノードを指す edge を拒否する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [{ id: "a", label: "A" }],
      edges: [{ id: "e1", from: "a", to: "missing" }],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("missing");
  });

  it("壊れた JSON を拒否する", () => {
    const result = parseDiagramModel("{ not json");

    expect(result.ok).toBe(false);
  });
});
