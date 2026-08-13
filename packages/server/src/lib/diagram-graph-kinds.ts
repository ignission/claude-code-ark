import {
  type DiagramHtmlAttribute,
  scanDiagramHtmlStartTags,
} from "./diagram-html-scan.js";
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

function projectionKind(
  attributes: DiagramHtmlAttribute[]
): ProjectionKind | null {
  let modelId: string | undefined;
  let kind: string | undefined;
  for (const attribute of attributes) {
    if (attribute.name === MODEL_ID_ATTRIBUTE && modelId === undefined) {
      modelId = attribute.value;
    } else if (attribute.name === KIND_ATTRIBUTE && kind === undefined) {
      kind = attribute.value;
    }
  }
  return modelId === undefined || kind === undefined ? null : { modelId, kind };
}

function extractProjectionKinds(html: string): ProjectionKind[] {
  const projections: ProjectionKind[] = [];
  for (const tag of scanDiagramHtmlStartTags(html)) {
    const projection = projectionKind(tag.attributes);
    if (projection !== null) projections.push(projection);
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
