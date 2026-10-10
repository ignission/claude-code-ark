/**
 * split-pane-widths - SplitViewPane の 2 ペイン (左 | 作業エリア) の幅の制約
 *
 * 左ペインは残りを埋めるので、作業エリアの希望幅をコンテナ幅に収める。
 * 収まらないときは最小幅まで縮め、それでも足りなければ最小幅のまま返す
 * (そのぶん左ペインが LEFT_MIN_WIDTH より縮む)。
 */

export const LEFT_MIN_WIDTH = 360;
export const WORK_AREA_MIN_WIDTH = 360;
/** リサイザの幅 (w-2 = 8px。パネルの間のすき間を兼ねる) */
export const RESIZER_WIDTH = 8;
/** ピークを出している間、作業エリアをここまで広げる (図とコードを並べて読める幅) */
export const PEEK_WORK_AREA_WIDTH = 900;
/** 「Git」のタブを見ている間、作業エリアをここまで広げる (グラフと件名が並ぶ幅) */
export const GIT_WORK_AREA_WIDTH = 760;

/** 希望幅を、左ペインの最小幅を残せる範囲に収める。作業エリアの最小幅は割らない */
export function fitWorkAreaWidth(total: number, desired: number): number {
  const max = total - LEFT_MIN_WIDTH - RESIZER_WIDTH;
  return Math.max(WORK_AREA_MIN_WIDTH, Math.min(desired, max));
}

/**
 * ピークを出している間の作業エリアの下限。コンテナ幅が分からない (0 以下) ときは
 * PEEK_WORK_AREA_WIDTH をそのまま返す
 */
export function peekWorkAreaFloor(total: number): number {
  if (total <= 0) return PEEK_WORK_AREA_WIDTH;
  return fitWorkAreaWidth(total, PEEK_WORK_AREA_WIDTH);
}

/**
 * 「Git」のタブを見ている間の作業エリアの下限。コンテナ幅が分からない (0 以下) ときは
 * GIT_WORK_AREA_WIDTH をそのまま返す
 */
export function gitWorkAreaFloor(total: number): number {
  if (total <= 0) return GIT_WORK_AREA_WIDTH;
  return fitWorkAreaWidth(total, GIT_WORK_AREA_WIDTH);
}
