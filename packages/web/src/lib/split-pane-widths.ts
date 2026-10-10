/**
 * split-pane-widths - SplitViewPane の 2 ペイン (左 | 作業エリア) の幅の制約
 *
 * 幅を持つのは左ペイン (端末 / 会話) で、作業エリアは残りを埋める。作業エリアに幅を
 * 持たせると、ピークを開く・タブを替えるたびに会話の幅が変わり、文章の折り返しが動く。
 *
 * 左ペインの希望幅をコンテナ幅に収める。作業エリアの最小幅を残せないときは左を縮め、
 * 左の最小幅も割る (作業エリアの最小幅を優先する)。
 */

export const LEFT_MIN_WIDTH = 360;
export const WORK_AREA_MIN_WIDTH = 360;
/** リサイザの幅 (w-2 = 8px。パネルの間のすき間を兼ねる) */
export const RESIZER_WIDTH = 8;
/** 保存した幅が無いときの左ペインの幅 (会話の 1 行が読みやすく、端末で 60 桁強が入る幅) */
export const LEFT_DEFAULT_WIDTH = 520;

/**
 * 左ペインの希望幅を、作業エリアの最小幅を残せる範囲に収める。
 * コンテナ幅が分からない (0 以下) ときは希望幅をそのまま返す
 */
export function fitLeftWidth(total: number, desired: number): number {
  if (total <= 0) return desired;
  const max = Math.max(0, total - WORK_AREA_MIN_WIDTH - RESIZER_WIDTH);
  return Math.max(Math.min(LEFT_MIN_WIDTH, max), Math.min(desired, max));
}
