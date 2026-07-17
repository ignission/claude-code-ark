import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BoardConversionDeps,
  computeInsertOffset,
  convertMermaidForBoard,
} from "./mermaid-to-board";

const okDeps: BoardConversionDeps = {
  parse: async () => ({ elements: [{ kind: "skeleton" }] }),
  convert: skeleton => skeleton.map(s => ({ ...(s as object), full: true })),
  renderSvg: async () => ({ ok: true, svg: "<svg/>" }),
};

describe("convertMermaidForBoard", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("変換成功時は convert した要素を返す（fallback=false）", async () => {
    const result = await convertMermaidForBoard("graph TD; A-->B", okDeps);
    expect(result.fallback).toBe(false);
    expect(result.elements).toEqual([{ kind: "skeleton", full: true }]);
    expect(result.files).toEqual({});
  });

  it("parse が throw したら SVG 画像フォールバックする（fallback=true）", async () => {
    const deps: BoardConversionDeps = {
      ...okDeps,
      parse: async () => {
        throw new Error("Unsupported diagram type");
      },
      renderSvg: async () => ({
        ok: true,
        svg: '<svg width="600" height="400"><rect/></svg>',
      }),
    };
    const result = await convertMermaidForBoard("stateDiagram-v2", deps);
    expect(result.fallback).toBe(true);
    // 画像要素が 1 つ生成され、fileId が files に登録されている
    expect(result.elements).toHaveLength(1);
    const fileIds = Object.keys(result.files);
    expect(fileIds).toHaveLength(1);
    const file = result.files[fileIds[0]] as {
      mimeType: string;
      dataURL: string;
    };
    expect(file.mimeType).toBe("image/svg+xml");
    expect(file.dataURL.startsWith("data:image/svg+xml;base64,")).toBe(true);
    // 画像 skeleton も成功パスと同じ convert（okDeps.convert が付与する
    // full: true）を通っていることを検証する
    const [element] = result.elements as Array<{
      type: string;
      fileId: string;
      full: boolean;
    }>;
    expect(element.type).toBe("image");
    expect(element.fileId).toBe(fileIds[0]);
    expect(element.full).toBe(true);
  });

  it("parse も renderSvg も失敗したら throw する", async () => {
    const deps: BoardConversionDeps = {
      ...okDeps,
      parse: async () => {
        throw new Error("unsupported");
      },
      renderSvg: async () => ({ ok: false, error: "syntax error" }),
    };
    await expect(convertMermaidForBoard("broken", deps)).rejects.toThrow(
      "syntax error"
    );
  });

  it("巨大な SVG でもフォールバックがクラッシュしない", async () => {
    const bigLabel = "あ".repeat(120_000); // UTF-8 で 360KB 超・引数上限を大きく超える
    const deps: BoardConversionDeps = {
      ...okDeps,
      parse: async () => {
        throw new Error("unsupported");
      },
      renderSvg: async () => ({
        ok: true,
        svg: `<svg width="600" height="400"><text>${bigLabel}</text></svg>`,
      }),
    };
    const result = await convertMermaidForBoard("stateDiagram-v2", deps);
    expect(result.fallback).toBe(true);
    const file = Object.values(result.files)[0] as { dataURL: string };
    expect(file.dataURL.startsWith("data:image/svg+xml;base64,")).toBe(true);
    // ここでも convert（okDeps.convert が付与する full: true）を通っている
    const [element] = result.elements as Array<{ full: boolean }>;
    expect(element.full).toBe(true);
  });
});

describe("computeInsertOffset", () => {
  it("既存要素がなければ 0", () => {
    expect(computeInsertOffset([])).toBe(0);
  });

  it("既存要素の右端 + padding を返す", () => {
    const existing = [
      { x: 0, width: 100 },
      { x: 200, width: 150 }, // 右端 350
    ];
    expect(computeInsertOffset(existing, 80)).toBe(430);
  });
});
