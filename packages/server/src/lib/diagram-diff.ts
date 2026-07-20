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
 */

import type {
  DiagramEdge,
  DiagramField,
  DiagramModel,
  DiagramNode,
} from "./diagram-model.js";

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
    if (!prev) out.push(`${nodeLabel} に ${f.label} を追加`);
    else if (prev.label !== f.label)
      out.push(`${nodeLabel} の ${prev.label} を ${f.label} に変更`);
  }
  for (const f of before) {
    if (!a.has(f.id)) out.push(`${nodeLabel} から ${f.label} を削除`);
  }

  // 追加・削除を除いた並びが変わっていれば並べ替えとして述べる
  const keptBefore = before.filter(f => a.has(f.id)).map(f => f.id);
  const keptAfter = after.filter(f => b.has(f.id)).map(f => f.id);
  if (keptBefore.length > 1 && keptBefore.join(" ") !== keptAfter.join(" ")) {
    const order = after.map(f => f.label).join(", ");
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
    if (!prev) {
      out.push(`${n.label} を追加`);
      continue;
    }
    if (prev.label !== n.label) out.push(`${prev.label} を ${n.label} に改名`);
    out.push(...diffFields(n.label, prev.fields ?? [], n.fields ?? []));
  }
  for (const n of before) {
    // 削除の主語は before 側の label（after には存在しない）
    if (!a.has(n.id)) out.push(`${n.label} を削除`);
  }
  return out;
}

function edgeText(edge: DiagramEdge, nodes: Map<string, DiagramNode>): string {
  const from = nodes.get(edge.from)?.label ?? edge.from;
  const to = nodes.get(edge.to)?.label ?? edge.to;
  const label = edge.label ? `「${edge.label}」` : "";
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
