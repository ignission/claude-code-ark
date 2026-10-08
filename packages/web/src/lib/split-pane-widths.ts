/**
 * split-pane-widths - SplitViewPane の 3 ペイン (左 | ファイル | 図) の幅の制約
 *
 * 左ペインは残りを埋めるので、ファイルと図の希望幅をコンテナ幅に収める。
 * 収まらないときはファイル、図の順に最小幅まで縮め、それでも足りなければ
 * 最小幅のまま返す (そのぶん左ペインが LEFT_MIN_WIDTH より縮む)。
 */

export const LEFT_MIN_WIDTH = 360;
export const FILE_MIN_WIDTH = 360;
export const BOARD_MIN_WIDTH = 320;
/** リサイザの幅 (w-1 = 4px) */
export const RESIZER_WIDTH = 4;

/** 希望幅を、コンテナ幅と最小幅の制約に収める。ファイル、図の順に縮める。閉じているペインは 0 として扱う */
export function fitPaneWidths(input: {
  total: number;
  /** null = 閉じている */
  file: number | null;
  board: number | null;
}): { file: number; board: number } {
  const file = input.file ?? 0;
  const board = input.board ?? 0;
  const resizers =
    (input.file === null ? 0 : RESIZER_WIDTH) +
    (input.board === null ? 0 : RESIZER_WIDTH);
  const room = input.total - LEFT_MIN_WIDTH - resizers;
  let excess = file + board - room;
  if (excess <= 0) return { file, board };

  const fileShrink =
    input.file === null
      ? 0
      : Math.min(excess, Math.max(0, file - FILE_MIN_WIDTH));
  excess -= fileShrink;
  const boardShrink =
    input.board === null
      ? 0
      : Math.min(excess, Math.max(0, board - BOARD_MIN_WIDTH));
  return { file: file - fileShrink, board: board - boardShrink };
}
