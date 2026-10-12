import { describe, expect, it } from "vitest";
import {
  coverage,
  decodePng,
  diffImages,
  MAX_RECTS,
  type MonitorImage,
  toCssRect,
} from "./browser-frame-diff.js";
import {
  buildPng,
  buildSolidPng,
  pngChunk,
} from "./browser-frame-diff.testkit.js";

const W = 5;
const H = 4;

function gradient(channels: 3 | 4): number[] {
  const out: number[] = [];
  for (let i = 0; i < W * H; i++) {
    out.push((i * 13) % 256, (i * 29 + 7) % 256, (i * 53 + 101) % 256);
    if (channels === 4) out.push(200);
  }
  return out;
}

function rgbOf(channels: 3 | 4): number[] {
  const src = gradient(channels);
  if (channels === 3) return src;
  return src.filter((_, i) => i % 4 !== 3);
}

function image(
  width: number,
  height: number,
  dots: Array<[number, number]> = []
): MonitorImage {
  const data = Buffer.alloc(width * height * 3);
  for (const [x, y] of dots)
    data.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
  return { width, height, data };
}

describe("decodePng", () => {
  it("filter 0〜4のそれぞれで、RGBの画像を正しく戻す", () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = buildPng({
        width: W,
        height: H,
        pixels: gradient(3),
        filter,
      });
      const img = decodePng(png);
      expect(img?.width).toBe(W);
      expect(img?.height).toBe(H);
      expect([...(img?.data ?? [])]).toEqual(rgbOf(3));
    }
    // 行ごとに違うfilterでも戻す
    const mixed = decodePng(
      buildPng({
        width: W,
        height: H,
        pixels: gradient(3),
        filter: [1, 4, 2, 3],
      })
    );
    expect([...(mixed?.data ?? [])]).toEqual(rgbOf(3));
  });

  it("RGBAはαを捨ててRGBで返す", () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const img = decodePng(
        buildPng({
          width: W,
          height: H,
          pixels: gradient(4),
          channels: 4,
          filter,
        })
      );
      expect([...(img?.data ?? [])]).toEqual(rgbOf(4));
    }
  });

  it("IDATが複数に分かれていても戻す", () => {
    const png = buildPng({
      width: W,
      height: H,
      pixels: gradient(3),
      idatChunks: 5,
    });
    expect([...(decodePng(png)?.data ?? [])]).toEqual(rgbOf(3));
  });

  it("対応外や壊れたデータは例外を投げずnullを返す", () => {
    const good = buildPng({ width: W, height: H, pixels: gradient(3) });
    const px = gradient(3);
    // シグネチャでない
    const badSig = Buffer.from(good);
    badSig[0] = 0;
    expect(decodePng(badSig)).toBeNull();
    expect(decodePng(Buffer.alloc(0))).toBeNull();
    // 16bit / パレット / インターレース
    expect(
      decodePng(buildPng({ width: W, height: H, pixels: px, bitDepth: 16 }))
    ).toBeNull();
    expect(
      decodePng(buildPng({ width: W, height: H, pixels: px, colorType: 3 }))
    ).toBeNull();
    expect(
      decodePng(buildPng({ width: W, height: H, pixels: px, interlace: 1 }))
    ).toBeNull();
    // 途中で切れている / チャンク長がバッファを越える
    expect(decodePng(good.subarray(0, good.length - 30))).toBeNull();
    expect(decodePng(good.subarray(0, 20))).toBeNull();
    // IDATが壊れている (inflateが投げる)
    const sig = good.subarray(0, 8);
    const ihdrChunk = good.subarray(8, 8 + 25);
    const corrupt = Buffer.concat([
      sig,
      ihdrChunk,
      pngChunk("IDAT", Buffer.from("not zlib data")),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    expect(decodePng(corrupt)).toBeNull();
    // IDATが無い
    expect(
      decodePng(
        Buffer.concat([sig, ihdrChunk, pngChunk("IEND", Buffer.alloc(0))])
      )
    ).toBeNull();
    // IHDRの寸法と実データの長さが合わない
    expect(
      decodePng(
        buildPng({ width: W, height: H, pixels: px, headerHeight: H + 1 })
      )
    ).toBeNull();
    expect(
      decodePng(
        buildPng({ width: W, height: H, pixels: px, headerWidth: W - 1 })
      )
    ).toBeNull();
    // 幅か高さが0か4096超
    expect(
      decodePng(buildPng({ width: W, height: H, pixels: px, headerWidth: 0 }))
    ).toBeNull();
    expect(
      decodePng(buildPng({ width: W, height: H, pixels: px, headerHeight: 0 }))
    ).toBeNull();
    expect(
      decodePng(
        buildPng({ width: W, height: H, pixels: px, headerWidth: 4097 })
      )
    ).toBeNull();
    expect(
      decodePng(
        buildPng({ width: W, height: H, pixels: px, headerHeight: 100000 })
      )
    ).toBeNull();
    // 未知のfilter type
    expect(
      decodePng(
        buildPng({ width: W, height: H, pixels: px, filter: [9, 0, 0, 0] })
      )
    ).toBeNull();
  });
});

describe("diffImages", () => {
  it("同じ画像は空の配列を返す", () => {
    expect(diffImages(image(10, 8), image(10, 8))).toEqual([]);
  });

  it("1画素の違いは、その1画素の矩形になる", () => {
    expect(diffImages(image(10, 8), image(10, 8, [[3, 5]]))).toEqual([
      { x0: 3, y0: 5, x1: 4, y1: 6 },
    ]);
  });

  it("離れた2か所は2つの矩形になる", () => {
    const rects = diffImages(
      image(20, 20),
      image(20, 20, [
        [1, 1],
        [15, 15],
      ])
    );
    expect(rects).toEqual(
      expect.arrayContaining([
        { x0: 1, y0: 1, x1: 2, y1: 2 },
        { x0: 15, y0: 15, x1: 16, y1: 16 },
      ])
    );
    expect(rects).toHaveLength(2);
  });

  it("斜めに隣り合う画素は1つの矩形になる", () => {
    expect(
      diffImages(
        image(10, 10),
        image(10, 10, [
          [2, 2],
          [3, 3],
        ])
      )
    ).toEqual([{ x0: 2, y0: 2, x1: 4, y1: 4 }]);
  });

  it("接している矩形は1つにまとまり、囲んだ範囲になる", () => {
    // (0,0)-(1,1) の塊と、(2,0) は8近傍で1つ。離れた塊が辺で接するケース
    const rects = diffImages(
      image(20, 20),
      image(20, 20, [
        [1, 1],
        [2, 2],
        [3, 1],
        [10, 10],
      ])
    );
    expect(rects).toHaveLength(2);
    expect(rects).toContainEqual({ x0: 1, y0: 1, x1: 4, y1: 3 });
  });

  it("寸法違いは full を返す", () => {
    expect(diffImages(image(10, 8), image(10, 9))).toBe("full");
    expect(diffImages(image(10, 8), image(11, 8))).toBe("full");
  });

  it("矩形が MAX_RECTS を超えたら、全体を囲む1つにする", () => {
    expect(MAX_RECTS).toBe(4);
    const dots: Array<[number, number]> = [
      [1, 1],
      [10, 1],
      [20, 1],
      [30, 1],
      [40, 30],
    ];
    expect(diffImages(image(50, 40), image(50, 40, dots))).toEqual([
      { x0: 1, y0: 1, x1: 41, y1: 31 },
    ]);
    // ちょうど4つなら分けたまま
    expect(
      diffImages(image(50, 40), image(50, 40, dots.slice(0, 4)))
    ).toHaveLength(4);
  });

  it("RGBのどれか1バイトの違いも拾う", () => {
    const a = image(4, 4);
    const b = image(4, 4);
    b.data[(2 * 4 + 1) * 3 + 2] = 1;
    expect(diffImages(a, b)).toEqual([{ x0: 1, y0: 2, x1: 2, y1: 3 }]);
  });
});

describe("toCssRect", () => {
  it("134x104の画像と1076x834のビューポートで、1画素ぶん広げて外向きに丸める", () => {
    const sx = 1076 / 134;
    const sy = 834 / 104;
    const r = toCssRect(
      { x0: 2, y0: 3, x1: 4, y1: 6 },
      { width: 134, height: 104 },
      { width: 1076, height: 834 }
    );
    const x = Math.floor(1 * sx);
    const y = Math.floor(2 * sy);
    const x1 = Math.ceil(5 * sx);
    const y1 = Math.ceil(7 * sy);
    expect(r).toEqual({ x, y, width: x1 - x, height: y1 - y });
    expect(r).toEqual({ x: 8, y: 16, width: 41 - 8, height: 57 - 16 });
  });

  it("端の矩形はビューポートからはみ出さない", () => {
    const vp = { width: 1076, height: 834 };
    const img = { width: 134, height: 104 };
    const r = toCssRect({ x0: 0, y0: 0, x1: 134, y1: 104 }, img, vp);
    expect(r).toEqual({ x: 0, y: 0, width: 1076, height: 834 });
    const r2 = toCssRect({ x0: 133, y0: 103, x1: 134, y1: 104 }, img, vp);
    expect(r2.x + r2.width).toBeLessThanOrEqual(1076);
    expect(r2.y + r2.height).toBeLessThanOrEqual(834);
  });

  it("幅と高さは必ず1以上になる", () => {
    const r = toCssRect(
      { x0: 0, y0: 0, x1: 0, y1: 0 },
      { width: 100, height: 100 },
      { width: 100, height: 100 }
    );
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
    const r2 = toCssRect(
      { x0: 5, y0: 5, x1: 5, y1: 5 },
      { width: 10, height: 10 },
      { width: 1, height: 1 }
    );
    expect(r2.width).toBeGreaterThanOrEqual(1);
    expect(r2.height).toBeGreaterThanOrEqual(1);
  });
});

describe("coverage", () => {
  it("全面は1、半分は0.5、空は0、超えても1で頭打ち", () => {
    const vp = { width: 100, height: 50 };
    expect(coverage([{ x: 0, y: 0, width: 100, height: 50 }], vp)).toBe(1);
    expect(coverage([{ x: 0, y: 0, width: 50, height: 50 }], vp)).toBe(0.5);
    expect(coverage([], vp)).toBe(0);
    expect(
      coverage(
        [
          { x: 0, y: 0, width: 100, height: 50 },
          { x: 0, y: 0, width: 100, height: 50 },
        ],
        vp
      )
    ).toBe(1);
  });
});

describe("testkit", () => {
  it("buildSolidPng は単色にドットを打ったPNGを作る", () => {
    const img = decodePng(
      buildSolidPng(4, 3, [1, 2, 3], [{ x: 1, y: 1, rgb: [9, 9, 9] }])
    );
    expect([
      ...(img?.data.subarray((1 * 4 + 1) * 3, (1 * 4 + 1) * 3 + 3) ?? []),
    ]).toEqual([9, 9, 9]);
    expect([...(img?.data.subarray(0, 3) ?? [])]).toEqual([1, 2, 3]);
  });
});
