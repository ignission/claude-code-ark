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
 *
 * 例外 (1つだけ):
 *   会話ビューの帯 (`liveTail`) は、末尾にある入力欄の枠から下を出さない
 *   (`dropTrailingPromptBox`)。帯は数行しかなく、枠と状態の行で半分が埋まるため。
 *   見るのは行の形 (罫線だけの行が2本あるか) だけで、行の中身は読まず、
 *   残す行は書き換えない。形が合わなければ何も落とさない。
 *   AUQ カードの「直前の画面」には使わない。
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
  // 上限は有限な正整数へ丸める。0 や負値を通すと末尾切り出しの
  // `slice(-0)` が全文を返し、サイズ上限の不変条件が破れる
  const clamp = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1
      ? Math.floor(value)
      : fallback;
  const maxLines = clamp(opts.maxLines, DEFAULT_MAX_LINES);
  const maxChars = clamp(opts.maxChars, DEFAULT_MAX_CHARS);

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
  if (text.length > maxChars) return sliceTailByCodePoint(text, maxChars);
  return text;
}

/**
 * 末尾から最大 maxChars コード単位を、コードポイント境界を保って切り出す。
 * 素の `slice(-n)` は境界にサロゲートペア（絵文字等）があると片割れを残し、
 * 壊れた文字を作る。verbatim で渡すという不変条件に反するため使わない。
 */
function sliceTailByCodePoint(text: string, maxChars: number): string {
  let start = text.length - maxChars;
  // 下位サロゲートから始まってしまう場合は 1 つ手前（上位サロゲート）へ寄せず、
  // 1 つ後ろへずらして壊れた片割れを落とす
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

/** 罫線の文字だけが並ぶ行。折り返した罫線の端切れ (数文字) もこれに当たる */
const PROMPT_BOX_RULE_FRAGMENT = /^─+$/;
/** 罫線とみなす最小の長さ (続けて並ぶ行の合計) */
const PROMPT_BOX_RULE_MIN_LENGTH = 10;
/** 下の罫線を探す範囲 (末尾からの、空でない行の数)。枠の下には状態の行が数行ある */
const PROMPT_BOX_FOOTER_LINES = 6;
/** 上の罫線を探す範囲 (下の罫線からの行数)。入力欄は複数行になりうる */
const PROMPT_BOX_BODY_LINES = 15;

/**
 * 末尾にある入力欄の枠 (罫線2本と、その間と下の行) を落とす。
 * 罫線だけの行が、末尾の近くに2本並んでいるときだけ、上の罫線から下を捨てる。
 * - 2本は同じ形 (同じ字下げ、同じ長さ) でなければならない。出力の中の区切り線と
 *   枠の罫線を組にして、出力や確認の選択肢を落とさないため
 * - 続けて並ぶ罫線の行は1本として数え、長さは合計で比べる (幅を狭めた端末では
 *   罫線が折り返し、端切れは数文字になる)
 * 形が合わないとき (確認の選択肢が出ている画面など) と、落とすと何も残らないときは、
 * 渡された文字列をそのまま返す。
 */
export function dropTrailingPromptBox(raw: string): string {
  const lines = raw.split("\n");
  const isFragment = (index: number) =>
    PROMPT_BOX_RULE_FRAGMENT.test(lines[index].trim());
  // index で終わる、続けて並ぶ罫線の行のまとまり。合計が短ければ罫線ではない (null)
  const ruleRunEndingAt = (index: number) => {
    let start = index;
    while (start > 0 && isFragment(start - 1)) start--;
    let length = 0;
    for (let i = start; i <= index; i++) length += lines[i].trim().length;
    const indent = lines[start].length - lines[start].trimStart().length;
    return {
      start,
      shape:
        length >= PROMPT_BOX_RULE_MIN_LENGTH ? `${indent}:${length}` : null,
    };
  };

  let lower: { start: number; shape: string } | null = null;
  let footer = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "") continue;
    if (isFragment(i)) {
      const run = ruleRunEndingAt(i);
      if (run.shape !== null) {
        lower = { start: run.start, shape: run.shape };
        break;
      }
    }
    footer++;
    if (footer >= PROMPT_BOX_FOOTER_LINES) break;
  }
  if (!lower) return raw;

  let upperStart = -1;
  const bodyTop = Math.max(0, lower.start - PROMPT_BOX_BODY_LINES);
  for (let i = lower.start - 1; i >= bodyTop; i--) {
    if (!isFragment(i)) continue;
    const run = ruleRunEndingAt(i);
    if (run.shape === null) {
      i = run.start;
      continue;
    }
    if (run.shape === lower.shape) upperStart = run.start;
    break;
  }
  if (upperStart < 0) return raw;

  const kept = lines.slice(0, upperStart);
  if (kept.every(line => line.trim() === "")) return raw;
  return kept.join("\n");
}
