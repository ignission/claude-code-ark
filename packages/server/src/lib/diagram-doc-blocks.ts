/**
 * doc 本文から `data-ark-id` を持つブロックを取り出す。
 *
 * 還流は「変わったブロックの本文」を送るため、id からブロックの現在の姿を
 * 引けるようにする。同じタグ名の入れ子があるので、閉じタグは深さを数えて選ぶ。
 */

import {
  decodeCharacterReferences,
  scanDiagramHtmlStartTags,
} from "./diagram-html-scan.js";

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
  "param",
  "source",
  "track",
  "wbr",
]);

interface DocMarkupToken {
  kind: "start" | "end" | "comment";
  /** comment には無いので空文字 */
  name: string;
  /** `<` の位置 */
  start: number;
  /** `>` の位置 (コメントは `-->` の `>`) */
  end: number;
}

/**
 * タグ内の引用符を追跡しながら `>` を探す。`diagram-html-scan.ts` の
 * `tagEnd` と同じ考え方だが、そちらは本タスクの範囲外としてこの export
 * 追加だけに留めるため、ここに複製する。
 */
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

/**
 * 開始タグ・閉じタグ・コメントを、コメントの中身や属性値の引用符の中身を
 * タグとして誤認せずに走査する。`scanDiagramHtmlStartTags` は開始タグしか
 * 返さないため、閉じタグの深さ数えに使えるようここで別途スキャンする。
 */
function scanDocMarkup(html: string): DocMarkupToken[] {
  const tokens: DocMarkupToken[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      const end = close < 0 ? html.length - 1 : close + 2;
      tokens.push({ kind: "comment", name: "", start: open, end });
      index = end + 1;
      continue;
    }
    const isEnd = html[open + 1] === "/";
    const nameStart = open + (isEnd ? 2 : 1);
    const name = html.slice(nameStart).match(/^([a-z][\w:-]*)/iu)?.[1];
    if (name === undefined) {
      index = open + 1;
      continue;
    }
    const end = tagEnd(html, nameStart);
    tokens.push({
      kind: isEnd ? "end" : "start",
      name: name.toLowerCase(),
      start: open,
      end,
    });
    index = end + 1;
  }
  return tokens;
}

/** 開始タグに対応する閉じタグの終端 (`>` の次) を返す。見つからなければ -1 */
function closeTagEnd(
  tokens: DocMarkupToken[],
  name: string,
  afterStartTag: number
): number {
  let depth = 1;
  for (const token of tokens) {
    if (token.start < afterStartTag) continue;
    if (token.kind === "comment" || token.name !== name) continue;
    if (token.kind === "start") {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return token.end + 1;
  }
  return -1;
}

/** タグ・コメントを取り除き、実体参照をデコードし、空白を1つに畳む */
function textOf(html: string): string {
  let stripped = "";
  let cursor = 0;
  for (const token of scanDocMarkup(html)) {
    stripped += html.slice(cursor, token.start);
    stripped += " ";
    cursor = token.end + 1;
  }
  stripped += html.slice(cursor);
  return decodeCharacterReferences(stripped).replace(/\s+/gu, " ").trim();
}

export function extractDocBlocks(html: string): Map<string, DocBlock> {
  const blocks = new Map<string, DocBlock>();
  const markupTokens = scanDocMarkup(html);
  for (const tag of scanDiagramHtmlStartTags(html)) {
    const id = tag.attributes.find(a => a.name === "data-ark-id")?.value;
    if (id === undefined || id === "") continue;
    // 重複 data-ark-id は先勝ちで静かにスキップする。model node との1対1は
    // 上流の validateDiagramDocAnchors が別途保証する契約のため、ここでは弾かない。
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
    const end = closeTagEnd(markupTokens, name, tag.end + 1);
    if (end < 0) continue;
    const outer = html.slice(tag.start, end);
    blocks.set(id, { id, html: outer, text: textOf(outer) });
  }
  return blocks;
}
