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
      nodes: [
        {
          id: "n1",
          label: "N",
          ext: { x: 40, y: 50, color: "blue" },
        },
      ],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.nodes[0]?.ext).toEqual({
        x: 40,
        y: 50,
        color: "blue",
      });
    }
  });

  it("noteText を label・fields と独立して保持する", () => {
    const result = parseDiagramModel(
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "memo",
            label: "Memo",
            kind: "note",
            noteText: "1行目\n2行目",
            fields: [{ id: "memo-id", label: "id" }],
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.nodes[0]).toMatchObject({
        label: "Memo",
        kind: "note",
        noteText: "1行目\n2行目",
        fields: [{ id: "memo-id", label: "id" }],
      });
    }
  });

  it("図全体の layout 設定と未知の情報を top-level ext に保持する", () => {
    const ext = {
      layout: {
        direction: "TB",
        rankSpacing: 80,
        nodeSpacing: 36,
        padding: 20,
        futureOption: "keep-me",
      },
      custom: { theme: "night" },
    };
    const result = parseDiagramModel(
      JSON.stringify({ version: 1, nodes: [], ext })
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.ext).toEqual(ext);
  });

  it.each([
    "invalid",
    null,
    [],
    42,
  ])("object でない top-level ext (%j) は undefined に正規化する", ext => {
    const result = parseDiagramModel(
      JSON.stringify({ version: 1, nodes: [], ext })
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.ext).toBeUndefined();
  });

  it("edge のセマンティクスを ext に保持する", () => {
    const ext = {
      from_card: "one",
      to_card: "zero-or-many",
      direction: "forward",
      type: "belongs-to",
    };
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { id: "order", label: "Order" },
        { id: "user", label: "User" },
      ],
      edges: [
        {
          id: "e_order_user",
          from: "order",
          to: "user",
          label: "belongs to",
          ext,
        },
      ],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.edges[0]?.ext).toEqual(ext);
  });

  it("任意の node kind を文字列のまま保持する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { id: "place-order", label: "Place order", kind: "command" },
        { id: "order-placed", label: "Order placed", kind: "event" },
        { id: "order-api", label: "Order API", kind: "service" },
      ],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.nodes.map(node => node.kind)).toEqual([
        "command",
        "event",
        "service",
      ]);
    }
  });

  it("group の label / nodes / ext を保持する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { id: "order", label: "Order" },
        { id: "user", label: "User" },
      ],
      groups: [
        {
          id: "ordering-context",
          label: "Ordering Context",
          nodes: ["order", "user"],
          ext: { role: "bounded-context" },
        },
      ],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.groups).toEqual([
        {
          id: "ordering-context",
          label: "Ordering Context",
          nodes: ["order", "user"],
          ext: { role: "bounded-context" },
        },
      ]);
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

  it("存在しないノードを含む group を拒否する", () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [{ id: "order", label: "Order" }],
      groups: [
        {
          id: "ordering-context",
          label: "Ordering Context",
          nodes: ["order", "missing"],
        },
      ],
    });

    const result = parseDiagramModel(json);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ordering-context");
      expect(result.error).toContain("missing");
    }
  });

  it("壊れた JSON を拒否する", () => {
    const result = parseDiagramModel("{ not json");

    expect(result.ok).toBe(false);
  });
});
