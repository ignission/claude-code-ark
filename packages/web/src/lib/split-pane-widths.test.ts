import { describe, expect, it } from "vitest";
import {
  fitLeftWidth,
  LEFT_MIN_WIDTH,
  RESIZER_WIDTH,
  WORK_AREA_MIN_WIDTH,
} from "./split-pane-widths";

describe("fitLeftWidth", () => {
  it("収まるなら希望幅のまま返す", () => {
    expect(fitLeftWidth(1400, 520)).toBe(520);
  });

  it("作業エリアの最小幅を残せるところまで縮める", () => {
    expect(fitLeftWidth(1000, 900)).toBe(
      1000 - WORK_AREA_MIN_WIDTH - RESIZER_WIDTH
    );
  });

  it("左の最小幅より狭くはしない", () => {
    expect(fitLeftWidth(1400, 100)).toBe(LEFT_MIN_WIDTH);
  });

  it("両方の最小幅が入らないときは、作業エリアを優先して左を縮める", () => {
    // 600 - 360 - 8 = 232
    expect(fitLeftWidth(600, 520)).toBe(232);
    expect(fitLeftWidth(300, 520)).toBe(0);
  });

  it("コンテナ幅が分からないときは希望幅のまま返す", () => {
    expect(fitLeftWidth(0, 520)).toBe(520);
  });
});
