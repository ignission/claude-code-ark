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

const BODY_MAX_LENGTH = 300;
const ID_MAX_LENGTH = 80;
const ELLIPSIS = "…";
const MAX_DETAILED_BLOCKS = 10;

function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 31 ||
    (codePoint >= 127 && codePoint <= 159) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

/**
 * 空白 (改行含む) を1つの半角空白に畳んでから、残った制御文字を落として
 * maxLength で切る。
 *
 * 先に空白を畳むのは、改行を「単語の連結」ではなく「区切り」として扱うため。
 * 制御文字の除去を先にすると改行そのものが消えて隣接語がくっつくため、
 * 必ず空白畳み込み → 制御文字除去の順にする。
 */
function sanitizeText(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/gu, " ");
  const stripped = Array.from(collapsed)
    .filter(ch => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join("")
    .trim();
  const characters = Array.from(stripped);
  if (characters.length <= maxLength) return stripped;
  return characters.slice(0, maxLength - 1).join("") + ELLIPSIS;
}

/** ブロック本文を無害化する (300文字で切る) */
function sanitizeBody(text: string): string {
  return sanitizeText(text, BODY_MAX_LENGTH);
}

/** id を無害化する (80文字で切る)。diagram-diff.ts の sanitizeLabel(node.id) と同じ扱い */
function sanitizeId(id: string): string {
  return sanitizeText(id, ID_MAX_LENGTH);
}

interface ChangeEntry {
  /** 元の (無害化前の) id。10件打ち切り後の列挙で使う */
  id: string;
  line: string;
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
        id,
        line: `[${label}] ブロックを追加: ${sanitizeBody(block.text)}`,
      });
      continue;
    }
    if (previous.text !== block.text) {
      entries.push({ id, line: `[${label}] ${sanitizeBody(block.text)}` });
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      entries.push({ id, line: `[${sanitizeId(id)}] ブロックを削除` });
    }
  }

  if (entries.length <= MAX_DETAILED_BLOCKS) return entries.map(e => e.line);

  const head = entries.slice(0, MAX_DETAILED_BLOCKS).map(e => e.line);
  const rest = entries.slice(MAX_DETAILED_BLOCKS);
  const restIds = rest.map(e => sanitizeId(e.id));
  head.push(
    `他に ${restIds.length} 件変更: ${restIds.join(", ")}（board_read で引ける）`
  );
  return head;
}
