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
 * ただし node / field / edge の label と、node の noteText / kind / id は
 * 外部入力である（ユーザーのインライン編集、または他人が PR で持ち込む
 * .diagram.html 内のモデル JSON）。これらをテンプレートへ素通しすると、
 * この前提が崩れて任意の指示文を注入できてしまう。そのため文へ挿入する
 * 直前に sanitizeLabel() を通す（node は nodeDisplayName() 内で行う）。
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
const NOTE_EXCERPT_LENGTH = 20;

/**
 * 生成文から除去すべきコードポイントかを判定する。
 * C0 制御文字（0-31）・DEL（127）・C1 制御文字（128-159、改行扱いされうる
 * NEL U+0085 を含む）に加え、C0 ではないが改行として描画されうる
 * U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR も対象にする
 * （1行封じ込めの注入対策を迂回させないため）
 */
function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 31 ||
    (codePoint >= 127 && codePoint <= 159) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
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
function sanitizeLabel(
  label: string,
  fallback: string = LABEL_FALLBACK
): string {
  const stripped = Array.from(label)
    .filter(ch => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join("")
    .trim();
  if (stripped.length === 0) return fallback;
  if (stripped.length <= LABEL_MAX_LENGTH) return stripped;
  return (
    stripped.slice(0, LABEL_MAX_LENGTH - LABEL_ELLIPSIS.length) + LABEL_ELLIPSIS
  );
}

/**
 * メモ本文の意味比較用キー。制御文字を落とし前後空白を除く（長さは切らない）。
 * "" → "\n" のような空白だけの編集を「本文を削除」と誤報告しないための比較軸
 */
function noteBodyKey(noteText: string | undefined): string {
  if (typeof noteText !== "string") return "";
  return Array.from(noteText)
    .filter(ch => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join("")
    .trim();
}

/** メモ本文を生成文向けの抜粋（sanitize + 先頭20文字）にする。空なら null */
function noteExcerpt(noteText: string): string | null {
  const sanitized = sanitizeLabel(noteText, "");
  if (sanitized.length === 0) return null;
  const characters = Array.from(sanitized);
  return characters.length > NOTE_EXCERPT_LENGTH
    ? `${characters.slice(0, NOTE_EXCERPT_LENGTH).join("")}${LABEL_ELLIPSIS}`
    : sanitized;
}

/** node の label、メモ本文、種別と id の順で生成文向けの表示名を解決する */
function nodeDisplayName(node: DiagramNode): string {
  const label = sanitizeLabel(node.label ?? "");
  if (label !== LABEL_FALLBACK) return label;

  if (typeof node.noteText === "string") {
    const excerpt = noteExcerpt(node.noteText);
    if (excerpt !== null) return `メモ「${excerpt}」`;
  }

  const id = sanitizeLabel(node.id);
  return node.kind
    ? `${sanitizeLabel(node.kind)} ノード (${id})`
    : `ノード (${id})`;
}

/** noteText 由来の表示名だけは、日本語の鉤括弧に助詞を直結する */
function isNoteExcerptDisplayName(
  node: DiagramNode,
  displayName: string
): boolean {
  return (
    sanitizeLabel(node.label ?? "") === LABEL_FALLBACK &&
    displayName.startsWith("メモ「") &&
    displayName.endsWith("」")
  );
}

function withParticle(
  displayName: string,
  particle: string,
  compact: boolean
): string {
  return `${displayName}${compact ? "" : " "}${particle}`;
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map(i => [i.id, i]));
}

/** フィールド列の差分を述べる（追加・削除・改名・並べ替え） */
function diffFields(
  nodeLabel: string,
  compactNodeLabel: boolean,
  before: DiagramField[],
  after: DiagramField[]
): string[] {
  const out: string[] = [];
  const b = byId(before);
  const a = byId(after);

  for (const f of after) {
    const prev = b.get(f.id);
    if (!prev)
      out.push(
        `${withParticle(nodeLabel, "に", compactNodeLabel)} ${sanitizeLabel(f.label)} を追加`
      );
    else if (prev.label !== f.label)
      out.push(
        `${withParticle(nodeLabel, "の", compactNodeLabel)} ${sanitizeLabel(prev.label)} を ${sanitizeLabel(f.label)} に変更`
      );
  }
  for (const f of before) {
    if (!a.has(f.id))
      out.push(
        `${withParticle(nodeLabel, "から", compactNodeLabel)} ${sanitizeLabel(f.label)} を削除`
      );
  }

  // 追加・削除を除いた並びが変わっていれば並べ替えとして述べる
  const keptBefore = before.filter(f => a.has(f.id)).map(f => f.id);
  const keptAfter = after.filter(f => b.has(f.id)).map(f => f.id);
  if (keptBefore.length > 1 && keptBefore.join(" ") !== keptAfter.join(" ")) {
    const order = after.map(f => sanitizeLabel(f.label)).join(", ");
    out.push(
      `${withParticle(nodeLabel, "の", compactNodeLabel)}フィールド順を ${order} に変更`
    );
  }
  return out;
}

function diffNodes(before: DiagramNode[], after: DiagramNode[]): string[] {
  const out: string[] = [];
  const b = byId(before);
  const a = byId(after);

  for (const n of after) {
    const prev = b.get(n.id);
    const label = nodeDisplayName(n);
    const compactLabel = isNoteExcerptDisplayName(n, label);
    if (!prev) {
      out.push(`${withParticle(label, "を", compactLabel)}追加`);
      continue;
    }
    if (prev.label !== n.label) {
      const prevLabel = nodeDisplayName(prev);
      out.push(
        `${withParticle(prevLabel, "を", isNoteExcerptDisplayName(prev, prevLabel))} ${withParticle(label, "に", compactLabel)}改名`
      );
    }
    // 変更前後の両方が意味を持つ差分（種別・メモ本文）の主語は before 側の
    // 表示名にする。note の表示名は noteText 由来のため、after 側を主語に
    // すると「新本文の本文を新本文に変更」と同語反復になる
    const prevSubject = nodeDisplayName(prev);
    const compactPrevSubject = isNoteExcerptDisplayName(prev, prevSubject);
    if ((prev.kind ?? "") !== (n.kind ?? "")) {
      const prevKind = sanitizeLabel(prev.kind ?? "", "(未指定)");
      const nextKind = sanitizeLabel(n.kind ?? "", "(未指定)");
      out.push(
        `${withParticle(prevSubject, "の", compactPrevSubject)}種別を ${prevKind} から ${nextKind} に変更`
      );
    }
    if (noteBodyKey(prev.noteText) !== noteBodyKey(n.noteText)) {
      const excerpt =
        typeof n.noteText === "string" ? noteExcerpt(n.noteText) : null;
      out.push(
        excerpt === null
          ? `${withParticle(prevSubject, "の", compactPrevSubject)}本文を削除`
          : `${withParticle(prevSubject, "の", compactPrevSubject)}本文を「${excerpt}」に変更`
      );
    }
    out.push(
      ...diffFields(label, compactLabel, prev.fields ?? [], n.fields ?? [])
    );
  }
  for (const n of before) {
    // 削除の主語は before 側の label（after には存在しない）
    if (!a.has(n.id)) {
      const label = nodeDisplayName(n);
      out.push(
        `${withParticle(label, "を", isNoteExcerptDisplayName(n, label))}削除`
      );
    }
  }
  return out;
}

function edgeText(edge: DiagramEdge, nodes: Map<string, DiagramNode>): string {
  const fromNode = nodes.get(edge.from);
  const toNode = nodes.get(edge.to);
  const from = fromNode ? nodeDisplayName(fromNode) : sanitizeLabel(edge.from);
  const to = toNode ? nodeDisplayName(toNode) : sanitizeLabel(edge.to);
  const label = edge.label ? `「${sanitizeLabel(edge.label)}」` : "";
  return `${withParticle(from, "から", fromNode ? isNoteExcerptDisplayName(fromNode, from) : false)} ${withParticle(to, "への", toNode ? isNoteExcerptDisplayName(toNode, to) : false)}関連${label}`;
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
