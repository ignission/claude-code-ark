import type { DiagramModel } from "./diagram-model.js";

export type DiagramGraphKindValidation =
  | { ok: true }
  | { ok: false; error: string };

const MODEL_ID_ATTRIBUTE = "data-model-id";
const KIND_ATTRIBUTE = "data-kind";
const MAX_REPORTED_MISMATCHES = 5;

interface ProjectionKind {
  modelId: string;
  kind: string;
}

function tagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return html.length - 1;
}

function projectionKind(tag: string): ProjectionKind | null {
  let modelId: string | undefined;
  let kind: string | undefined;
  let index = tag.match(/^[^\s/>]+/u)?.[0].length ?? 0;
  while (index < tag.length) {
    while (/\s/u.test(tag[index] ?? "")) index += 1;
    if (index >= tag.length || tag[index] === "/") break;
    const name = tag.slice(index).match(/^[^\s"'=<>`/]+/u)?.[0];
    if (name === undefined) {
      index += 1;
      continue;
    }
    index += name.length;
    while (/\s/u.test(tag[index] ?? "")) index += 1;
    let value = "";
    if (tag[index] === "=") {
      index += 1;
      while (/\s/u.test(tag[index] ?? "")) index += 1;
      const quote = tag[index];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, index + 1);
        if (end < 0) {
          index = tag.length;
        } else {
          value = tag.slice(index + 1, end);
          index = end + 1;
        }
      } else {
        value = tag.slice(index).match(/^[^\s"'=<>`]+/u)?.[0] ?? "";
        index += value.length;
      }
    }
    const normalizedName = name.toLowerCase();
    if (normalizedName === MODEL_ID_ATTRIBUTE && modelId === undefined) {
      modelId = value;
    } else if (normalizedName === KIND_ATTRIBUTE && kind === undefined) {
      kind = value;
    }
  }
  return modelId === undefined || kind === undefined ? null : { modelId, kind };
}

function extractProjectionKinds(html: string): ProjectionKind[] {
  const projections: ProjectionKind[] = [];
  const lower = html.toLowerCase();
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) break;
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    const name = html.slice(open + 1).match(/^([a-z][\w:-]*)/iu)?.[1];
    if (name === undefined) {
      index = open + 1;
      continue;
    }
    const end = tagEnd(html, open + 1);
    const normalizedName = name.toLowerCase();
    if (normalizedName === "script" || normalizedName === "style") {
      const close = lower.indexOf(`</${normalizedName}`, end + 1);
      if (close < 0) break;
      const closeEnd = html.indexOf(">", close + normalizedName.length + 2);
      index = closeEnd < 0 ? html.length : closeEnd + 1;
      continue;
    }
    const projection = projectionKind(html.slice(open + 1, end));
    if (projection !== null) projections.push(projection);
    index = end + 1;
  }
  return projections;
}

/** model node の kind と手書き graph 投影の data-kind が同期していることを検証する。 */
export function validateDiagramGraphKinds(
  html: string,
  model: DiagramModel
): DiagramGraphKindValidation {
  const nodeKinds = new Map(
    model.nodes
      .filter(node => node.kind !== undefined)
      .map(node => [node.id, node.kind] as const)
  );
  const mismatches: Array<{
    nodeId: string;
    modelKind: string;
    projectionKind: string;
  }> = [];

  for (const projection of extractProjectionKinds(html)) {
    const modelKind = nodeKinds.get(projection.modelId);
    if (modelKind === undefined || modelKind === projection.kind) continue;
    mismatches.push({
      nodeId: projection.modelId,
      modelKind,
      projectionKind: projection.kind,
    });
  }

  if (mismatches.length === 0) return { ok: true };
  const details = mismatches
    .slice(0, MAX_REPORTED_MISMATCHES)
    .map(
      mismatch =>
        `node ${mismatch.nodeId}: model の kind="${mismatch.modelKind}", 投影の data-kind="${mismatch.projectionKind}"`
    )
    .join("; ");
  return {
    ok: false,
    error: `graph 投影の data-kind が model の node.kind と同期されていません（${mismatches.length}件）: ${details}`,
  };
}
