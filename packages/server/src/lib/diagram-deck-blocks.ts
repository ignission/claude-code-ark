/**
 * デッキの「部品」ページ（`type: "blocks"`）。見出しと、決まった部品の並びだけで
 * 1 ページを書く。見た目（配色・余白・明暗）は Ark が決める。
 *
 * ## なぜ要るか
 *
 * 自由形の `html` ページは、書く側のモデルごとに見た目がぶれ、デッキのたびに CSS を
 * 書き直していた（出力の 4 分の 1）。実際に書かれた 397 ページを数えると、8 割強は
 * カード・チップ・表など 11 種の部品の組み合わせで足りていた。そこで部品を語彙にして、
 * 書けるのは中身だけにする。
 *
 * ## 語彙
 *
 * `{ id, type: "blocks", title, blocks: [...] }`。`title` がページの見出しになる。
 * 部品は `kind` で選ぶ: text / chips / cards / flow / table / list / code / bars。
 * 知らない `kind`・キー・`tone` は拒否する（黙って捨てると、書いた側が気づけない）。
 *
 * 文字の中で使える飾りは 3 つだけ:
 *
 * - `{a:語}` `{ok:語}` `{ng:語}` `{warn:語}`: 色を付ける
 * - `` `語` ``: コード
 * - `[語](packages/foo.ts#L10)`: リンク（worktree 相対のパスか `https://`）
 *
 * それ以外の HTML は文字として出る（タグを書いても効かない）。
 */

import { isWorktreeSourceHref } from "./diagram-static-builtin.js";

const TONES = ["a", "ok", "ng", "warn"] as const;
type Tone = (typeof TONES)[number];

interface ChipItem {
  text: string;
  tone?: Tone;
}
interface CardItem {
  title?: string;
  value?: string;
  text?: string;
  items?: string[];
  tone?: Tone;
}
interface BarItem {
  label: string;
  value: number;
  text?: string;
  tone?: Tone;
}

export type DeckBlock =
  | { kind: "text"; text: string }
  | { kind: "chips"; items: ChipItem[] }
  | { kind: "cards"; items: CardItem[] }
  | { kind: "flow"; items: string[] }
  | { kind: "table"; head?: string[]; rows: string[][] }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "code"; text: string; diff?: boolean }
  | { kind: "bars"; items: BarItem[] };

export const BLOCK_KINDS = [
  "text",
  "chips",
  "cards",
  "flow",
  "table",
  "list",
  "code",
  "bars",
] as const;

export type DeckBlocksResult =
  | { ok: true; blocks: DeckBlock[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 検証の失敗。`where` は「blocks[2].items[0]」のような場所 */
class BlockError extends Error {}

function fail(where: string, message: string): never {
  throw new BlockError(`${where}: ${message}`);
}

/** 語彙に無いキーを拒否する */
function onlyKeys(
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(where, `"${key}" は使えません（使えるのは ${allowed.join(" / ")}）`);
    }
  }
}

function text(where: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    fail(where, "空でない文字列が要ります");
  }
  return value;
}

function optionalText(where: string, value: unknown): string | undefined {
  return value === undefined ? undefined : text(where, value);
}

function tone(where: string, value: unknown): Tone | undefined {
  if (value === undefined) return undefined;
  if (!TONES.includes(value as Tone)) {
    fail(where, `tone "${String(value)}" は使えません（${TONES.join(" / ")}）`);
  }
  return value as Tone;
}

function list<T>(
  where: string,
  value: unknown,
  each: (where: string, item: unknown) => T
): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(where, "1 つ以上の配列が要ります");
  }
  return value.map((item, index) => each(`${where}[${index}]`, item));
}

function record(where: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail(where, "オブジェクトが要ります");
  return value;
}

function parseBlock(where: string, raw: unknown): DeckBlock {
  const block = record(where, raw);
  const kind = block.kind;
  switch (kind) {
    case "text":
      onlyKeys(where, block, ["kind", "text"]);
      return { kind, text: text(`${where}.text`, block.text) };
    case "chips":
      onlyKeys(where, block, ["kind", "items"]);
      return {
        kind,
        items: list(`${where}.items`, block.items, (at, item) => {
          const chip = record(at, item);
          onlyKeys(at, chip, ["text", "tone"]);
          return {
            text: text(`${at}.text`, chip.text),
            tone: tone(`${at}.tone`, chip.tone),
          };
        }),
      };
    case "cards":
      onlyKeys(where, block, ["kind", "items"]);
      return {
        kind,
        items: list(`${where}.items`, block.items, (at, item) => {
          const card = record(at, item);
          onlyKeys(at, card, ["title", "value", "text", "items", "tone"]);
          const parsed: CardItem = {
            title: optionalText(`${at}.title`, card.title),
            value: optionalText(`${at}.value`, card.value),
            text: optionalText(`${at}.text`, card.text),
            items:
              card.items === undefined
                ? undefined
                : list(`${at}.items`, card.items, text),
            tone: tone(`${at}.tone`, card.tone),
          };
          if (!parsed.title && !parsed.value && !parsed.text && !parsed.items) {
            fail(at, "title / value / text / items のどれかが要ります");
          }
          return parsed;
        }),
      };
    case "flow":
      onlyKeys(where, block, ["kind", "items"]);
      return { kind, items: list(`${where}.items`, block.items, text) };
    case "table": {
      onlyKeys(where, block, ["kind", "head", "rows"]);
      const head =
        block.head === undefined
          ? undefined
          : list(`${where}.head`, block.head, text);
      const rows = list(`${where}.rows`, block.rows, (at, row) =>
        list(at, row, (cellAt, cell) => {
          // 空のセルは表に普通にあるので、文字列でさえあれば通す
          if (typeof cell !== "string") fail(cellAt, "文字列が要ります");
          return cell;
        })
      );
      const width = head?.length ?? rows[0].length;
      for (const [index, row] of rows.entries()) {
        if (row.length !== width) {
          fail(
            `${where}.rows[${index}]`,
            `列の数が揃っていません（${row.length} 列。${width} 列が要ります）`
          );
        }
      }
      return { kind, head, rows };
    }
    case "list":
      onlyKeys(where, block, ["kind", "items", "ordered"]);
      if (block.ordered !== undefined && typeof block.ordered !== "boolean") {
        fail(`${where}.ordered`, "true か false が要ります");
      }
      return {
        kind,
        items: list(`${where}.items`, block.items, text),
        ordered: block.ordered,
      };
    case "code":
      onlyKeys(where, block, ["kind", "text", "diff"]);
      if (block.diff !== undefined && typeof block.diff !== "boolean") {
        fail(`${where}.diff`, "true か false が要ります");
      }
      return {
        kind,
        text: text(`${where}.text`, block.text),
        diff: block.diff,
      };
    case "bars":
      onlyKeys(where, block, ["kind", "items"]);
      return {
        kind,
        items: list(`${where}.items`, block.items, (at, item) => {
          const bar = record(at, item);
          onlyKeys(at, bar, ["label", "value", "text", "tone"]);
          if (
            typeof bar.value !== "number" ||
            !Number.isFinite(bar.value) ||
            bar.value < 0
          ) {
            fail(`${at}.value`, "0 以上の数が要ります");
          }
          return {
            label: text(`${at}.label`, bar.label),
            value: bar.value,
            text: optionalText(`${at}.text`, bar.text),
            tone: tone(`${at}.tone`, bar.tone),
          };
        }),
      };
    default:
      return fail(
        where,
        `kind "${String(kind)}" は使えません（${BLOCK_KINDS.join(" / ")}）`
      );
  }
}

/** `blocks` を検証する。語彙の外は、場所と使える語を添えて拒否する */
export function parseDeckBlocks(raw: unknown): DeckBlocksResult {
  try {
    return { ok: true, blocks: list("blocks", raw, parseBlock) };
  } catch (error) {
    if (error instanceof BlockError) return { ok: false, error: error.message };
    throw error;
  }
}

const INLINE_RE =
  /\{(a|ok|ng|warn):([^{}]+)\}|`([^`]+)`|\[([^\]]+)\]\(([^()\s]+)\)/g;

/** 文字の中の飾り（色・コード・リンク）だけを HTML にする。ほかは文字として出す */
export function renderInline(value: string): string {
  let out = "";
  let last = 0;
  for (const match of value.matchAll(INLINE_RE)) {
    out += escapeHtml(value.slice(last, match.index));
    last = match.index + match[0].length;
    const [whole, toneName, toned, code, label, href] = match;
    if (toneName) {
      out += `<span class="ark-bk-tone" data-tone="${toneName}">${escapeHtml(toned)}</span>`;
    } else if (code) {
      out += `<code>${escapeHtml(code)}</code>`;
    } else if (isWorktreeSourceHref(href) || /^https:\/\//.test(href)) {
      out += `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    } else {
      // 外へ出る href（スキーム付き・絶対パス・`..`）はリンクにしない
      out += escapeHtml(whole);
    }
  }
  return out + escapeHtml(value.slice(last));
}

function toneAttr(value: Tone | undefined): string {
  return value ? ` data-tone="${value}"` : "";
}

function renderItems(items: string[], ordered: boolean): string {
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.map(item => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`;
}

function renderBlock(block: DeckBlock): string {
  switch (block.kind) {
    case "text":
      return `<p class="ark-bk-text">${renderInline(block.text)}</p>`;
    case "chips":
      return `<div class="ark-bk-chips">${block.items
        .map(
          chip =>
            `<span class="ark-bk-chip"${toneAttr(chip.tone)}>${renderInline(chip.text)}</span>`
        )
        .join("")}</div>`;
    case "cards":
      return `<div class="ark-bk-cards">${block.items
        .map(
          card =>
            `<div class="ark-bk-card"${toneAttr(card.tone)}>` +
            (card.title ? `<h3>${renderInline(card.title)}</h3>` : "") +
            (card.value
              ? `<div class="ark-bk-value">${renderInline(card.value)}</div>`
              : "") +
            (card.text ? `<p>${renderInline(card.text)}</p>` : "") +
            (card.items ? renderItems(card.items, false) : "") +
            `</div>`
        )
        .join("")}</div>`;
    case "flow":
      return `<div class="ark-bk-flow">${block.items
        .map(item => `<span class="ark-bk-step">${renderInline(item)}</span>`)
        .join(`<span class="ark-bk-arrow" aria-hidden="true">→</span>`)}</div>`;
    case "table":
      return (
        `<div class="ark-bk-table"><table>` +
        (block.head
          ? `<thead><tr>${block.head.map(cell => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>`
          : "") +
        `<tbody>${block.rows
          .map(
            row =>
              `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join("")}</tr>`
          )
          .join("")}</tbody></table></div>`
      );
    case "list":
      return `<div class="ark-bk-list">${renderItems(block.items, block.ordered === true)}</div>`;
    case "code":
      return `<pre class="ark-bk-code">${block.text
        .split("\n")
        .map(line => {
          const mark = block.diff ? line[0] : "";
          const kind = mark === "+" ? "add" : mark === "-" ? "del" : "";
          return `<span${kind ? ` data-diff="${kind}"` : ""}>${escapeHtml(line) || " "}</span>`;
        })
        .join("")}</pre>`;
    case "bars": {
      const max = Math.max(...block.items.map(bar => bar.value), 0);
      return `<div class="ark-bk-bars">${block.items
        .map(bar => {
          // 小さい値が見えなくならないよう 1% は出すが、0 は 0 のまま (量があるように見せない)
          const width =
            max > 0 && bar.value > 0 ? Math.max(1, (100 * bar.value) / max) : 0;
          return (
            `<span class="ark-bk-bar-label">${renderInline(bar.label)}</span>` +
            `<span class="ark-bk-bar-track"><i${toneAttr(bar.tone)} style="width:${width.toFixed(1)}%"></i></span>` +
            `<b>${renderInline(bar.text ?? String(bar.value))}</b>`
          );
        })
        .join("")}</div>`;
    }
  }
}

/** 部品ページ 1 枚分の中身を描く（包む要素はデッキが付ける） */
export function renderDeckBlocks(
  title: string | undefined,
  blocks: DeckBlock[]
): string {
  return (
    `<div class="ark-bk">` +
    (title ? `<h2 class="ark-bk-title">${renderInline(title)}</h2>` : "") +
    blocks.map(renderBlock).join("") +
    `</div>`
  );
}

/**
 * 部品の見た目。色はアプリ本体（`packages/web/src/index.css`）のパネルと well に
 * 合わせ、OS の明暗に追従する。ボードの iframe は `srcDoc` なので、親と同じ
 * `prefers-color-scheme` が効く。
 *
 * 色の変数は `body` に置く。部品のデッキには作者の CSS が無いので、地の色も
 * ここで決める必要がある。
 */
export const DECK_BLOCKS_CSS = `
body:has(.ark-deck[data-ark-deck-blocks]){
--ark-bk-canvas:oklch(0.955 0.006 270);--ark-bk-panel:oklch(1 0 0);--ark-bk-well:oklch(0.965 0.004 270);
--ark-bk-ink:oklch(0.24 0.02 60);--ark-bk-mute:oklch(0.48 0.02 60);--ark-bk-edge:rgb(0 0 0/.07);
--ark-bk-a:oklch(0.5 0.16 262);--ark-bk-ok:#1a7f37;--ark-bk-ng:oklch(0.55 0.2 25);--ark-bk-warn:#9a6700;
background-color:var(--ark-bk-canvas);color:var(--ark-bk-ink);
font-family:system-ui,"Hiragino Sans","Noto Sans JP",sans-serif}
@media (prefers-color-scheme:dark){body:has(.ark-deck[data-ark-deck-blocks]){
--ark-bk-canvas:oklch(0.185 0.008 270);--ark-bk-panel:oklch(0.225 0.008 270);--ark-bk-well:oklch(0.27 0.01 270);
--ark-bk-ink:oklch(0.93 0.01 80);--ark-bk-mute:oklch(0.72 0.015 80);--ark-bk-edge:rgb(255 255 255/.08);
--ark-bk-a:oklch(0.74 0.13 262);--ark-bk-ok:#56d364;--ark-bk-ng:oklch(0.74 0.16 25);--ark-bk-warn:#d29922}}
.ark-deck[data-ark-deck-blocks] .ark-deck-title{color:var(--ark-bk-mute);font-size:.82rem;font-weight:600}
.ark-deck-page.ark-bk-page{border-radius:14px;background:var(--ark-bk-panel);
box-shadow:inset 0 0 0 1px var(--ark-bk-edge),0 1px 2px rgb(0 0 0/.06),0 10px 26px rgb(0 0 0/.08);overflow-x:auto}
.ark-bk{display:grid;gap:.9rem;padding:1.25rem 1.4rem 1.4rem;font-size:14px;line-height:1.55}
.ark-bk>*{min-width:0}
.ark-bk-title{margin:0;font-size:1.18rem;font-weight:650;letter-spacing:-.01em;line-height:1.4}
.ark-bk-tone[data-tone="a"]{color:var(--ark-bk-a)}.ark-bk-tone[data-tone="ok"]{color:var(--ark-bk-ok)}
.ark-bk-tone[data-tone="ng"]{color:var(--ark-bk-ng)}.ark-bk-tone[data-tone="warn"]{color:var(--ark-bk-warn)}
.ark-bk a{color:var(--ark-bk-a)}
.ark-bk code{padding:.05rem .32rem;border-radius:5px;background:var(--ark-bk-well);
font:.86em ui-monospace,SFMono-Regular,Consolas,monospace}
.ark-bk-text{margin:0;color:var(--ark-bk-mute);font-size:.9rem}
.ark-bk-chips{display:flex;flex-wrap:wrap;gap:.5rem}
.ark-bk-chip{padding:.2rem .75rem;border-radius:999px;background:var(--ark-bk-well);font-size:.9rem}
.ark-bk-chip code,.ark-bk-card code,.ark-bk-step code{background:var(--ark-bk-panel)}
.ark-bk-chip[data-tone]::before{font-weight:700;margin-right:.35rem}
.ark-bk-chip[data-tone="ok"]::before{content:"✓";color:var(--ark-bk-ok)}
.ark-bk-chip[data-tone="ng"]::before{content:"✕";color:var(--ark-bk-ng)}
.ark-bk-chip[data-tone="warn"]::before{content:"!";color:var(--ark-bk-warn)}
.ark-bk-chip[data-tone="a"]::before{content:"●";color:var(--ark-bk-a);font-size:.6em;vertical-align:.2em}
.ark-bk-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.75rem}
.ark-bk-card{min-width:0;padding:.85rem 1rem;border-radius:12px;background:var(--ark-bk-well)}
.ark-bk-card[data-tone]{box-shadow:inset 0 0 0 1.5px var(--ark-bk-card-tone)}
.ark-bk-card[data-tone="a"]{--ark-bk-card-tone:var(--ark-bk-a)}.ark-bk-card[data-tone="ok"]{--ark-bk-card-tone:var(--ark-bk-ok)}
.ark-bk-card[data-tone="ng"]{--ark-bk-card-tone:var(--ark-bk-ng)}.ark-bk-card[data-tone="warn"]{--ark-bk-card-tone:var(--ark-bk-warn)}
.ark-bk-card>*+*{margin-top:.3rem}
.ark-bk-card h3{margin:0;font-size:.95rem;font-weight:650}
.ark-bk-card p{margin:0;color:var(--ark-bk-mute);font-size:.86rem}
.ark-bk-card ul,.ark-bk-list ul,.ark-bk-list ol{margin:0;padding-left:1.25em;line-height:1.8}
.ark-bk-card ul{font-size:.9rem}
.ark-bk-value{font-size:1.65rem;font-weight:700;letter-spacing:-.02em;line-height:1.25;overflow-wrap:anywhere}
.ark-bk-flow{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.ark-bk-step{padding:.4rem .8rem;border-radius:9px;background:var(--ark-bk-well)}
.ark-bk-arrow{color:var(--ark-bk-mute)}
.ark-bk-table{border-radius:12px;background:var(--ark-bk-well);overflow-x:auto}
.ark-bk-table table{width:100%;border-collapse:collapse;font-size:.9rem}
.ark-bk-table th,.ark-bk-table td{padding:.5rem .85rem;text-align:left;vertical-align:top}
.ark-bk-table th{color:var(--ark-bk-mute);font-size:.8rem;font-weight:500}
.ark-bk-table tr+tr td,.ark-bk-table thead+tbody td{box-shadow:inset 0 1px 0 var(--ark-bk-edge)}
.ark-bk-code{margin:0;padding:.65rem .85rem;border-radius:10px;background:var(--ark-bk-well);
font:.84rem/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-x:auto}
.ark-bk-code span{display:block;white-space:pre}
.ark-bk-code span[data-diff="add"]{color:var(--ark-bk-ok)}.ark-bk-code span[data-diff="del"]{color:var(--ark-bk-ng)}
.ark-bk-bars{display:grid;grid-template-columns:minmax(4rem,max-content) minmax(3rem,1fr) max-content;
gap:.5rem .8rem;align-items:center;font-size:.9rem}
.ark-bk-bar-label{color:var(--ark-bk-mute)}
.ark-bk-bar-track{height:1.2rem;border-radius:6px;background:var(--ark-bk-well);overflow:hidden}
.ark-bk-bar-track i{display:block;height:100%;border-radius:6px;background:var(--ark-bk-a)}
.ark-bk-bar-track i[data-tone="ok"]{background:var(--ark-bk-ok)}.ark-bk-bar-track i[data-tone="ng"]{background:var(--ark-bk-ng)}
.ark-bk-bar-track i[data-tone="warn"]{background:var(--ark-bk-warn)}
.ark-bk-bars b{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
`;
