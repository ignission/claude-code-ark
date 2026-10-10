import { describe, expect, it } from "vitest";
import {
  ASK_WINDOW_WIDTH,
  clampAskWindowPosition,
  defaultAskWindowPosition,
} from "./ask-window";

const viewport = { width: 1600, height: 900 };

describe("聞くウィンドウの位置", () => {
  it("画面の中ならそのまま", () => {
    expect(clampAskWindowPosition({ x: 300, y: 200 }, viewport)).toEqual({
      x: 300,
      y: 200,
    });
  });

  it("画面の外へは出さない (縦は見出しのぶんを残す)", () => {
    expect(clampAskWindowPosition({ x: -500, y: -500 }, viewport)).toEqual({
      x: 12,
      y: 12,
    });
    const far = clampAskWindowPosition({ x: 9999, y: 9999 }, viewport);
    expect(far.x).toBe(viewport.width - ASK_WINDOW_WIDTH - 12);
    expect(far.y).toBe(viewport.height - 44 - 12);
  });

  it("画面がウィンドウより狭くても、左上のすき間は保つ", () => {
    expect(
      clampAskWindowPosition({ x: 100, y: 100 }, { width: 300, height: 40 })
    ).toEqual({ x: 12, y: 12 });
  });

  it("既定は右下", () => {
    const position = defaultAskWindowPosition(viewport);
    expect(position.x).toBe(viewport.width - ASK_WINDOW_WIDTH - 24);
    expect(position.y).toBeGreaterThan(viewport.height / 3);
  });
});
