/**
 * auq-screen-context - AUQ カード「直前の画面」スナップショットの整形
 *
 * 背景:
 *   対話版 claude は AUQ を含むターン全体 (直前のテキスト + tool_use +
 *   tool_result) を回答確定時にまとめて JSONL へ書くため、質問表示中は
 *   直前の会話文脈が transcript に存在しない。カードに文脈を出すには
 *   hook 受信時点の tmux 画面 (= ストリーム済みの直前テキストが表示
 *   されている) を capture するしかない。
 *
 * 原則との境界 (重要):
 *   「画面テキストのパース全面禁止」の原則が禁じるのは画面を構造に
 *   *解釈* すること。このモジュールは capture-pane 出力を一切解釈せず
 *   verbatim のまま表示用に渡す (行う加工は末尾空行の除去とサイズ上限
 *   のみ)。existence チェック (bridgeStatus) と同じ側の許容範囲であり、
 *   ここに正規表現での内容抽出等を足してはならない。
 */

/** hook 受信時に capture-pane へ要求する行数 (scrollback 込み) */
export const AUQ_SCREEN_CAPTURE_LINES = 60;

const DEFAULT_MAX_LINES = 40;
const DEFAULT_MAX_CHARS = 4000;

/**
 * capture-pane の生出力を「直前の画面」表示用に整形する。
 * 内容の解釈はしない。null / 空白のみは null (カード側は非表示)。
 */
export function buildAuqScreenContext(
  raw: string | null,
  opts: { maxLines?: number; maxChars?: number } = {}
): string | null {
  if (raw === null) return null;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  const lines = raw.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  if (end === 0) return null;

  // 直近 (末尾) 側を優先して残す。上限超過は行単位で古い側から落とす
  let kept = lines.slice(Math.max(0, end - maxLines), end);
  while (kept.length > 1 && kept.join("\n").length > maxChars) {
    kept = kept.slice(1);
  }
  const text = kept.join("\n");
  if (text.length > maxChars) return text.slice(-maxChars);
  return text;
}
