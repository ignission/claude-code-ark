import { describe, expect, it } from "vitest";
import {
  type DiagramLayoutInput,
  type DiagramLayoutRect,
  layoutDiagram,
} from "./diagram-layout.js";

const fixture = (direction: "LR" | "TB" = "LR"): DiagramLayoutInput => ({
  direction,
  rankSpacing: 72,
  nodeSpacing: 32,
  padding: 20,
  nodes: [
    { id: "cart", index: 0, width: 148, height: 64 },
    { id: "cart_item", index: 1, width: 176, height: 152 },
    { id: "order", index: 2, width: 160, height: 96 },
    { id: "order_line", index: 3, width: 184, height: 224 },
    { id: "stock", index: 4, width: 152, height: 96 },
    { id: "stock_event", index: 5, width: 132, height: 64 },
    { id: "customer", index: 6, width: 144, height: 96 },
    { id: "policy", index: 7, width: 168, height: 152 },
  ],
  edges: [
    { from: "cart", to: "cart_item" },
    { from: "order", to: "order_line" },
    { from: "stock", to: "stock_event" },
    { from: "cart_item", to: "order" },
    { from: "order_line", to: "stock" },
    { from: "customer", to: "cart" },
    { from: "stock_event", to: "policy" },
    { from: "policy", to: "policy" },
  ],
  groups: [
    {
      id: "cart_group",
      index: 0,
      nodes: ["cart", "cart_item"],
      outsets: { left: 12, top: 28, right: 16, bottom: 14 },
    },
    {
      id: "order_group",
      index: 1,
      nodes: ["order", "order_line"],
      outsets: { left: 20, top: 34, right: 20, bottom: 18 },
    },
    {
      id: "stock_group",
      index: 2,
      nodes: ["stock", "stock_event"],
      outsets: { left: 10, top: 24, right: 12, bottom: 12 },
    },
  ],
});

function rects(input: DiagramLayoutInput) {
  const result = layoutDiagram(input);
  const size = Object.fromEntries(
    input.nodes.map(node => [
      node.id,
      { width: node.width, height: node.height },
    ])
  );
  return {
    result,
    nodes: Object.fromEntries(
      Object.entries(result.positions).map(([id, point]) => [
        id,
        { ...point, ...size[id] },
      ])
    ) as Record<string, DiagramLayoutRect>,
  };
}

function expectDisjoint(entries: Array<[string, DiagramLayoutRect]>, gap = 0) {
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftId, a] = entries[left];
      const [rightId, b] = entries[right];
      const collide =
        a.x < b.x + b.width + gap &&
        a.x + a.width + gap > b.x &&
        a.y < b.y + b.height + gap &&
        a.y + a.height + gap > b.y;
      expect(collide, `${leftId} と ${rightId} が重なっています`).toBe(false);
    }
  }
}

function expectContains(
  container: DiagramLayoutRect,
  member: DiagramLayoutRect
) {
  expect(container.x).toBeLessThanOrEqual(member.x);
  expect(container.y).toBeLessThanOrEqual(member.y);
  expect(container.x + container.width).toBeGreaterThanOrEqual(
    member.x + member.width
  );
  expect(container.y + container.height).toBeGreaterThanOrEqual(
    member.y + member.height
  );
}

describe("layoutDiagram", () => {
  it.each([
    "LR",
    "TB",
  ] as const)("%s で可変高 node と cluster の全矩形を重ねず member を保持する", direction => {
    const input = fixture(direction);
    const { result, nodes } = rects(input);

    expect(result.fallback).toBeNull();
    expectDisjoint(Object.entries(nodes));
    for (const group of input.groups) {
      const geometry = result.groups[group.id];
      for (const id of group.nodes) {
        expectContains(geometry.member, nodes[id]);
      }
      for (const node of input.nodes.filter(
        node => !group.nodes.includes(node.id)
      )) {
        const center = {
          x: nodes[node.id].x + nodes[node.id].width / 2,
          y: nodes[node.id].y + nodes[node.id].height / 2,
        };
        expect(
          center.x > geometry.member.x &&
            center.x < geometry.member.x + geometry.member.width &&
            center.y > geometry.member.y &&
            center.y < geometry.member.y + geometry.member.height,
          `${node.id} が ${group.id} の member hull に侵入しています`
        ).toBe(false);
      }
    }
    expectDisjoint(
      result.units.map(unit => [unit.id, unit.rect]),
      input.nodeSpacing
    );
  });

  it.each([
    "LR",
    "TB",
  ] as const)("%s で内部 edge と cross edge を別の rank に反映する", direction => {
    const { result, nodes } = rects(fixture(direction));
    const primary = direction === "LR" ? "x" : "y";
    expect(nodes.cart_item[primary]).toBeGreaterThan(nodes.cart[primary]);
    expect(result.groups.order_group.outer[primary]).toBeGreaterThan(
      result.groups.cart_group.outer[primary]
    );
    expect(result.groups.stock_group.outer[primary]).toBeGreaterThan(
      result.groups.order_group.outer[primary]
    );
  });

  it("cycle・self-edge・重複 edge があっても決定的で入力を mutate しない", () => {
    const input = fixture();
    input.edges.push(
      { from: "stock_event", to: "stock" },
      { from: "cart", to: "cart_item" },
      { from: "cart", to: "cart_item" }
    );
    const original = structuredClone(input);
    const reversedEdges = {
      ...input,
      edges: [...input.edges].reverse(),
    };

    expect(layoutDiagram(input)).toEqual(layoutDiagram(input));
    expect(layoutDiagram(reversedEdges)).toEqual(layoutDiagram(input));
    expect(input).toEqual(original);
  });

  it("manual 座標を固定し auto node / cluster を obstacle の外へ送る", () => {
    const input = fixture();
    input.nodes[0].manual = { x: 260, y: 180 };
    input.nodes[6].manual = { x: 20, y: 20 };
    input.nodes[7].manual = { x: 20, y: 20 };
    const { result } = rects(input);

    expect(result.positions.cart).toEqual({ x: 260, y: 180 });
    expect(result.positions.customer).toEqual({ x: 20, y: 20 });
    expect(result.positions.policy).toEqual({ x: 20, y: 20 });
    expectDisjoint(
      result.units
        .filter(unit => unit.id !== "node:policy")
        .map(unit => [unit.id, unit.rect]),
      input.nodeSpacing
    );
  });

  it.each([
    {
      mutate: (input: DiagramLayoutInput) => {
        input.groups[0].nodes = [];
      },
      reason: "empty-group",
    },
    {
      mutate: (input: DiagramLayoutInput) => {
        input.groups[0].nodes.push("missing");
      },
      reason: "missing-member",
    },
    {
      mutate: (input: DiagramLayoutInput) => {
        input.groups[1].nodes.push("cart");
      },
      reason: "duplicate-membership",
    },
  ] as const)("不正 group を $reason fallback にする", ({ mutate, reason }) => {
    const input = fixture();
    mutate(input);
    expect(layoutDiagram(input).fallback).toBe(reason);
  });
});
