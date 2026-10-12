/**
 * browser-frame-diff の周辺のテストで、監視フレームのPNGを組み立てる道具。
 * テストからだけ読む。チャンクのCRCは復号側が見ないので0を入れる。
 */

import { deflateSync } from "node:zlib";

export interface BuildPngOptions {
  width: number;
  height: number;
  /** 行優先の生の画素。channels が3ならRGB、4ならRGBA。長さは width * height * channels */
  pixels: Uint8Array | number[];
  /** 既定は3 (color type 2)。4なら color type 6 */
  channels?: 3 | 4;
  /** 全行に使うfilter type (0〜4)、または行ごとの配列。既定は0 */
  filter?: number | number[];
  /** IDATを何個に分けるか。既定は1 */
  idatChunks?: number;
  /** IHDRのbit depth。既定は8 */
  bitDepth?: number;
  /** IHDRのcolor type。既定は channels から決める */
  colorType?: number;
  /** IHDRのinterlace method。既定は0 */
  interlace?: number;
  /** IHDRに書く幅・高さ。実データと食い違わせるテスト用 */
  headerWidth?: number;
  headerHeight?: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 生の行をfilter type に従ってフィルタし、行頭にfilter typeを付けたバイト列にする */
export function filterRows(
  pixels: Uint8Array | number[],
  width: number,
  height: number,
  channels: number,
  filter: number | number[]
): Buffer {
  const stride = width * channels;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = typeof filter === "number" ? filter : (filter[y] ?? 0);
    out[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const cur = pixels[y * stride + i];
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c =
        y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) pred = paeth(a, b, c);
      out[y * (stride + 1) + 1 + i] = (cur - pred) & 0xff;
    }
  }
  return out;
}

/** 有効なPNGを組み立てる。オプションで壊した形も作れる */
export function buildPng(options: BuildPngOptions): Buffer {
  const channels = options.channels ?? 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(options.headerWidth ?? options.width, 0);
  ihdr.writeUInt32BE(options.headerHeight ?? options.height, 4);
  ihdr[8] = options.bitDepth ?? 8;
  ihdr[9] = options.colorType ?? (channels === 4 ? 6 : 2);
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = options.interlace ?? 0;

  const raw = filterRows(
    options.pixels,
    options.width,
    options.height,
    channels,
    options.filter ?? 0
  );
  const compressed = deflateSync(raw);
  const count = Math.max(1, options.idatChunks ?? 1);
  const size = Math.ceil(compressed.length / count);
  const idats: Buffer[] = [];
  for (let i = 0; i < compressed.length; i += size) {
    idats.push(pngChunk("IDAT", compressed.subarray(i, i + size)));
  }

  return Buffer.concat([
    SIGNATURE,
    pngChunk("IHDR", ihdr),
    ...idats,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 単色で塗った画素列 (RGB) */
export function solidRgb(
  width: number,
  height: number,
  rgb: [number, number, number]
): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) out.set(rgb, i * 3);
  return out;
}

/** 単色のPNG。指定した画素だけ色を変えられる */
export function buildSolidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
  dots: Array<{ x: number; y: number; rgb: [number, number, number] }> = []
): Buffer {
  const pixels = solidRgb(width, height, rgb);
  for (const d of dots) pixels.set(d.rgb, (d.y * width + d.x) * 3);
  return buildPng({ width, height, pixels });
}
