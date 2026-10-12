import { deflateSync } from "node:zlib";
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
  filterRows,
  pngChunk,
} from "./browser-frame-diff.testkit.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** 手で組むPNG用。IHDR (8bit RGB、インターレース無し) とIDAT (中身は呼び出し側) を並べる */
function handmadePng(width: number, height: number, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

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

  it("寸法の上限は1024で、実データが揃っていても超えたら拒否する", () => {
    const ok = decodePng(
      buildPng({ width: 1024, height: 1, pixels: new Uint8Array(1024 * 3) })
    );
    expect(ok?.width).toBe(1024);
    expect(
      decodePng(
        buildPng({ width: 1025, height: 1, pixels: new Uint8Array(1025 * 3) })
      )
    ).toBeNull();
    expect(
      decodePng(
        buildPng({ width: 1, height: 1025, pixels: new Uint8Array(1025 * 3) })
      )
    ).toBeNull();
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

  it("RGBAはαが画素ごとに違っても、RGBに混ざらない", () => {
    const pixels: number[] = [];
    for (let i = 0; i < W * H; i++) {
      pixels.push(10 + i, 50 + i, 90 + i, (i * 37) % 256);
    }
    const expected = pixels.filter((_, i) => i % 4 !== 3);
    for (const filter of [0, 1, 2, 3, 4]) {
      const img = decodePng(
        buildPng({ width: W, height: H, pixels, channels: 4, filter })
      );
      expect([...(img?.data ?? [])]).toEqual(expected);
    }
  });

  it("Paeth予測の同点は、a、b、cの順で選ぶ (手で書いたバイト列)", () => {
    // 3x2のRGB。1行目はfilter 0 (そのまま)、2行目はfilter 4 (Paeth)。
    // 2行目の画素xのチャンネルごとに a=左 (2行目)、b=上、c=左上 として
    // p = a + b - c、pa = |p - a|、pb = |p - b|、pc = |p - c| で予測する。
    //
    // 1行目 (復号後) : (2,5,8) (3,5,8) (1,1,200)
    // 2行目 (復号後) : (0,5,8) (4,9,1) (7,20,100)
    //
    // 2行目x=0は a=0、c=0 なので b が選ばれる。以下は x=1 と x=2。
    // R x=1: a=0 b=3 c=2 → p=1、pa=1 pb=2 pc=1 → paとpcが同点でaが最小 → a=0
    //        (pa < pc と書くとcに落ちる)  4 = 4 + 0
    // R x=2: a=4 b=1 c=3 → p=2、pa=2 pb=1 pc=1 → pbとpcが同点でaより小さい → b=1
    //        (pc <= pb と書くとcに落ちる)  7 = 6 + 1
    // G x=1: a=5 b=5 c=5 → p=5、pa=pb=pc=0 の三つ巴 → 5   9 = 4 + 5
    // G x=2: a=9 b=1 c=5 → p=5、pa=4 pb=4 pc=0 → paとpbが同点でもcが最小 → c=5
    //        20 = 15 + 5
    // B x=1: a=8 b=8 c=8 → 三つ巴で8  1 = 249 + 8 (mod 256)
    // B x=2: a=1 b=200 c=8 → p=193、pa=192 pb=7 pc=185 → b=200
    //        100 = 156 + 200 (mod 256)
    const raw = Buffer.from([
      // 行0: filter 0
      0, 2, 5, 8, 3, 5, 8, 1, 1, 200,
      // 行1: filter 4。x=0 は (254,0,0)、x=1 は (4,4,249)、x=2 は (6,15,156)
      4, 254, 0, 0, 4, 4, 249, 6, 15, 156,
    ]);
    const img = decodePng(handmadePng(3, 2, deflateSync(raw)));
    expect([...(img?.data ?? [])]).toEqual([
      ...[2, 5, 8, 3, 5, 8, 1, 1, 200],
      ...[0, 5, 8, 4, 9, 1, 7, 20, 100],
    ]);
  });

  it("zlibストリームの後ろに余分なバイトがあっても、長さが合えば戻す", () => {
    const raw = filterRows(gradient(3), W, H, 3, 0);
    const withTail = Buffer.concat([
      deflateSync(raw),
      Buffer.from("trailing garbage"),
    ]);
    const img = decodePng(handmadePng(W, H, withTail));
    expect([...(img?.data ?? [])]).toEqual(rgbOf(3));
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
    // 幅か高さが0
    expect(
      decodePng(buildPng({ width: W, height: H, pixels: px, headerWidth: 0 }))
    ).toBeNull();
    expect(
      decodePng(buildPng({ width: W, height: H, pixels: px, headerHeight: 0 }))
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

  it("2画素が斜めに隣り合えば1つ、1画素あけて離れていれば2つの矩形になる", () => {
    expect(
      diffImages(
        image(10, 10),
        image(10, 10, [
          [2, 2],
          [3, 3],
        ])
      )
    ).toEqual([{ x0: 2, y0: 2, x1: 4, y1: 4 }]);
    const apart = diffImages(
      image(10, 10),
      image(10, 10, [
        [2, 2],
        [4, 2],
      ])
    );
    expect(apart).toHaveLength(2);
    expect(apart).toContainEqual({ x0: 2, y0: 2, x1: 3, y1: 3 });
    expect(apart).toContainEqual({ x0: 4, y0: 2, x1: 5, y1: 3 });
  });

  it("枠の中の離れた1画素は、枠と1つにまとまる", () => {
    const dots: Array<[number, number]> = [[6, 6]];
    for (let i = 2; i <= 10; i++) {
      dots.push([i, 2], [i, 10], [2, i], [10, i]);
    }
    expect(diffImages(image(14, 14), image(14, 14, dots))).toEqual([
      { x0: 2, y0: 2, x1: 11, y1: 11 },
    ]);
  });

  it("A-B、B-Cが接し、A-Cは接しない並びも、順序によらず1つにまとまる", () => {
    // A: 左上の角の字 (列x=0とy=0の行)。箱は x0..9、y0..9
    // C: (12,0) の1画素。Aの箱とは接しない
    // B: 列x=14 (y0..9) と行y=9 (x5..14)。AともCとも箱が重なるが、画素はどれともつながらない
    // 走査順はA、C、Bになるので、AとBを束ねたあとでCを見直さないと残る
    const dots: Array<[number, number]> = [[12, 0]];
    for (let i = 0; i <= 9; i++) dots.push([i, 0], [0, i]);
    for (let y = 0; y <= 9; y++) dots.push([14, y]);
    for (let x = 5; x <= 14; x++) dots.push([x, 9]);
    expect(diffImages(image(20, 12), image(20, 12, dots))).toEqual([
      { x0: 0, y0: 0, x1: 15, y1: 10 },
    ]);
  });

  it("成分が多すぎるときは、変化した画素すべてを囲む1つを素早く返す", () => {
    // 512x512で1画素おきの格子: 約65,000個の孤立した画素
    const size = 512;
    const dots: Array<[number, number]> = [];
    for (let y = 0; y < size; y += 2)
      for (let x = 0; x < size; x += 2) dots.push([x, y]);
    const prev = image(size, size);
    const next = image(size, size, dots);
    const start = performance.now();
    const rects = diffImages(prev, next);
    const elapsed = performance.now() - start;
    expect(rects).toEqual([{ x0: 0, y0: 0, x1: size - 1, y1: size - 1 }]);
    // 早めの打ち切りが無いと、この入力は矩形をまとめる処理に約3秒かかる (結果は同じになる)。
    // 打ち切りがあれば数msで済むので、負荷の高いCIでも揺れない幅を取って1秒で見る
    expect(elapsed).toBeLessThan(1000);
  });

  it("成分が65個の孤立した点なら、全体を囲む1つになる", () => {
    const dots: Array<[number, number]> = [];
    for (let i = 0; i < 65; i++) dots.push([3 * i + 1, 5]);
    expect(diffImages(image(200, 10), image(200, 10, dots))).toEqual([
      { x0: 1, y0: 5, x1: 194, y1: 6 },
    ]);
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

describe("toCssRect の入力の守り", () => {
  const rect = { x0: 2, y0: 2, x1: 4, y1: 4 };
  const img = { width: 10, height: 10 };

  it("大きさが0以下のビューポートでも、原点が負にならず1x1に収まる", () => {
    for (const vp of [
      { width: 0, height: 0 },
      { width: -5, height: -7 },
      { width: 0, height: 100 },
    ]) {
      const r = toCssRect(rect, img, vp);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.width).toBeGreaterThanOrEqual(1);
      expect(r.height).toBeGreaterThanOrEqual(1);
    }
    expect(toCssRect(rect, img, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("整数でないビューポートでも、結果は整数で、切り捨てたビューポートの中に収まる", () => {
    const vp = { width: 100.7, height: 50.3 };
    const r = toCssRect({ x0: 0, y0: 0, x1: 10, y1: 10 }, img, vp);
    for (const v of [r.x, r.y, r.width, r.height]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(r.x + r.width).toBeLessThanOrEqual(100);
    expect(r.y + r.height).toBeLessThanOrEqual(50);
    expect(r).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    const inner = toCssRect(rect, img, vp);
    for (const v of [inner.x, inner.y, inner.width, inner.height]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("coverage", () => {
  it("重なる矩形は面積を二重に数えるが、結果は1で頭打ちになる", () => {
    const vp = { width: 100, height: 100 };
    const half = { x: 0, y: 0, width: 100, height: 50 };
    // 同じ半分が2枚で、実際の被覆は0.5だが、二重に数えて1になる
    expect(coverage([half, half], vp)).toBe(1);
    // 重なりが小さければ、数え直した分だけ大きく出る
    expect(
      coverage(
        [
          { x: 0, y: 0, width: 50, height: 50 },
          { x: 25, y: 0, width: 50, height: 50 },
        ],
        vp
      )
    ).toBe(0.5);
    expect(coverage([half, half, half], vp)).toBe(1);
  });

  it("面積が0のビューポートは、NaNやInfinityでなく0を返す", () => {
    const r = [{ x: 0, y: 0, width: 10, height: 10 }];
    expect(coverage(r, { width: 0, height: 0 })).toBe(0);
    expect(coverage(r, { width: 0, height: 50 })).toBe(0);
    expect(coverage(r, { width: -10, height: -10 })).toBe(0);
  });

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
