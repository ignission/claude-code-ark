import type { DiagramModel } from "./diagram-model.js";

export type DiagramDocAnchorValidation =
  | { ok: true }
  | { ok: false; error: string };

const ATTRIBUTE_NAME = "data-ark-id";

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

function attributeValues(tag: string): string[] {
  const values: string[] = [];
  const attribute = /(?:^|\s)data-ark-id(?=\s|=|\/|$)/giu;
  for (const match of tag.matchAll(attribute)) {
    let index = (match.index ?? 0) + match[0].length;
    while (/\s/u.test(tag[index] ?? "")) index += 1;
    if (tag[index] !== "=") {
      values.push("");
      continue;
    }
    index += 1;
    while (/\s/u.test(tag[index] ?? "")) index += 1;
    const quote = tag[index];
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, index + 1);
      values.push(end < 0 ? "" : tag.slice(index + 1, end));
      continue;
    }
    const value = tag.slice(index).match(/^[^\s"'=<>`]+/u)?.[0] ?? "";
    values.push(value);
  }
  return values;
}

function extractAnchorIds(html: string): string[] {
  const ids: string[] = [];
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
    ids.push(...attributeValues(html.slice(open + 1, end)));
    index = end + 1;
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
