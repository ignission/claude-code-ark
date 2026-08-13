import {
  type DiagramHtmlAttribute,
  scanDiagramHtmlStartTags,
} from "./diagram-html-scan.js";
import type { DiagramModel } from "./diagram-model.js";

export type DiagramDocAnchorValidation =
  | { ok: true }
  | { ok: false; error: string };

const ATTRIBUTE_NAME = "data-ark-id";

function attributeValues(attributes: DiagramHtmlAttribute[]): string[] {
  const values: string[] = [];
  for (const attribute of attributes) {
    if (attribute.name === ATTRIBUTE_NAME) values.push(attribute.value);
  }
  return values;
}

function extractAnchorIds(html: string): string[] {
  const ids: string[] = [];
  for (const tag of scanDiagramHtmlStartTags(html)) {
    ids.push(...attributeValues(tag.attributes));
  }
  return ids;
}

/** doc の意味 node と本文中のコメント anchor を1対1に固定する。 */
export function validateDiagramDocAnchors(
  html: string,
  model: DiagramModel
): DiagramDocAnchorValidation {
  if (model.type !== "doc") return { ok: true };

  const nodeIds = new Set(model.nodes.map(node => node.id));
  const counts = new Map<string, number>();
  for (const id of extractAnchorIds(html)) {
    if (!nodeIds.has(id)) {
      return {
        ok: false,
        error: `${ATTRIBUTE_NAME} が未知の node id を参照しています: ${id || "(空)"}`,
      };
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  for (const id of nodeIds) {
    const count = counts.get(id) ?? 0;
    if (count !== 1) {
      return {
        ok: false,
        error: `doc node ${id} に対応する ${ATTRIBUTE_NAME} は1個必要です（${count}個）`,
      };
    }
  }
  return { ok: true };
}
