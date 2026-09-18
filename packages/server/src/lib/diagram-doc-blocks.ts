/**
 * doc 本文から `data-ark-id` を持つブロックを取り出す。
 *
 * 還流は「変わったブロックの本文」を送るため、id からブロックの現在の姿を
 * 引けるようにする。同じタグ名の入れ子があるので、閉じタグは深さを数えて選ぶ。
 */

import { scanDiagramHtmlStartTags } from "./diagram-html-scan.js";

export interface DocBlock {
  id: string;
  /** 開始タグから閉じタグまでの外側 HTML */
  html: string;
  /** タグを除き空白を1つに畳んだ本文 */
  text: string;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * `prefix` (`<p` や `</p` 等) の出現を探すが、直後が名前の続き
 * (`<pre` の `re` 等) になっている偽陽性は読み飛ばす。
 */
function findTagBoundary(lower: string, prefix: string, from: number): number {
  let index = from;
  while (index < lower.length) {
    const found = lower.indexOf(prefix, index);
    if (found < 0) return -1;
    const after = lower[found + prefix.length] ?? ">";
    if (!/[a-z0-9-]/u.test(after)) return found;
    index = found + prefix.length;
  }
  return -1;
}

/** 開始タグに対応する閉じタグの終端 (`>` の次) を返す。見つからなければ -1 */
function closeTagEnd(
  html: string,
  name: string,
  afterStartTag: number
): number {
  const lower = html.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}`;
  let depth = 1;
  let index = afterStartTag;
  while (index < html.length) {
    // `<p` が `<pre` に、`</p` が `</pre` に当たらないよう、開始・終了の
    // 両方で直後が名前の続きでないことを見る
    const nextOpen = findTagBoundary(lower, open, index);
    const nextClose = findTagBoundary(lower, close, index);
    if (nextClose < 0) return -1;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      index = nextOpen + open.length;
      continue;
    }
    depth -= 1;
    const gt = html.indexOf(">", nextClose);
    if (gt < 0) return -1;
    if (depth === 0) return gt + 1;
    index = gt + 1;
  }
  return -1;
}

export function extractDocBlocks(html: string): Map<string, DocBlock> {
  const blocks = new Map<string, DocBlock>();
  for (const tag of scanDiagramHtmlStartTags(html)) {
    const id = tag.attributes.find(a => a.name === "data-ark-id")?.value;
    if (id === undefined || id === "") continue;
    if (blocks.has(id)) continue;

    const name = tag.name.toLowerCase();
    if (VOID_ELEMENTS.has(name)) {
      blocks.set(id, {
        id,
        html: html.slice(tag.start, tag.end + 1),
        text: "",
      });
      continue;
    }
    const end = closeTagEnd(html, name, tag.end + 1);
    if (end < 0) continue;
    const outer = html.slice(tag.start, end);
    blocks.set(id, { id, html: outer, text: textOf(outer) });
  }
  return blocks;
}
