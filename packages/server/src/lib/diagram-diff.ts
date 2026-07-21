/**
 * モデルの差分を意味の文にする。
 *
 * 原則1（図は意味モデルの投影）が求めるのは「Order に cancelled_at を追加」で
 * あって「$.nodes[0].fields[3] が追加」ではない。この変換を成り立たせるために
 * コア語彙を固定している（判断4.3）。
 *
 * 文面をサーバーが組むのは注入対策でもある（判断4.2）。iframe からは構造化
 * モデルしか受け取らないため、生成コードや他人が書いた図が任意の散文を
 * 会話へ流し込めない。
 *
 * ただし node / field / edge の label 自体は外部入力である（ユーザーの
 * インライン編集、または他人が PR で持ち込む .diagram.html 内のモデル
 * JSON）。label をテンプレートへ素通しすると、この前提が崩れて label
 * 経由で任意の指示文を注入できてしまう。そのため文へ挿入する直前に
 * sanitizeLabel() を通す。
 */

import type {
  DiagramEdge,
  DiagramField,
  DiagramModel,
  DiagramNode,
} from "./diagram-model.js";

const LABEL_MAX_LENGTH = 80;
const LABEL_ELLIPSIS = "…";
const LABEL_FALLBACK = "(無題)";

/** C0制御文字（コードポイント 0-31）と DEL（127）かどうかを判定する */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 31 || codePoint === 127;
}

/**
 * label を生成文へ挿入する前に無害化する。
 *
 * エスケープ（引用符で囲む・特殊文字を \ で潰す等）ではなく除去にしている
 * 理由: 生成文の受け手は tmux 越しの対話版 Claude であり、シェルやHTMLの
 * ようにエスケープ記法を機械的に解釈する文脈ではない。エスケープ済みの
 * 文字列も結局「自然文の一部」として素朴に読まれるため、注入対策として
 * 意味を持たずノイズが増えるだけになる。したがって注入に効く要素
 * （改行・制御文字・長さ）そのものを物理的に落とす。
 *
 * - 改行と制御文字を落とす: 生成文を1行に閉じ込め、後続の文が「新しい
 *   指示」に見えるのを防ぐ（最も効く対策）
 * - 長さの上限（80文字）: 長大な label で生成文を埋め尽くすのを防ぐ
 * - 前後の空白を落とす: 見た目を整える
 * - 無害化後に空になった場合は固定の代替文字列にする: 「差分として何も
 *   述べていない」のか「無害化で消えた」のかを区別できるようにする
 *
 * これは表示用の変換であり、モデルに保存される label 自体（呼び出し元が
 * 保持するオブジェクト）は変更しない。
 */
function sanitizeLabel(label: string): string {
  const stripped = Array.from(label)
    .filter(ch => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join("")
    .trim();
  if (stripped.length === 0) return LABEL_FALLBACK;
  if (stripped.length <= LABEL_MAX_LENGTH) return stripped;
  return (
    stripped.slice(0, LABEL_MAX_LENGTH - LABEL_ELLIPSIS.length) + LABEL_ELLIPSIS
  );
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map(i => [i.id, i]));
}

/** フィールド列の差分を述べる（追加・削除・改名・並べ替え） */
function diffFields(
  nodeLabel: string,
  before: DiagramField[],
  after: DiagramField[]
): string[] {
  const out: string[] = [];
  const b = byId(before);
  const a = byId(after);

  for (const f of after) {
    const prev = b.get(f.id);
    if (!prev) out.push(`${nodeLabel} に ${sanitizeLabel(f.label)} を追加`);
    else if (prev.label !== f.label)
      out.push(
        `${nodeLabel} の ${sanitizeLabel(prev.label)} を ${sanitizeLabel(f.label)} に変更`
      );
  }
  for (const f of before) {
    if (!a.has(f.id))
      out.push(`${nodeLabel} から ${sanitizeLabel(f.label)} を削除`);
  }

  // 追加・削除を除いた並びが変わっていれば並べ替えとして述べる
  const keptBefore = before.filter(f => a.has(f.id)).map(f => f.id);
  const keptAfter = after.filter(f => b.has(f.id)).map(f => f.id);
  if (keptBefore.length > 1 && keptBefore.join(" ") !== keptAfter.join(" ")) {
    const order = after.map(f => sanitizeLabel(f.label)).join(", ");
    out.push(`${nodeLabel} のフィールド順を ${order} に変更`);
  }
  return out;
}

function diffNodes(before: DiagramNode[], after: DiagramNode[]): string[] {
  const out: string[] = [];
  const b = byId(before);
  const a = byId(after);

  for (const n of after) {
    const prev = b.get(n.id);
    const label = sanitizeLabel(n.label);
    if (!prev) {
      out.push(`${label} を追加`);
      continue;
    }
    if (prev.label !== n.label)
      out.push(`${sanitizeLabel(prev.label)} を ${label} に改名`);
    out.push(...diffFields(label, prev.fields ?? [], n.fields ?? []));
  }
  for (const n of before) {
    // 削除の主語は before 側の label（after には存在しない）
    if (!a.has(n.id)) out.push(`${sanitizeLabel(n.label)} を削除`);
  }
  return out;
}

function edgeText(edge: DiagramEdge, nodes: Map<string, DiagramNode>): string {
  const from = sanitizeLabel(nodes.get(edge.from)?.label ?? edge.from);
  const to = sanitizeLabel(nodes.get(edge.to)?.label ?? edge.to);
  const label = edge.label ? `「${sanitizeLabel(edge.label)}」` : "";
  return `${from} から ${to} への関連${label}`;
}

function diffEdges(before: DiagramModel, after: DiagramModel): string[] {
  const out: string[] = [];
  const b = byId(before.edges);
  const a = byId(after.edges);
  const beforeNodes = byId(before.nodes);
  const afterNodes = byId(after.nodes);

  for (const e of after.edges) {
    const prev = b.get(e.id);
    if (!prev) out.push(`${edgeText(e, afterNodes)}を追加`);
    else if (
      prev.label !== e.label ||
      prev.from !== e.from ||
      prev.to !== e.to
    ) {
      out.push(
        `${edgeText(prev, beforeNodes)}を ${edgeText(e, afterNodes)} に変更`
      );
    }
  }
  for (const e of before.edges) {
    if (!a.has(e.id)) out.push(`${edgeText(e, beforeNodes)}を削除`);
  }
  return out;
}

/** 旧モデルと新モデルの差分を、意味の文の配列にする。変更が無ければ空配列。 */
export function describeModelDiff(
  before: DiagramModel,
  after: DiagramModel
): string[] {
  return [...diffNodes(before.nodes, after.nodes), ...diffEdges(before, after)];
}
