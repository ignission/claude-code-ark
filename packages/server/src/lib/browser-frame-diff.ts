/**
 * 監視フレームの復号と差分。
 *
 * リモートのブラウザ画面は、全画面のJPEGを毎回送ると重い。そこで、縮小した小さな
 * PNG (監視フレーム) を流し続け、前のフレームとの差から「どこが変わったか」だけを
 * 知り、その矩形だけを実寸で撮り直す。監視フレームを低解像度にするのは、復号と
 * 比較を軽くするため。変わった場所さえ分かればよく、中身の精細さは要らない。
 *
 * PNGを使うのは可逆だから。非可逆の形式だと、変わっていない画素までゆらいで、
 * 差分が常に出てしまう。
 *
 * 復号は `node:zlib` だけで書く最小限の実装で、8bitのRGB / RGBAでインターレース無しの
 * PNGだけを受ける。対応外や壊れたデータは例外ではなく null を返す。呼び出し側が
 * 「全面が変わった」に倒せば、画面は正しいまま重くなるだけで済むため。
 */

import { inflateSync } from "node:zlib";

/** 復号した監視フレーム。data は行優先で1画素3バイト (RGB)。αは捨てる */
export interface MonitorImage {
  width: number;
  height: number;
  data: Buffer;
}

/** 監視フレームの画素単位の矩形 (x1 / y1 は含まない) */
export interface CellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** CSSピクセルの矩形 */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 矩形がこれを超えたら、細かく撮り直すより全体を1枚で撮るほうが速い */
export const MAX_RECTS = 4;

/** 受け付ける幅・高さの上限。これを超える値は壊れたデータとみなし、確保をしない */
const MAX_DIMENSION = 4096;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNGを復号する。対応外 (8bitのRGB / RGBA以外、インターレース、壊れたデータ) は null */
export function decodePng(png: Buffer): MonitorImage | null {
  try {
    return decode(png);
  } catch {
    return null;
  }
}

function decode(png: Buffer): MonitorImage | null {
  if (png.length < SIGNATURE.length) return null;
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (png[i] !== SIGNATURE[i]) return null;
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  let hasHeader = false;
  const idat: Buffer[] = [];

  let pos = SIGNATURE.length;
  while (pos + 8 <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + length;
    // データとCRC (4バイト) がバッファに収まらない
    if (end + 4 > png.length) return null;

    if (type === "IHDR") {
      if (length !== 13) return null;
      width = png.readUInt32BE(start);
      height = png.readUInt32BE(start + 4);
      const bitDepth = png[start + 8];
      const colorType = png[start + 9];
      const interlace = png[start + 12];
      if (bitDepth !== 8 || interlace !== 0) return null;
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else return null;
      if (
        width < 1 ||
        height < 1 ||
        width > MAX_DIMENSION ||
        height > MAX_DIMENSION
      )
        return null;
      hasHeader = true;
    } else if (type === "IDAT") {
      idat.push(png.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    pos = end + 4;
  }
  if (!hasHeader || idat.length === 0) return null;

  const stride = width * channels;
  const expected = height * (stride + 1);
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  if (raw.length !== expected) return null;

  unfilter(raw, height, stride, channels);

  const data = Buffer.alloc(width * height * 3);
  let out = 0;
  for (let y = 0; y < height; y++) {
    let src = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++) {
      data[out++] = raw[src];
      data[out++] = raw[src + 1];
      data[out++] = raw[src + 2];
      src += channels;
    }
  }
  return { width, height, data };
}

/** 行頭のfilter typeに従い、raw を画素値へその場で戻す。未知のfilter typeは例外にする */
function unfilter(
  raw: Buffer,
  height: number,
  stride: number,
  bpp: number
): void {
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const filter = raw[row];
    const cur = row + 1;
    const prev = y > 0 ? row - stride : -1;
    if (filter > 4) throw new Error("unknown filter");
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? raw[cur + i - bpp] : 0;
      const b = prev >= 0 ? raw[prev + i] : 0;
      const c = prev >= 0 && i >= bpp ? raw[prev + i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) add = paeth(a, b, c);
      raw[cur + i] = (raw[cur + i] + add) & 0xff;
    }
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 2枚を比べ、変わった画素をつながりごとの矩形にまとめる。
 * 寸法が違えば "full"。変化が無ければ空の配列。
 * 8近傍でつながる画素を1つの矩形にし、矩形どうしが重なるか接していれば1つにまとめる。
 * 矩形が MAX_RECTS (4) を超えたら、全体を囲む1つにする。
 */
export function diffImages(
  prev: MonitorImage,
  next: MonitorImage
): CellRect[] | "full" {
  if (prev.width !== next.width || prev.height !== next.height) return "full";
  const { width, height } = next;
  const a = prev.data;
  const b = next.data;

  // 0: 変わっていない、1: 変わった未訪問、2: 訪問済み
  const mark = new Uint8Array(width * height);
  let changed = 0;
  for (let i = 0; i < mark.length; i++) {
    const o = i * 3;
    if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) {
      mark[i] = 1;
      changed++;
    }
  }
  if (changed === 0) return [];

  let boxes: CellRect[] = [];
  const stack = new Int32Array(changed);
  for (let start = 0; start < mark.length; start++) {
    if (mark[start] !== 1) continue;
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    let top = 0;
    stack[top++] = start;
    mark[start] = 2;
    while (top > 0) {
      const p = stack[--top];
      const px = p % width;
      const py = (p - px) / width;
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (px + 1 > x1) x1 = px + 1;
      if (py + 1 > y1) y1 = py + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mark[n] === 1) {
            mark[n] = 2;
            stack[top++] = n;
          }
        }
      }
    }
    boxes.push({ x0, y0, x1, y1 });
  }

  boxes = mergeTouching(boxes);
  if (boxes.length > MAX_RECTS) return [enclose(boxes)];
  return boxes;
}

/** 重なるか接している矩形を、変化が無くなるまで1つにまとめる */
function mergeTouching(input: CellRect[]): CellRect[] {
  const boxes = input.slice();
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i];
        const q = boxes[j];
        if (p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1) {
          boxes[i] = enclose([p, q]);
          boxes.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return boxes;
}

function enclose(rects: CellRect[]): CellRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (r.x0 < x0) x0 = r.x0;
    if (r.y0 < y0) y0 = r.y0;
    if (r.x1 > x1) x1 = r.x1;
    if (r.y1 > y1) y1 = r.y1;
  }
  return { x0, y0, x1, y1 };
}

/**
 * 監視フレームの矩形を、ビューポートのCSSピクセルの矩形へ直す。
 * 上下左右に監視1画素ぶん広げ (縮小の丸めとアンチエイリアスのにじみを覆う)、
 * 整数へ外向きに丸め、ビューポートの中に収める。
 */
export function toCssRect(
  rect: CellRect,
  image: { width: number; height: number },
  viewport: { width: number; height: number }
): CssRect {
  const sx = viewport.width / image.width;
  const sy = viewport.height / image.height;
  const x0 = clamp(Math.floor((rect.x0 - 1) * sx), 0, viewport.width - 1);
  const y0 = clamp(Math.floor((rect.y0 - 1) * sy), 0, viewport.height - 1);
  const x1 = clamp(
    Math.ceil((rect.x1 + 1) * sx),
    x0 + 1,
    Math.max(viewport.width, x0 + 1)
  );
  const y1 = clamp(
    Math.ceil((rect.y1 + 1) * sy),
    y0 + 1,
    Math.max(viewport.height, y0 + 1)
  );
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 矩形の面積の合計が、ビューポートの面積に占める割合 (0〜1。重なりは数え直さない) */
export function coverage(
  rects: CssRect[],
  viewport: { width: number; height: number }
): number {
  const total = viewport.width * viewport.height;
  if (rects.length === 0 || total <= 0) return 0;
  let area = 0;
  for (const r of rects) area += r.width * r.height;
  return Math.min(1, area / total);
}
