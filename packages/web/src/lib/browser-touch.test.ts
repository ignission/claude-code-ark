import { describe, expect, it } from "vitest";
import { MAX_TOUCH_POINTS, TouchIdMap, touchPoints } from "./browser-touch";

describe("TouchIdMap", () => {
  it("大きい識別子や負の識別子を、0からの小さい整数に割り当てる", () => {
    const ids = new TouchIdMap();
    expect(ids.assign(-1234567)).toBe(0);
    expect(ids.assign(2 ** 31)).toBe(1);
    expect(ids.get(-1234567)).toBe(0);
    expect(ids.size).toBe(2);
  });

  it("同じ識別子には、触れている間は同じ番号を返す", () => {
    const ids = new TouchIdMap();
    expect(ids.assign(7)).toBe(0);
    expect(ids.assign(7)).toBe(0);
    expect(ids.size).toBe(1);
  });

  it("離した番号は、次の指に使い回す", () => {
    const ids = new TouchIdMap();
    ids.assign(100);
    ids.assign(200);
    ids.assign(300);
    expect(ids.release(200)).toBe(true);
    expect(ids.release(200)).toBe(false);
    expect(ids.assign(400)).toBe(1);
    expect(ids.get(300)).toBe(2);
  });

  it("上限を超える指は割り当てない", () => {
    const ids = new TouchIdMap();
    for (let i = 0; i < MAX_TOUCH_POINTS; i++) {
      expect(ids.assign(1000 + i)).toBe(i);
    }
    expect(ids.assign(9999)).toBeNull();
    expect(ids.size).toBe(MAX_TOUCH_POINTS);
  });

  it("`clear` で全部を忘れる", () => {
    const ids = new TouchIdMap();
    ids.assign(1);
    ids.clear();
    expect(ids.size).toBe(0);
    expect(ids.get(1)).toBeUndefined();
  });
});

describe("touchPoints", () => {
  it("割り当て済みの指だけを、換算した座標で返す", () => {
    const ids = new TouchIdMap();
    ids.assign(50);
    ids.assign(70);
    const touches = [
      { identifier: 70, clientX: 30, clientY: 40 },
      { identifier: 60, clientX: 1, clientY: 1 },
      { identifier: 50, clientX: 10, clientY: 20 },
    ];
    expect(
      touchPoints(touches, ids, t => ({ x: t.clientX * 2, y: t.clientY * 2 }))
    ).toEqual([
      { id: 1, x: 60, y: 80 },
      { id: 0, x: 20, y: 40 },
    ]);
  });

  it("座標を換算できない指は入れない", () => {
    const ids = new TouchIdMap();
    ids.assign(1);
    expect(
      touchPoints([{ identifier: 1, clientX: 0, clientY: 0 }], ids, () => null)
    ).toEqual([]);
  });

  it("`TouchList` のような、添字と `length` だけの並びも読める", () => {
    const ids = new TouchIdMap();
    ids.assign(5);
    const list = { 0: { identifier: 5, clientX: 3, clientY: 4 }, length: 1 };
    expect(
      touchPoints(list, ids, t => ({ x: t.clientX, y: t.clientY }))
    ).toEqual([{ id: 0, x: 3, y: 4 }]);
  });
});
