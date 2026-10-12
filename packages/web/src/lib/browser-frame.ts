/**
 * ブラウザ機能のフレーム (サーバーが送るバイナリ) の読み方と、描画待ちの列の整理。
 *
 * フレームは、先頭に11バイトのヘッダ、そのあとに画像 (JPEGかWebP) が続く。数値は
 * big-endianの符号なし。0: 種類、1-2: ビューポートの世代、3-4: x、5-6: y、7-8: 幅、
 * 9-10: 高さ (CSSピクセル)。種類は、1が全画面 (鮮明)、2が全画面 (粗い)、3が矩形。
 * 矩形は、前に描いた絵の上へ重ねる差分なので、届いた順に全部を描く。
 */

export interface FrameHeader {
  kind: 1 | 2 | 3;
  gen: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FRAME_HEADER_BYTES = 11;
/** 描画待ちの列に持つ数の上限。超えたら取りこぼしとして扱う */
export const FRAME_QUEUE_LIMIT = 64;
/** 全画面の送り直しを頼む間隔の下限 (ミリ秒) */
export const REFRESH_INTERVAL_MS = 500;

export type FrameImageType = "image/jpeg" | "image/webp";

/** 短すぎる、種類が未知、幅か高さが0なら `null` */
export function parseFrameHeader(data: ArrayBuffer): FrameHeader | null {
  if (data.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(data);
  const kind = view.getUint8(0);
  if (kind !== 1 && kind !== 2 && kind !== 3) return null;
  const width = view.getUint16(7);
  const height = view.getUint16(9);
  if (width === 0 || height === 0) return null;
  return {
    kind,
    gen: view.getUint16(1),
    x: view.getUint16(3),
    y: view.getUint16(5),
    width,
    height,
  };
}

/** ヘッダのあとの画像の種類を、先頭のバイトで決める。JPEGでもWebPでもなければ `null` */
export function frameImageType(data: ArrayBuffer): FrameImageType | null {
  const bytes = new Uint8Array(
    data,
    Math.min(FRAME_HEADER_BYTES, data.byteLength)
  );
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  // "RIFF"
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * 描画待ちの列を整理する。全画面 (種類1か2) より前にある同じ世代以前のものは、
 * その全画面で上書きされるので捨てる。世代が `currentGen` と違うものも捨てる。順序は保つ。
 */
export function pruneQueue<T extends { header: FrameHeader }>(
  queue: T[],
  currentGen: number
): T[] {
  const current = queue.filter(item => item.header.gen === currentGen);
  let lastFull = -1;
  for (let i = current.length - 1; i >= 0; i--) {
    if (current[i].header.kind !== 3) {
      lastFull = i;
      break;
    }
  }
  return lastFull > 0 ? current.slice(lastFull) : current;
}
