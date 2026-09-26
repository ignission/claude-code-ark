import { describe, expect, it } from "vitest";
import { isHighlightedLine } from "./file-viewer-highlight";

describe("isHighlightedLine", () => {
  it("行の指定が無ければどこも光らせない", () => {
    expect(isHighlightedLine(1)).toBe(false);
    expect(isHighlightedLine(1, null)).toBe(false);
    expect(isHighlightedLine(1, 0)).toBe(false);
  });

  it("開始行だけならその 1 行", () => {
    expect(isHighlightedLine(40, 40)).toBe(true);
    expect(isHighlightedLine(41, 40)).toBe(false);
  });

  it("範囲なら両端を含む", () => {
    expect(isHighlightedLine(39, 40, 58)).toBe(false);
    expect(isHighlightedLine(40, 40, 58)).toBe(true);
    expect(isHighlightedLine(49, 40, 58)).toBe(true);
    expect(isHighlightedLine(58, 40, 58)).toBe(true);
    expect(isHighlightedLine(59, 40, 58)).toBe(false);
  });

  it("逆順に書かれていても入れ替えて扱う", () => {
    expect(isHighlightedLine(45, 58, 40)).toBe(true);
  });
});
