import { describe, expect, it } from "vitest";
import {
  BOARD_MIN_WIDTH,
  FILE_MIN_WIDTH,
  fitPaneWidths,
  LEFT_MIN_WIDTH,
} from "./split-pane-widths";

const RESIZER = 4;

describe("fitPaneWidths", () => {
  it("収まるなら希望幅のまま返す", () => {
    expect(fitPaneWidths({ total: 1800, file: 520, board: 420 })).toEqual({
      file: 520,
      board: 420,
    });
  });

  it("超えた分はまず file だけを縮める", () => {
    // 余地 = 1400 - 360 - 8 = 1032。file 700 + board 420 = 1120 → 88 超過
    expect(fitPaneWidths({ total: 1400, file: 700, board: 420 })).toEqual({
      file: 612,
      board: 420,
    });
  });

  it("file が最小幅に達したら board も縮める", () => {
    // 余地 = 1200 - 360 - 8 = 832。file 500 + board 600 = 1100 → 268 超過
    // file は 140 縮んで最小の 360、残り 128 を board から (600→472)
    expect(fitPaneWidths({ total: 1200, file: 500, board: 600 })).toEqual({
      file: FILE_MIN_WIDTH,
      board: 472,
    });
  });

  it("どれだけ狭くても最小幅より小さくはしない (左が縮む)", () => {
    expect(fitPaneWidths({ total: 800, file: 500, board: 500 })).toEqual({
      file: FILE_MIN_WIDTH,
      board: BOARD_MIN_WIDTH,
    });
  });

  it("片方が閉じていれば、閉じている側は 0 でリサイザも数えない", () => {
    // 余地 = 1000 - 360 - 4 = 636
    expect(fitPaneWidths({ total: 1000, file: 900, board: null })).toEqual({
      file: 1000 - LEFT_MIN_WIDTH - RESIZER,
      board: 0,
    });
    expect(fitPaneWidths({ total: 1000, file: null, board: 900 })).toEqual({
      file: 0,
      board: 1000 - LEFT_MIN_WIDTH - RESIZER,
    });
  });

  it("両方閉じていれば両方 0", () => {
    expect(fitPaneWidths({ total: 1000, file: null, board: null })).toEqual({
      file: 0,
      board: 0,
    });
  });
});
