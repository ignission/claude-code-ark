import { describe, expect, it } from "vitest";
import { expandElements, type SimpleElement } from "./board-element-codec.js";

// 決定的な rng（seed/versionNonce をテストで固定するため）
const fixedRng = () => 0.5;

describe("expandElements", () => {
  it("rect を正規要素に展開し必須フィールドを埋める", () => {
    const simple: SimpleElement[] = [
      { type: "rect", id: "r1", x: 10, y: 20, w: 100, h: 50 },
    ];
    const { elements, skipped } = expandElements(simple, {
      startIndex: 0,
      rng: fixedRng,
    });
    expect(skipped).toEqual([]);
    expect(elements).toHaveLength(1);
    const el = elements[0] as Record<string, unknown>;
    expect(el.id).toBe("r1");
    expect(el.type).toBe("rectangle");
    expect(el).toMatchObject({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      isDeleted: false,
      locked: false,
    });
    // Excalidraw 必須フィールドが存在する
    for (const k of [
      "angle",
      "strokeColor",
      "backgroundColor",
      "fillStyle",
      "strokeWidth",
      "strokeStyle",
      "roughness",
      "opacity",
      "groupIds",
      "frameId",
      "index",
      "roundness",
      "seed",
      "version",
      "versionNonce",
      "boundElements",
      "updated",
      "link",
    ]) {
      expect(el).toHaveProperty(k);
    }
    expect(el.index).toBe("a0");
  });

  it("rect の text はシェイプ + 中央寄せ text 要素の2つに展開する", () => {
    const { elements } = expandElements(
      [{ type: "rect", id: "r1", x: 0, y: 0, w: 100, h: 40, text: "API" }],
      { startIndex: 0, rng: fixedRng }
    );
    expect(elements).toHaveLength(2);
    const text = elements.find(
      e => (e as Record<string, unknown>).type === "text"
    ) as Record<string, unknown>;
    expect(text.text).toBe("API");
    // rect の中央付近に配置
    expect(text.x).toBe(41);
  });

  it("arrow を from/to シェイプの中心で結ぶ（同一バッチ内の id を解決）", () => {
    const simple: SimpleElement[] = [
      { type: "rect", id: "a", x: 0, y: 0, w: 100, h: 40 },
      { type: "rect", id: "b", x: 300, y: 0, w: 100, h: 40 },
      { type: "arrow", id: "ar1", from: "a", to: "b" },
    ];
    const { elements, skipped } = expandElements(simple, {
      startIndex: 0,
      rng: fixedRng,
    });
    expect(skipped).toEqual([]);
    const arrow = elements.find(
      e => (e as Record<string, unknown>).type === "arrow"
    ) as Record<string, unknown>;
    expect(arrow).toBeTruthy();
    expect((arrow.startBinding as Record<string, unknown>).elementId).toBe("a");
    expect((arrow.endBinding as Record<string, unknown>).elementId).toBe("b");
    expect(Array.isArray(arrow.points)).toBe(true);
  });

  it("解決できない参照や未知 type は skipped に入れ scene を壊さない", () => {
    const { elements, skipped } = expandElements(
      [
        { type: "arrow", id: "bad", from: "x", to: "y" },
        { type: "star" as unknown as "rect", id: "u1", x: 0, y: 0, w: 1, h: 1 },
      ],
      { startIndex: 0, rng: fixedRng }
    );
    expect(elements).toEqual([]);
    expect(skipped.map(s => s.id)).toEqual(["bad", "u1"]);
  });

  it("startIndex を反映して fractional index を採番する", () => {
    const { elements } = expandElements(
      [{ type: "text", id: "t1", x: 0, y: 0, text: "hi" }],
      { startIndex: 3, rng: fixedRng }
    );
    expect((elements[0] as Record<string, unknown>).index).toBe("a3");
  });
});
