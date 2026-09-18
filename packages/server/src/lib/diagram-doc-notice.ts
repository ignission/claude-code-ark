/**
 * doc 本文の変更を会話へ送る行にする。
 *
 * 送るのは差分表現ではなく「書き換えた後のブロック本文」。実測でブロック本文は
 * 中央値102文字・平均194文字であり、ファイル全体 (26,504文字) の260分の1に収まる。
 * 差分表現は受け手が元の文を持っていないと復元できないため採らない。
 *
 * ブロック本文も id (`data-ark-id` 属性値) も外部入力 (人間のインライン編集、
 * PR で持ち込まれた .diagram.html) なので、tmux へリテラル送出する前に落とす。
 * id は diagram-model.ts で書式を制限されておらず、doc node の id ともマッチする
 * だけの任意文字列でありうる (diagram-doc-anchors.ts が保証するのは1対1対応だけ)。
 * エスケープではなく除去にする理由は diagram-diff.ts の sanitizeLabel と同じ:
 * 受け手は tmux 越しの対話版 Claude であり、シェルや HTML のようにエスケープ
 * 記法を機械的に解釈する文脈ではない。
 */

import type { DocBlock } from "./diagram-doc-blocks.js";
import { isControlCodePoint } from "./text-sanitize.js";

const BODY_MAX_LENGTH = 300;
const ID_MAX_LENGTH = 80;
const ELLIPSIS = "…";
const MAX_DETAILED_BLOCKS = 10;
/** id が無害化で空文字になったときの代替。diagram-diff.ts の LABEL_FALLBACK と同じ理由 */
const ID_FALLBACK = "(id不明)";
/** 10件打ち切り後の列挙行の末尾。board_read への誘導であり、切り詰めても必ず残す */
const OVERFLOW_SUFFIX = "（board_read で引ける）";

/** 末尾を省略記号に置き換えて maxLength (コードポイント数) 以内に切り詰める */
function truncate(text: string, maxLength: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  return characters.slice(0, maxLength - 1).join("") + ELLIPSIS;
}

/**
 * 空白 (改行含む) は残し、それ以外の制御文字だけを落としたうえで、
 * 空白を1つの半角空白に畳んで maxLength で切る。
 *
 * 制御文字除去を先に (改行も含めて) 行うと、改行が「区切り」ではなく
 * 「単語の連結」として消えてしまう (例: "あ\nい" → "あい")。かといって
 * 空白畳み込みを先にしても、空白ではない制御文字 (NUL 等) が2つの空白に
 * 挟まれている場合にそれだけを消すと空白が連続して残る。そのため
 * 「空白文字は無条件に残す」を filter の条件に含め、除去と畳み込みを
 * 1回の走査に統一する。
 */
function sanitizeText(text: string, maxLength: number): string {
  const stripped = Array.from(text)
    .filter(ch => /\s/u.test(ch) || !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return truncate(stripped, maxLength);
}

/** ブロック本文を無害化する (300文字で切る) */
function sanitizeBody(text: string): string {
  return sanitizeText(text, BODY_MAX_LENGTH);
}

/**
 * id を無害化する (80文字で切る)。diagram-diff.ts の sanitizeLabel(node.id) と同じ扱い。
 * 無害化で空文字になった場合は ID_FALLBACK にする (sanitizeLabel の空文字フォールバックと同じ)
 */
function sanitizeId(id: string): string {
  const sanitized = sanitizeText(id, ID_MAX_LENGTH);
  return sanitized.length === 0 ? ID_FALLBACK : sanitized;
}

interface ChangeEntry {
  /** 無害化済みの id。10件打ち切り後の列挙でそのまま使う (再計算しない) */
  label: string;
  line: string;
}

/**
 * 10件打ち切り後の列挙行を組む。
 *
 * 「まだ変更がある、board_read で引ける」という前置きと誘導文言は、この行の
 * 存在意義そのものであり、件数 (N) は id の列挙より重要な情報。切り詰めが
 * 一番必要になる大量変更のときにこそこれらが欠けては本末転倒なので、300文字に
 * 収めるための切り詰めは id 列挙部分だけに適用し、前置きと誘導文言・件数は
 * 削らない (300文字を超える場合は id 列挙が0文字になっても前置きと誘導文言を
 * 優先する)。
 */
function describeOverflow(restIds: string[]): string {
  const prefix = `他に ${restIds.length} 件変更: `;
  const idsBudget = Math.max(
    0,
    BODY_MAX_LENGTH -
      Array.from(prefix).length -
      Array.from(OVERFLOW_SUFFIX).length
  );
  const idsPart = truncate(restIds.join(", "), idsBudget);
  return `${prefix}${idsPart}${OVERFLOW_SUFFIX}`;
}

export function describeDocBodyChanges(
  before: Map<string, DocBlock>,
  after: Map<string, DocBlock>
): string[] {
  const entries: ChangeEntry[] = [];

  for (const [id, block] of after) {
    const previous = before.get(id);
    const label = sanitizeId(id);
    if (previous === undefined) {
      entries.push({
        label,
        line: `[${label}] ブロックを追加: ${sanitizeBody(block.text)}`,
      });
      continue;
    }
    if (previous.text !== block.text) {
      entries.push({ label, line: `[${label}] ${sanitizeBody(block.text)}` });
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      const label = sanitizeId(id);
      entries.push({ label, line: `[${label}] ブロックを削除` });
    }
  }

  if (entries.length <= MAX_DETAILED_BLOCKS) return entries.map(e => e.line);

  const head = entries.slice(0, MAX_DETAILED_BLOCKS).map(e => e.line);
  const rest = entries.slice(MAX_DETAILED_BLOCKS);
  head.push(describeOverflow(rest.map(e => e.label)));
  return head;
}
