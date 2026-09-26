/**
 * ファイルビューアの行ハイライト。
 *
 * 以前は shiki が描いた DOM を effect から直接書き換えていたが、その inline style は
 * 再描画で失われ、約 600ms で消えていた (#481)。ハイライトは shiki の出力そのものへ
 * 焼き込み、React が何度描き直しても残る形にする。
 */

/**
 * ハイライトする行の背景。
 *
 * `display:block` は付けない。shiki の出力は行 span の後ろに改行文字を持つので、
 * 行を block にすると改行が二重になり 1 行おきに空行が入る。行全体へ敷くのは
 * `<code>` 側を grid にして 1 行 = 1 row にすることで行う (FileViewerPane)
 */
export const HIGHLIGHT_LINE_STYLE = "background-color:rgba(56,139,253,.28);";

/** shiki の出力で目印に使う class。スクロール先の特定にも使う */
export const HIGHLIGHT_LINE_CLASS = "ark-target-line";

/**
 * `line` (1 始まり) がハイライト対象か。
 * `end` が無ければ `start` の 1 行だけ。`end` が `start` より小さいときは入れ替える
 */
export function isHighlightedLine(
  line: number,
  start?: number | null,
  end?: number | null
): boolean {
  if (!start || start < 1) return false;
  if (!end || end < 1) return line === start;
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return line >= from && line <= to;
}
