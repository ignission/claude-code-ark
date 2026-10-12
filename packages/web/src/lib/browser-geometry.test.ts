import { describe, expect, it } from "vitest";
import {
  containsPoint,
  letterboxRect,
  placeSelectList,
  SELECT_LIST_MAX_HEIGHT,
  SELECT_LIST_MIN_HEIGHT,
  screenToViewport,
  viewportToScreen,
} from "./browser-geometry";

describe("letterboxRect", () => {
  it("ビューポートを知らなければ、領域の全体を使う", () => {
    expect(letterboxRect({ width: 800, height: 600 }, null)).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      fill: true,
    });
  });

  it("寸法が同じなら (端数の違いは無視して)、領域の全体を使う", () => {
    expect(
      letterboxRect(
        { width: 800.4, height: 599.6 },
        { width: 800, height: 600 }
      )
    ).toMatchObject({
      left: 0,
      top: 0,
      width: 800.4,
      height: 599.6,
      fill: true,
    });
  });

  it("縦横比が同じで寸法だけ違うなら、領域の全体を使う", () => {
    expect(
      letterboxRect({ width: 800, height: 600 }, { width: 1200, height: 900 })
    ).toEqual({ left: 0, top: 0, width: 800, height: 600, fill: true });
    // 割り切れない比でも、端数で隙間を作らない
    expect(
      letterboxRect({ width: 1000, height: 333 }, { width: 3000, height: 999 })
    ).toMatchObject({ width: 1000, height: 333, fill: true });
  });

  it("ビューポートのほうが横長なら、上下に余白を置いて中央に収める", () => {
    expect(
      letterboxRect({ width: 800, height: 600 }, { width: 1600, height: 600 })
    ).toEqual({ left: 0, top: 150, width: 800, height: 300, fill: false });
  });

  it("ビューポートのほうが縦長なら、左右に余白を置いて中央に収める", () => {
    expect(
      letterboxRect({ width: 800, height: 600 }, { width: 400, height: 800 })
    ).toEqual({ left: 250, top: 0, width: 300, height: 600, fill: false });
  });

  it("小さいビューポートは、領域に収まる最大の寸法まで広げる", () => {
    expect(
      letterboxRect({ width: 800, height: 600 }, { width: 200, height: 100 })
    ).toEqual({ left: 0, top: 100, width: 800, height: 400, fill: false });
  });

  it("領域の寸法が0なら (隠れている)、全体を使う扱いにする", () => {
    expect(
      letterboxRect({ width: 0, height: 0 }, { width: 400, height: 800 })
    ).toMatchObject({ fill: true });
  });
});

describe("screenToViewport / viewportToScreen", () => {
  const viewport = { width: 1200, height: 900 };
  const canvas = { left: 30, top: 40, width: 400, height: 300 };

  it("canvas上の位置を、ビューポートの座標へ直す", () => {
    expect(screenToViewport({ x: 20, y: 10 }, canvas, viewport)).toEqual({
      x: 60,
      y: 30,
    });
  });

  it("ビューポートを知らないか、canvasが見えていなければ `null`", () => {
    expect(screenToViewport({ x: 1, y: 1 }, canvas, null)).toBeNull();
    expect(
      screenToViewport({ x: 1, y: 1 }, { width: 0, height: 0 }, viewport)
    ).toBeNull();
  });

  it("ビューポートの矩形を、canvasの置き場所を足した表示上の矩形へ直す", () => {
    expect(
      viewportToScreen(
        { x: 60, y: 30, width: 300, height: 60 },
        canvas,
        viewport
      )
    ).toEqual({ left: 50, top: 50, width: 100, height: 20 });
  });

  it("往復すると元の位置に戻る", () => {
    const point = screenToViewport({ x: 123, y: 45 }, canvas, viewport);
    const back = viewportToScreen(
      { x: point?.x ?? 0, y: point?.y ?? 0, width: 0, height: 0 },
      canvas,
      viewport
    );
    expect(back.left - canvas.left).toBeCloseTo(123);
    expect(back.top - canvas.top).toBeCloseTo(45);
  });
});

describe("containsPoint", () => {
  const rect = { left: 10, top: 20, width: 100, height: 50 };
  it("矩形の中と端は含み、外は含まない", () => {
    expect(containsPoint(rect, 10, 20)).toBe(true);
    expect(containsPoint(rect, 110, 70)).toBe(true);
    expect(containsPoint(rect, 9, 30)).toBe(false);
    expect(containsPoint(rect, 50, 71)).toBe(false);
  });
});

describe("placeSelectList", () => {
  const area = { width: 800, height: 600 };

  it("下に収まるなら、`<select>` のすぐ下に、同じ幅以上で出す", () => {
    const placed = placeSelectList(
      { left: 100, top: 50, width: 120, height: 24 },
      area,
      200
    );
    expect(placed).toMatchObject({ left: 100, top: 76, minWidth: 120 });
    expect(placed.bottom).toBeUndefined();
    expect(placed.maxHeight).toBe(SELECT_LIST_MAX_HEIGHT);
  });

  it("下にはみ出し、上のほうが広ければ、上に出す", () => {
    const placed = placeSelectList(
      { left: 100, top: 500, width: 120, height: 24 },
      area,
      200
    );
    expect(placed.top).toBeUndefined();
    // 領域の下端から測る。`<select>` の上端のすぐ上
    expect(placed.bottom).toBe(102);
    expect(placed.maxHeight).toBe(SELECT_LIST_MAX_HEIGHT);
  });

  it("上下のどちらにも収まらなければ、広いほうに出して高さを空きに合わせる", () => {
    const placed = placeSelectList(
      { left: 0, top: 100, width: 120, height: 24 },
      { width: 800, height: 300 },
      1000
    );
    expect(placed.top).toBe(126);
    expect(placed.maxHeight).toBe(174);
  });

  it("右にはみ出すなら、領域の中へ寄せる", () => {
    const placed = placeSelectList(
      { left: 750, top: 50, width: 120, height: 24 },
      area,
      100
    );
    expect(placed.left).toBe(680);
    // 右端までの幅に収める (領域の幅のままだと、右へはみ出して切れる)
    expect(placed.maxWidth).toBe(120);
  });

  it("幅の上限は、置いた位置から領域の右端まで", () => {
    const placed = placeSelectList(
      { left: 300, top: 50, width: 120, height: 24 },
      area,
      100
    );
    expect(placed).toMatchObject({ left: 300, minWidth: 120, maxWidth: 500 });
  });

  it("上にも下にも最小の高さが無ければ、`<select>` に重ねて、領域の中に最小の高さで出す", () => {
    const placed = placeSelectList(
      { left: 0, top: 40, width: 120, height: 24 },
      { width: 800, height: 120 },
      1000
    );
    // 下は54、上は38で、どちらも最小の高さに足りない
    expect(placed.bottom).toBeUndefined();
    expect(placed.top).toBe(120 - SELECT_LIST_MIN_HEIGHT);
    expect(placed.maxHeight).toBe(SELECT_LIST_MIN_HEIGHT);
  });

  it("領域が最小の高さより低ければ、領域の高さに収める", () => {
    const placed = placeSelectList(
      { left: 0, top: 20, width: 120, height: 24 },
      { width: 800, height: 60 },
      1000
    );
    expect(placed).toMatchObject({ top: 0, maxHeight: 60 });
  });

  it("中身が最小の高さより低ければ、中身の高さが入れば足りる", () => {
    const placed = placeSelectList(
      { left: 0, top: 500, width: 120, height: 24 },
      area,
      36
    );
    expect(placed).toMatchObject({ top: 526, maxHeight: 74 });
  });

  it("`<select>` が領域の外にあっても、リストは領域の中に出す", () => {
    const below = placeSelectList(
      { left: 100, top: 900, width: 120, height: 24 },
      area,
      200
    );
    expect(below.top).toBeUndefined();
    expect(below.bottom).toBe(2);
    expect(below.maxHeight).toBe(SELECT_LIST_MAX_HEIGHT);

    const above = placeSelectList(
      { left: 100, top: -300, width: 120, height: 24 },
      area,
      200
    );
    expect(above.top).toBe(2);
    expect(above.maxHeight).toBe(SELECT_LIST_MAX_HEIGHT);

    const right = placeSelectList(
      { left: 2000, top: 50, width: 120, height: 24 },
      area,
      200
    );
    expect(right).toMatchObject({ left: 680, maxWidth: 120 });
  });

  it("領域より広い `<select>` は、領域の幅に収める", () => {
    const placed = placeSelectList(
      { left: -20, top: 50, width: 2000, height: 24 },
      area,
      100
    );
    expect(placed).toMatchObject({ left: 0, minWidth: 800 });
  });
});
