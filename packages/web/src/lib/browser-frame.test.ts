import { describe, expect, it } from "vitest";
import {
  canvasScale,
  FRAME_HEADER_BYTES,
  type FrameHeader,
  frameImageType,
  MAX_CANVAS_PIXELS,
  parseFrameHeader,
  pruneQueue,
  REFRESH_INTERVAL_MAX_MS,
  REFRESH_INTERVAL_MS,
  refreshIntervalMs,
} from "./browser-frame";

function encode(
  kind: number,
  gen: number,
  rect: { x: number; y: number; width: number; height: number },
  image: number[] = []
): ArrayBuffer {
  const data = new ArrayBuffer(FRAME_HEADER_BYTES + image.length);
  const view = new DataView(data);
  view.setUint8(0, kind);
  view.setUint16(1, gen);
  view.setUint16(3, rect.x);
  view.setUint16(5, rect.y);
  view.setUint16(7, rect.width);
  view.setUint16(9, rect.height);
  new Uint8Array(data, FRAME_HEADER_BYTES).set(image);
  return data;
}

function entry(kind: 1 | 2 | 3, gen: number, id: number) {
  const header: FrameHeader = { kind, gen, x: 0, y: 0, width: 1, height: 1 };
  return { header, id };
}

describe("parseFrameHeader", () => {
  it("ヘッダの数値をbig-endianの符号なしで読む", () => {
    const data = encode(3, 0xfffe, { x: 300, y: 2, width: 1076, height: 834 });

    expect(parseFrameHeader(data)).toEqual({
      kind: 3,
      gen: 0xfffe,
      x: 300,
      y: 2,
      width: 1076,
      height: 834,
    });
  });

  it("全画面の2種類を読む", () => {
    const rect = { x: 0, y: 0, width: 800, height: 600 };

    expect(parseFrameHeader(encode(1, 0, rect))?.kind).toBe(1);
    expect(parseFrameHeader(encode(2, 0, rect))?.kind).toBe(2);
  });

  it("ヘッダより短ければ `null`", () => {
    expect(
      parseFrameHeader(new ArrayBuffer(FRAME_HEADER_BYTES - 1))
    ).toBeNull();
    expect(parseFrameHeader(new ArrayBuffer(0))).toBeNull();
  });

  it("種類が未知なら `null`", () => {
    const rect = { x: 0, y: 0, width: 800, height: 600 };

    expect(parseFrameHeader(encode(0, 1, rect))).toBeNull();
    expect(parseFrameHeader(encode(4, 1, rect))).toBeNull();
  });

  it("幅か高さが0なら `null`", () => {
    expect(
      parseFrameHeader(encode(3, 1, { x: 0, y: 0, width: 0, height: 10 }))
    ).toBeNull();
    expect(
      parseFrameHeader(encode(3, 1, { x: 0, y: 0, width: 10, height: 0 }))
    ).toBeNull();
  });
});

describe("frameImageType", () => {
  const rect = { x: 0, y: 0, width: 1, height: 1 };

  it("画像の先頭バイトで種類を決める", () => {
    expect(frameImageType(encode(1, 0, rect, [0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg"
    );
    expect(
      frameImageType(encode(3, 0, rect, [0x52, 0x49, 0x46, 0x46, 0x00]))
    ).toBe("image/webp");
  });

  it("どちらでもないか、画像が無ければ `null`", () => {
    expect(
      frameImageType(encode(1, 0, rect, [0x89, 0x50, 0x4e, 0x47]))
    ).toBeNull();
    expect(frameImageType(encode(1, 0, rect, [0x52, 0x49, 0x46]))).toBeNull();
    expect(frameImageType(encode(1, 0, rect))).toBeNull();
  });
});

describe("pruneQueue", () => {
  const ids = (queue: Array<{ id: number }>) => queue.map(item => item.id);

  it("全画面より前にあるものを捨てる", () => {
    const queue = [
      entry(3, 5, 1),
      entry(3, 5, 2),
      entry(1, 5, 3),
      entry(3, 5, 4),
    ];

    expect(ids(pruneQueue(queue, 5))).toEqual([3, 4]);
  });

  it("全画面がいくつもあれば、最後の全画面から残す", () => {
    const queue = [entry(1, 5, 1), entry(3, 5, 2), entry(1, 5, 3)];

    expect(ids(pruneQueue(queue, 5))).toEqual([3]);
  });

  it("世代の違うものを捨てる", () => {
    const queue = [
      entry(3, 4, 1),
      entry(3, 5, 2),
      entry(3, 6, 3),
      entry(3, 5, 4),
    ];

    expect(ids(pruneQueue(queue, 5))).toEqual([2, 4]);
  });

  it("世代の違う全画面は区切りにならない", () => {
    const queue = [entry(3, 5, 1), entry(1, 4, 2), entry(3, 5, 3)];

    expect(ids(pruneQueue(queue, 5))).toEqual([1, 3]);
  });

  it("矩形だけなら全部を順番のまま残す", () => {
    const queue = [entry(3, 5, 1), entry(3, 5, 2), entry(3, 5, 3)];

    expect(ids(pruneQueue(queue, 5))).toEqual([1, 2, 3]);
  });

  it("粗い全画面も区切りになる", () => {
    const queue = [entry(3, 5, 1), entry(2, 5, 2), entry(3, 5, 3)];

    expect(ids(pruneQueue(queue, 5))).toEqual([2, 3]);
  });

  it("空の列はそのまま返す", () => {
    expect(pruneQueue([], 5)).toEqual([]);
  });
});

describe("canvasScale", () => {
  const viewport = { width: 1001, height: 601 };

  it("手元の倍率が1.5以上なら2、それより低ければ1", () => {
    expect(canvasScale(viewport, 1)).toBe(1);
    expect(canvasScale(viewport, 1.25)).toBe(1);
    expect(canvasScale(viewport, 1.5)).toBe(2);
    expect(canvasScale(viewport, 2)).toBe(2);
    expect(canvasScale(viewport, 3)).toBe(2);
  });

  it("1より低い倍率や、数でない倍率は1", () => {
    expect(canvasScale(viewport, 0.5)).toBe(1);
    expect(canvasScale(viewport, 0)).toBe(1);
    expect(canvasScale(viewport, Number.NaN)).toBe(1);
  });

  it("2倍にすると画素数の上限を超えるビューポートは1", () => {
    expect(canvasScale({ width: 3840, height: 2160 }, 2)).toBe(1);
    // ちょうど上限なら2倍にする
    expect(MAX_CANVAS_PIXELS).toBe(16_000_000);
    expect(canvasScale({ width: 2000, height: 2000 }, 2)).toBe(2);
    expect(canvasScale({ width: 2001, height: 2000 }, 2)).toBe(1);
  });
});

describe("refreshIntervalMs", () => {
  it("描けない失敗が続いた回数で、間隔を倍にしていく", () => {
    expect(REFRESH_INTERVAL_MS).toBe(500);
    expect(refreshIntervalMs(0)).toBe(500);
    expect(refreshIntervalMs(1)).toBe(500);
    expect(refreshIntervalMs(2)).toBe(1000);
    expect(refreshIntervalMs(3)).toBe(2000);
    expect(refreshIntervalMs(4)).toBe(4000);
  });

  it("上限より長くしない", () => {
    expect(REFRESH_INTERVAL_MAX_MS).toBe(8000);
    expect(refreshIntervalMs(5)).toBe(8000);
    expect(refreshIntervalMs(6)).toBe(8000);
    expect(refreshIntervalMs(5000)).toBe(8000);
  });
});
