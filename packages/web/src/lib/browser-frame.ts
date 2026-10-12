/**
 * ブラウザ機能のフレーム (サーバーが送るバイナリ) の読み方と、描画待ちの列の整理。
 *
 * フレームは、先頭に11バイトのヘッダ、そのあとに画像 (JPEGかWebP) が続く。数値は
 * big-endianの符号なし。0: 種類、1-2: ビューポートの世代、3-4: x、5-6: y、7-8: 幅、
 * 9-10: 高さ (CSSピクセル)。種類は、1が全画面 (鮮明)、2が全画面 (粗い)、3が矩形。
 * 矩形は、前に描いた絵の上へ重ねる差分なので、届いた順に全部を描く。
 *
 * サーバーが送るのはJPEG。WebPも、手元のブラウザが復号できれば描く (できるかどうかを
 * サーバーと取り決めることはしない)。
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
/** 描けない失敗が続くときに、送り直しを頼む間隔をここまで延ばす (ミリ秒) */
export const REFRESH_INTERVAL_MAX_MS = 8000;
/**
 * canvasの画素数の上限。Safariは、およそ1670万画素を超えるcanvasへの描画を、
 * エラーを出さずに無視する。
 */
export const MAX_CANVAS_PIXELS = 16_000_000;

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

/**
 * ビューポートのCSSピクセル1つに、canvasの画素を縦横いくつずつ持つか。
 *
 * 整数にする。整数でない倍率 (1.25や1.5) だと、矩形の端がcanvasの画素の境目に乗らず、
 * 丸めた分だけ矩形が隣の絵へはみ出す。はみ出した画素は、次の全画面まで直らない。
 * 手元の倍率が1.5以上なら2、それより低ければ1。2倍にすると `MAX_CANVAS_PIXELS` を
 * 超えるビューポートは1。
 */
export function canvasScale(
  viewport: { width: number; height: number },
  devicePixelRatio: number
): 1 | 2 {
  if (!(devicePixelRatio >= 1.5)) return 1;
  const pixels = viewport.width * 2 * viewport.height * 2;
  return pixels > MAX_CANVAS_PIXELS ? 1 : 2;
}

/**
 * 描けない失敗 (復号の失敗など) が `failures` 回続いたあとに、送り直しを頼む間隔の下限。
 * 1回目は `REFRESH_INTERVAL_MS`、続くたびに倍にし、`REFRESH_INTERVAL_MAX_MS` で止める。
 */
export function refreshIntervalMs(failures: number): number {
  let interval = REFRESH_INTERVAL_MS;
  for (let i = 1; i < failures && interval < REFRESH_INTERVAL_MAX_MS; i++) {
    interval *= 2;
  }
  return Math.min(interval, REFRESH_INTERVAL_MAX_MS);
}
