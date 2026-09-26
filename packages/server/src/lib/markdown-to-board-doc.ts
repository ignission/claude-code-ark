/**
 * Claude の返答 (markdown) を、ボードの doc 型 `.diagram.html` へ機械的に変換する。
 *
 * 目的は「長い説明をボードで読めるようにする」ことであって作図ではない。
 * 変換は決定的で LLM を呼ばず、Claude のトークンを 1 つも消費しない。
 *
 * 生成物は diagram-authoring の doc 規約に従う:
 * - model は `type: "doc"`、node の kind は 12 語彙のうち
 *   section / paragraph / list / list-item / task / table / table-row / code / quote
 * - 全 node に同じ id の `data-ark-id` をちょうど 1 つ付け、書き手は
 *   `data-ark-author="claude"` (本文は Claude が書いたものなので)
 * - label は本文の 80 コードポイントまでの抜粋 (refreshDocLabels と同じ規則)
 * - 外部リソースを参照しない。本文はすべてエスケープし、返答に含まれる生 HTML も
 *   文字として出す (返答には `<configDir>` のような山括弧が頻出する)
 */

import { marked, type Token, type Tokens } from "marked";
import { MODEL_SCRIPT_ID } from "./diagram-file.js";
import type { DiagramModel, DiagramNode } from "./diagram-model.js";

const LABEL_MAX_LENGTH = 80;
const AUTHOR_ATTR = 'data-ark-author="claude"';

export interface BoardDocResult {
  html: string;
  model: DiagramModel;
  /** 返答から推定した題名 (最初の見出し、無ければ先頭の文) */
  title: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function excerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= LABEL_MAX_LENGTH) return normalized;
  return `${characters.slice(0, LABEL_MAX_LENGTH - 1).join("")}…`;
}

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** inline token 列を HTML とプレーンテキストの両方に落とす */
function renderInline(tokens: Token[] | undefined): {
  html: string;
  text: string;
} {
  let html = "";
  let text = "";
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          const inner = renderInline(t.tokens);
          html += inner.html;
          text += inner.text;
        } else {
          html += escapeHtml(t.text);
          text += t.text;
        }
        break;
      }
      case "escape":
        html += escapeHtml((token as Tokens.Escape).text);
        text += (token as Tokens.Escape).text;
        break;
      case "strong":
      case "em":
      case "del": {
        const tag =
          token.type === "strong"
            ? "strong"
            : token.type === "em"
              ? "em"
              : "del";
        const inner = renderInline((token as Tokens.Strong).tokens);
        html += `<${tag}>${inner.html}</${tag}>`;
        text += inner.text;
        break;
      }
      case "codespan":
        html += `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`;
        text += (token as Tokens.Codespan).text;
        break;
      case "link": {
        const link = token as Tokens.Link;
        const inner = renderInline(link.tokens);
        html += isSafeHref(link.href)
          ? `<a href="${escapeHtml(link.href)}" rel="noopener">${inner.html}</a>`
          : inner.html;
        text += inner.text;
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        html += escapeHtml(image.text);
        text += image.text;
        break;
      }
      case "br":
        html += "<br>";
        text += " ";
        break;
      default: {
        // html token やその他は文字として出す
        const raw = (token as { raw?: string }).raw ?? "";
        html += escapeHtml(raw);
        text += raw;
      }
    }
  }
  return { html, text };
}

/** list item の中身 (block token 列) を inline 相当に落とす。入れ子の list は id 無しで描く */
function renderItemBody(tokens: Token[]): { html: string; text: string } {
  let html = "";
  let text = "";
  for (const token of tokens) {
    if (token.type === "text" || token.type === "paragraph") {
      const inner = renderInline((token as Tokens.Paragraph).tokens);
      html += inner.html;
      text += inner.text;
    } else if (token.type === "list") {
      const list = token as Tokens.List;
      const tag = list.ordered ? "ol" : "ul";
      html += `<${tag}>`;
      for (const item of list.items) {
        const inner = renderItemBody(item.tokens);
        html += `<li>${inner.html}</li>`;
        text += ` ${inner.text}`;
      }
      html += `</${tag}>`;
    } else if (token.type === "code") {
      const code = token as Tokens.Code;
      html += `<pre><code>${escapeHtml(code.text)}</code></pre>`;
      text += ` ${code.text}`;
    } else if (token.type !== "space") {
      const raw = (token as { raw?: string }).raw ?? "";
      html += escapeHtml(raw);
      text += raw;
    }
  }
  return { html, text: text.trim() };
}

/** blockquote の中身は id を付けずに描く (引用全体が 1 つの葉ブロック) */
function renderQuoteBody(tokens: Token[]): { html: string; text: string } {
  let html = "";
  let text = "";
  for (const token of tokens) {
    if (token.type === "paragraph" || token.type === "text") {
      const inner = renderInline((token as Tokens.Paragraph).tokens);
      html += `<p>${inner.html}</p>`;
      text += ` ${inner.text}`;
    } else if (token.type !== "space") {
      const inner = renderItemBody([token]);
      html += inner.html;
      text += ` ${inner.text}`;
    }
  }
  return { html, text: text.trim() };
}

interface Builder {
  nodes: DiagramNode[];
  blocks: string[];
  counter: number;
  title: string | null;
}

function nextId(b: Builder): string {
  b.counter += 1;
  return `b${b.counter}`;
}

function addNode(b: Builder, id: string, kind: string, text: string): void {
  b.nodes.push({ id, label: excerpt(text) || kind, kind });
}

function renderBlock(b: Builder, token: Token): void {
  switch (token.type) {
    case "space":
      return;
    case "hr":
      b.blocks.push("<hr>");
      return;
    case "heading": {
      const heading = token as Tokens.Heading;
      const inner = renderInline(heading.tokens);
      if (b.title === null) b.title = inner.text.trim();
      // 文書題名が h1 なので、返答の見出しは 1 段下げる
      const level = Math.min(heading.depth + 1, 6);
      const id = nextId(b);
      addNode(b, id, "section", inner.text);
      b.blocks.push(
        `<h${level} data-ark-id="${id}" ${AUTHOR_ATTR}>${inner.html}</h${level}>`
      );
      return;
    }
    case "paragraph": {
      const inner = renderInline((token as Tokens.Paragraph).tokens);
      if (!inner.text.trim()) return;
      const id = nextId(b);
      addNode(b, id, "paragraph", inner.text);
      b.blocks.push(`<p data-ark-id="${id}" ${AUTHOR_ATTR}>${inner.html}</p>`);
      return;
    }
    case "list": {
      const list = token as Tokens.List;
      const id = nextId(b);
      const tag = list.ordered ? "ol" : "ul";
      const items: string[] = [];
      const itemTexts: string[] = [];
      list.items.forEach((item, index) => {
        const itemId = `${id}-i${index + 1}`;
        const inner = renderItemBody(item.tokens);
        const isTask = item.task === true;
        const mark = isTask
          ? `<span class="task-mark">${item.checked ? "☑" : "☐"}</span> `
          : "";
        addNode(b, itemId, isTask ? "task" : "list-item", inner.text);
        items.push(
          `<li data-ark-id="${itemId}" ${AUTHOR_ATTR}${isTask ? ' class="task"' : ""}>${mark}${inner.html}</li>`
        );
        itemTexts.push(inner.text);
      });
      addNode(b, id, "list", itemTexts.join(" "));
      b.blocks.push(
        `<${tag} data-ark-id="${id}" ${AUTHOR_ATTR}>${items.join("")}</${tag}>`
      );
      return;
    }
    case "table": {
      const table = token as Tokens.Table;
      const id = nextId(b);
      const header = table.header
        .map(cell => `<th>${renderInline(cell.tokens).html}</th>`)
        .join("");
      const rows: string[] = [];
      const rowTexts: string[] = [];
      table.rows.forEach((row, index) => {
        const rowId = `${id}-r${index + 1}`;
        const cells = row.map(cell => renderInline(cell.tokens));
        const rowText = cells.map(c => c.text).join(" ");
        addNode(b, rowId, "table-row", rowText);
        rows.push(
          `<tr data-ark-id="${rowId}" ${AUTHOR_ATTR}>${cells.map(c => `<td>${c.html}</td>`).join("")}</tr>`
        );
        rowTexts.push(rowText);
      });
      const headerText = table.header
        .map(cell => renderInline(cell.tokens).text)
        .join(" ");
      addNode(b, id, "table", `${headerText} ${rowTexts.join(" ")}`);
      b.blocks.push(
        `<table data-ark-id="${id}" ${AUTHOR_ATTR}><thead><tr>${header}</tr></thead><tbody>${rows.join("")}</tbody></table>`
      );
      return;
    }
    case "code": {
      const code = token as Tokens.Code;
      const id = nextId(b);
      addNode(b, id, "code", code.text);
      const lang = code.lang ? ` data-lang="${escapeHtml(code.lang)}"` : "";
      b.blocks.push(
        `<pre data-ark-id="${id}" ${AUTHOR_ATTR}${lang}><code>${escapeHtml(code.text)}</code></pre>`
      );
      return;
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      const inner = renderQuoteBody(quote.tokens);
      if (!inner.text) return;
      const id = nextId(b);
      addNode(b, id, "quote", inner.text);
      b.blocks.push(
        `<blockquote data-ark-id="${id}" ${AUTHOR_ATTR}>${inner.html}</blockquote>`
      );
      return;
    }
    default: {
      // html / def / その他は本文として文字のまま出す
      const raw = ((token as { raw?: string }).raw ?? "").trim();
      if (!raw) return;
      const id = nextId(b);
      addNode(b, id, "paragraph", raw);
      b.blocks.push(
        `<p data-ark-id="${id}" ${AUTHOR_ATTR}>${escapeHtml(raw)}</p>`
      );
    }
  }
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --ink: #223047; --muted: #627086; --line: #d8e0ea; --paper: #f5f7fa; --card: #ffffff;
    --accent: #176b87; --code-bg: #eef2f6;
    font-family: "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e6ebf2; --muted: #9aa7b8; --line: #2c3646; --paper: #141922; --card: #1b2130; --accent: #7dcfff; --code-bg: #232b3a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); background: var(--paper); line-height: 1.8; }
  .document { width: min(880px, calc(100% - 48px)); margin: 32px auto 72px; }
  .eyebrow { margin: 0 0 6px; color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: .12em; }
  h1 { margin: 0 0 20px; font-size: 26px; line-height: 1.4; }
  h2 { margin: 28px 0 10px; font-size: 20px; }
  h3 { margin: 22px 0 8px; font-size: 17px; }
  h4, h5, h6 { margin: 18px 0 6px; font-size: 15px; }
  p { margin: 0 0 14px; }
  ul, ol { margin: 0 0 14px; padding-left: 1.6em; }
  li { margin: 4px 0; }
  li.task { list-style: none; margin-left: -1.4em; }
  .task-mark { color: var(--accent); }
  table { width: 100%; margin: 0 0 18px; border-collapse: collapse; font-size: 14px; background: var(--card); }
  th, td { padding: 9px 11px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { background: var(--code-bg); font-size: 12px; }
  pre { margin: 0 0 16px; padding: 12px 14px; overflow-x: auto; border-radius: 8px; background: var(--code-bg); font-size: 13px; line-height: 1.55; }
  code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: .92em; }
  p code, li code, td code { padding: 1px 5px; border-radius: 4px; background: var(--code-bg); }
  blockquote { margin: 0 0 14px; padding: 8px 16px; border-left: 4px solid var(--accent); color: var(--muted); }
  hr { margin: 24px 0; border: 0; border-top: 1px solid var(--line); }
  a { color: var(--accent); }
`;

function fallbackTitle(markdown: string): string {
  const first = markdown
    .split("\n")
    // 見出し・引用・箇条書きの記号だけを剥がす (本文先頭の数字は残す)
    .map(line => line.replace(/^(?:#+\s*|>\s*|[-*]\s+|\d+\.\s+)+/, "").trim())
    .find(line => line.length > 0);
  return excerpt(first ?? "説明").slice(0, 40) || "説明";
}

/**
 * markdown の返答を doc 型ボードへ変換する。
 * @param markdown Claude の返答本文
 * @param eyebrow 題名の上に小さく出す出典 (セッション名や日時など)
 */
export function markdownToBoardDoc(
  markdown: string,
  eyebrow: string
): BoardDocResult {
  const tokens = marked.lexer(markdown, { gfm: true });
  const builder: Builder = { nodes: [], blocks: [], counter: 0, title: null };
  for (const token of tokens) renderBlock(builder, token);

  const title = builder.title?.trim() || fallbackTitle(markdown);
  const model: DiagramModel = {
    version: 1,
    type: "doc",
    title,
    nodes: builder.nodes,
    edges: [],
    groups: [],
  };
  const modelJson = JSON.stringify(model, null, 2).replace(/</g, "\\u003c");
  const html = [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    `<script type="application/json" id="${MODEL_SCRIPT_ID}">`,
    modelJson,
    "</script>",
    '<main class="document">',
    `<p class="eyebrow">${escapeHtml(eyebrow)}</p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    ...builder.blocks,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
  return { html, model, title };
}
