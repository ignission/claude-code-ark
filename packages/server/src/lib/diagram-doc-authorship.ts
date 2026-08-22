/**
 * doc 型の本文ブロックに付く authorship 属性 `data-ark-author` の lint。
 *
 * doc は本文 HTML が正準 source なので、「誰が書いたか」もモデルではなく
 * 本文の属性として `data-ark-id` と同じ要素に置く（#319）。語彙はコメント
 * sidecar の `author: "claude"` と揃え、`human` / `claude` の 2 値に固定する。
 *
 * 既存の doc はすべて無印なので、無印は拒否しない。拒否するのは語彙外の値、
 * ブロックでない要素（`data-ark-id` の無い要素）への付与、1 要素内の重複だけ。
 * 読み手の規則は「`human` が付いたブロックだけを人間の決定として扱う」に
 * 一本化し、無印の意味論（= エージェント側）に依存させない。
 */

import {
  type DiagramHtmlAttribute,
  scanDiagramHtmlStartTags,
} from "./diagram-html-scan.js";
import type { DiagramModel } from "./diagram-model.js";

export const DOC_AUTHOR_ATTRIBUTE = "data-ark-author";
export const DOC_AUTHOR_VALUES = ["human", "claude"] as const;
export type DocAuthor = (typeof DOC_AUTHOR_VALUES)[number];

const ANCHOR_ATTRIBUTE = "data-ark-id";

export type DiagramDocAuthorshipValidation =
  | { ok: true }
  | { ok: false; error: string };

function valuesOf(attributes: DiagramHtmlAttribute[], name: string): string[] {
  const values: string[] = [];
  for (const attribute of attributes) {
    if (attribute.name === name) values.push(attribute.value);
  }
  return values;
}

export function isDocAuthor(value: string): value is DocAuthor {
  return (DOC_AUTHOR_VALUES as readonly string[]).includes(value);
}

/** doc の本文ブロックに付く `data-ark-author` の語彙と置き場所を検査する。 */
export function validateDiagramDocAuthorship(
  html: string,
  model: DiagramModel
): DiagramDocAuthorshipValidation {
  if (model.type !== "doc") return { ok: true };

  for (const tag of scanDiagramHtmlStartTags(html)) {
    const authors = valuesOf(tag.attributes, DOC_AUTHOR_ATTRIBUTE);
    if (authors.length === 0) continue;

    const anchorId = valuesOf(tag.attributes, ANCHOR_ATTRIBUTE)[0];
    if (anchorId === undefined) {
      return {
        ok: false,
        error: `${DOC_AUTHOR_ATTRIBUTE} は ${ANCHOR_ATTRIBUTE} を持つブロック要素にだけ付けられます（<${tag.name}>）`,
      };
    }
    if (authors.length > 1) {
      return {
        ok: false,
        error: `doc node ${anchorId} の ${DOC_AUTHOR_ATTRIBUTE} は1個までです（${authors.length}個）`,
      };
    }
    const author = authors[0] ?? "";
    if (!isDocAuthor(author)) {
      return {
        ok: false,
        error: `doc node ${anchorId} の ${DOC_AUTHOR_ATTRIBUTE} は ${DOC_AUTHOR_VALUES.join(" / ")} のいずれかである必要があります: ${author || "(空)"}`,
      };
    }
  }
  return { ok: true };
}
