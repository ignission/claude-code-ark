import { describe, expect, it } from "vitest";
import {
  fitWorkAreaWidth,
  GIT_WORK_AREA_WIDTH,
  gitWorkAreaFloor,
  LEFT_MIN_WIDTH,
  PEEK_WORK_AREA_WIDTH,
  peekWorkAreaFloor,
  RESIZER_WIDTH,
  WORK_AREA_MIN_WIDTH,
} from "./split-pane-widths";

describe("fitWorkAreaWidth", () => {
  it("収まるなら希望幅のまま返す", () => {
    expect(fitWorkAreaWidth(1800, 520)).toBe(520);
  });

  it("左ペインの最小幅を残せるところまで縮める", () => {
    expect(fitWorkAreaWidth(1000, 900)).toBe(
      1000 - LEFT_MIN_WIDTH - RESIZER_WIDTH
    );
  });

  it("どれだけ狭くても最小幅より小さくはしない (左が縮む)", () => {
    expect(fitWorkAreaWidth(600, 500)).toBe(WORK_AREA_MIN_WIDTH);
    expect(fitWorkAreaWidth(1800, 100)).toBe(WORK_AREA_MIN_WIDTH);
  });
});

describe("peekWorkAreaFloor", () => {
  it("広いコンテナでは 900px", () => {
    expect(peekWorkAreaFloor(1600)).toBe(PEEK_WORK_AREA_WIDTH);
  });

  it("狭いコンテナでは左ペインの最小幅を残せる幅まで", () => {
    expect(peekWorkAreaFloor(1000)).toBe(632);
  });

  it("コンテナ幅が分からないときは 900px", () => {
    expect(peekWorkAreaFloor(0)).toBe(PEEK_WORK_AREA_WIDTH);
  });
});

describe("gitWorkAreaFloor", () => {
  it("広いコンテナでは 760px", () => {
    expect(gitWorkAreaFloor(1600)).toBe(GIT_WORK_AREA_WIDTH);
  });

  it("狭いコンテナでは左ペインの最小幅を残せる幅まで", () => {
    expect(gitWorkAreaFloor(1000)).toBe(632);
  });

  it("コンテナ幅が分からないときは 760px", () => {
    expect(gitWorkAreaFloor(0)).toBe(GIT_WORK_AREA_WIDTH);
  });
});
