/**
 * デッキ（`type: "deck"`）。1 ファイルに複数のページを持ち、1 枚ずつめくるか、
 * 全ページを上下に積んで見せる。
 *
 * ## なぜ要るか
 *
 * 込み入った説明を 1 枚の縦長の図に詰めると、読み手はどこが結論か分からなくなる。
 * 1 ページに 1 つのことだけを置き、順にめくらせるほうが読める。また、sequence と
 * call-tree のように別々の図種を 1 枚のボードに並べる手段が他に無い。
 *
 * ## 語彙
 *
 * ページは `model.ext.pages` に並び順で置く。一番上の nodes / edges / groups は空でよい。
 *
 * - `{ id, type: "sequence" | "call-tree", title?, nodes, edges }`: 内蔵図種のページ。
 *   モデルの検証も投影も単独の図と同じものを使う
 * - `{ id, type: "html", title? }`: 自由形のページ。本文に
 *   `<section data-ark-page="<id>">` を 1 つだけ書く
 *
 * id はページの id も含めてファイル全体で一意にする。生成した行の `data-ark-id` が
 * コメントの付け先になり、コメントの sidecar はファイル単位で持つため。
 *
 * ## 載せないもの
 *
 * er / flow など graph の図種と doc はページにできない。graph はドラッグした座標を
 * 一番上のモデルへ書き戻し、doc は本文を直接編集する。どちらも 1 ファイルに
 * 1 種類だけが載る前提で動いている。
 */

import { GENERATED_ATTR } from "./diagram-builtin.js";
import { scanDiagramHtmlStartTags } from "./diagram-html-scan.js";
import {
  type DiagramModel,
  type DiagramNode,
  parseDiagramModel,
} from "./diagram-model.js";
import {
  isStaticBuiltinType,
  renderStaticBuiltin,
  STATIC_BASE_CSS,
  STATIC_BUILTIN_OWN_CSS,
  type StaticBuiltinType,
} from "./diagram-static-builtin.js";

export const DECK_TYPE = "deck";
export const DIAGRAM_DECK_MARKER = "ark-diagram-deck";
/** デッキの表示が変わったことをコメント層へ知らせる window イベント */
export const DIAGRAM_PAGE_CHANGE_EVENT = "ark:diagram-page-change";
/** デッキが隠しているページ（の包む要素）に付く属性 */
export const DIAGRAM_DECK_HIDDEN_ATTR = "data-ark-deck-hidden";

const PAGE_ATTRIBUTE = "data-ark-page";

export type DeckPage =
  | { id: string; type: StaticBuiltinType; title?: string; model: DiagramModel }
  | { id: string; type: "html"; title?: string };

export type DeckPagesResult =
  | { ok: true; pages: DeckPage[] }
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

/** モデルの id（node / field / edge / group）をすべて並べる */
function modelIds(model: DiagramModel): string[] {
  return [
    ...model.nodes.flatMap(node => [
      node.id,
      ...(node.fields ?? []).map(field => field.id),
    ]),
    ...model.edges.map(edge => edge.id),
    ...model.groups.map(group => group.id),
  ];
}

/** `ext.pages` を検証し、並び順どおりのページを返す */
export function parseDeckPages(model: DiagramModel): DeckPagesResult {
  const raw = model.ext?.pages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: "deck には ext.pages にページが 1 つ以上要ります",
    };
  }

  const seen = new Set<string>(modelIds(model));
  const claim = (id: string): string | null => {
    if (seen.has(id)) return `id が重複しています: ${id}`;
    seen.add(id);
    return null;
  };

  const pages: DeckPage[] = [];
  for (const [index, entry] of raw.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id === "" ||
      typeof entry.type !== "string"
    ) {
      return {
        ok: false,
        error: `ext.pages[${index}] には文字列の id と type が要ります`,
      };
    }
    const title = typeof entry.title === "string" ? entry.title : undefined;
    const pageError = claim(entry.id);
    if (pageError) return { ok: false, error: pageError };

    if (entry.type === "html") {
      pages.push({ id: entry.id, type: "html", title });
      continue;
    }
    if (!isStaticBuiltinType(entry.type)) {
      return {
        ok: false,
        error: `ページ ${entry.id} の type "${entry.type}" はデッキに置けません（sequence / call-tree / html）`,
      };
    }

    const parsed = parseDiagramModel(
      JSON.stringify({
        version: 1,
        type: entry.type,
        title,
        nodes: entry.nodes,
        edges: entry.edges,
        groups: [],
      })
    );
    if (!parsed.ok) {
      return { ok: false, error: `ページ ${entry.id}: ${parsed.error}` };
    }
    for (const id of modelIds(parsed.model)) {
      const error = claim(id);
      if (error) return { ok: false, error: `ページ ${entry.id}: ${error}` };
    }
    pages.push({ id: entry.id, type: entry.type, title, model: parsed.model });
  }
  return { ok: true, pages };
}

/** 本文に書かれた `data-ark-page` の値を出現順に集める */
function authoredPageIds(html: string): string[] {
  const ids: string[] = [];
  for (const tag of scanDiagramHtmlStartTags(html)) {
    for (const attribute of tag.attributes) {
      if (attribute.name === PAGE_ATTRIBUTE) ids.push(attribute.value);
    }
  }
  return ids;
}

/** ページの定義と、自由形ページの本文（`data-ark-page` の section）が揃っているか */
export function validateDiagramDeck(
  html: string,
  model: DiagramModel
): { ok: true } | { ok: false; error: string } {
  if (model.type !== DECK_TYPE) return { ok: true };
  const parsed = parseDeckPages(model);
  if (!parsed.ok) return parsed;

  const htmlPages = new Set(
    parsed.pages.filter(page => page.type === "html").map(page => page.id)
  );
  const counts = new Map<string, number>();
  for (const id of authoredPageIds(html)) {
    if (!htmlPages.has(id)) {
      return {
        ok: false,
        error: `${PAGE_ATTRIBUTE}="${id}" に対応する html ページがありません`,
      };
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of htmlPages) {
    const count = counts.get(id) ?? 0;
    if (count !== 1) {
      return {
        ok: false,
        error: `html ページ ${id} には ${PAGE_ATTRIBUTE}="${id}" の要素が 1 つ要ります（${count}個）`,
      };
    }
  }
  return { ok: true };
}

/** コメントの付け先になれる node。デッキはページ内の node も含める */
export function commentAnchorNodes(model: DiagramModel): DiagramNode[] {
  if (model.type !== DECK_TYPE) return model.nodes;
  const parsed = parseDeckPages(model);
  if (!parsed.ok) return model.nodes;
  return [
    ...model.nodes,
    ...parsed.pages.flatMap(page =>
      page.type === "html" ? [] : page.model.nodes
    ),
  ];
}

const DECK_CSS = `
.ark-deck-title{margin:0 0 .8rem;font-size:1.02rem;font-weight:700}
.ark-deck-page[data-ark-deck-hidden]{display:none}
.ark-deck[data-ark-deck-mode="stack"] .ark-deck-page{margin:0 0 1.2rem}
.ark-deck-nav{position:sticky;bottom:0;display:flex;align-items:center;justify-content:center;
gap:.6rem;padding:.55rem 0;background:#0b1018;
font:.72rem/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:#6b7b93}
.ark-deck-nav button{padding:.35rem .75rem;border:1px solid #22304a;border-radius:6px;
background:#101827;color:#dbe4f0;font:inherit;cursor:pointer}
.ark-deck-nav button:disabled{opacity:.35;cursor:default}
.ark-deck-dots{display:flex;gap:.35rem}
.ark-deck-dots button{width:.55rem;height:.55rem;padding:0;border-radius:50%;background:#22304a;border:0}
.ark-deck-dots button[aria-current="true"]{background:#dbe4f0}
.ark-deck[data-ark-deck-mode="stack"] .ark-deck-step{display:none}
.ark-deck[data-ark-deck-single] .ark-deck-nav{display:none}
`;

/**
 * 自由形ページを包む要素へ移し、めくる操作を付ける。
 * srcdoc の iframe では `href="#…"` が親ページの URL に解決されて遷移するので、
 * リンクは使わずボタンで動かす。
 */
const DECK_SCRIPT = `(function(){
  "use strict";
  var deck=document.querySelector("[data-ark-deck-mode]");
  if(!deck)return;
  // 自由形の section は包む要素の中へ移すだけにする。表示・非表示は包む要素で切り替え、
  // section に書かれた display（grid / flex など）には触らない
  deck.querySelectorAll("[data-ark-deck-slot]").forEach(function(slot){
    var id=slot.getAttribute("data-ark-deck-slot");
    document.querySelectorAll("[data-ark-page]").forEach(function(el){
      if(el.getAttribute("data-ark-page")===id&&!deck.contains(el))slot.appendChild(el);
    });
  });
  var pages=Array.prototype.slice.call(deck.querySelectorAll(".ark-deck-pages > .ark-deck-page"));
  var dots=deck.querySelector(".ark-deck-dots");
  var pos=deck.querySelector(".ark-deck-pos");
  var prev=deck.querySelector('[data-ark-deck-go="-1"]');
  var next=deck.querySelector('[data-ark-deck-go="1"]');
  var toggle=deck.querySelector("[data-ark-deck-toggle]");
  var cur=0;
  if(pages.length<2)deck.setAttribute("data-ark-deck-single","");
  pages.forEach(function(page,i){
    var dot=document.createElement("button");
    dot.type="button";
    dot.setAttribute("aria-label",(i+1)+" ページ目");
    dot.addEventListener("click",function(){show(i);});
    dots.appendChild(dot);
  });
  function apply(){
    var stack=deck.getAttribute("data-ark-deck-mode")==="stack";
    pages.forEach(function(page,k){
      if(stack||k===cur)page.removeAttribute("data-ark-deck-hidden");
      else page.setAttribute("data-ark-deck-hidden","");
    });
    Array.prototype.forEach.call(dots.children,function(dot,k){dot.setAttribute("aria-current",k===cur?"true":"false");});
    pos.textContent=(cur+1)+" / "+pages.length;
    prev.disabled=cur===0;
    next.disabled=cur===pages.length-1;
    // コメント層は隠れたページのカードを出さないので、表示が変わるたびに描き直させる
    window.dispatchEvent(new Event("${DIAGRAM_PAGE_CHANGE_EVENT}"));
  }
  function show(i){
    cur=Math.max(0,Math.min(pages.length-1,i));
    apply();
  }
  prev.addEventListener("click",function(){show(cur-1);});
  next.addEventListener("click",function(){show(cur+1);});
  toggle.addEventListener("click",function(){
    var stack=deck.getAttribute("data-ark-deck-mode")!=="stack";
    deck.setAttribute("data-ark-deck-mode",stack?"stack":"page");
    toggle.textContent=stack?"1 枚ずつ":"すべて表示";
    apply();
    if(!stack)window.scrollTo(0,0);
  });
  document.addEventListener("keydown",function(e){
    if(deck.getAttribute("data-ark-deck-mode")!=="page")return;
    var t=e.target;
    if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;
    if(e.key==="ArrowRight"||e.key==="PageDown"){show(cur+1);e.preventDefault();}
    if(e.key==="ArrowLeft"||e.key==="PageUp"){show(cur-1);e.preventDefault();}
  });
  show(0);
})();`;

const INJECTED_SCRIPT_RE = new RegExp(
  `<script[^>]*\\bid=["']${DIAGRAM_DECK_MARKER}["']`,
  "i"
);

function renderPage(page: DeckPage): string {
  if (page.type === "html") {
    return `<div class="ark-deck-page" data-ark-deck-slot="${escapeHtml(page.id)}"></div>`;
  }
  return (
    `<div class="ark-deck-page" ${PAGE_ATTRIBUTE}="${escapeHtml(page.id)}">` +
    renderStaticBuiltin(page.type, page.model) +
    `</div>`
  );
}

/** デッキのページを生成し、めくる操作と一緒に `</body>` の直前へ差し込む */
export function injectDeckProjection(
  html: string,
  model: DiagramModel
): string {
  if (model.type !== DECK_TYPE) return html;
  if (INJECTED_SCRIPT_RE.test(html)) return html;
  const parsed = parseDeckPages(model);
  if (!parsed.ok) return html;

  const types = new Set(
    parsed.pages
      .filter(page => page.type !== "html")
      .map(page => page.type as StaticBuiltinType)
  );
  const css =
    STATIC_BASE_CSS +
    [...types].map(type => STATIC_BUILTIN_OWN_CSS[type]).join("") +
    DECK_CSS;
  const title = model.title
    ? `<h1 class="ark-deck-title">${escapeHtml(model.title)}</h1>`
    : "";

  const projection =
    `<style data-ark-harness-ui="1">${css}</style>` +
    `<div class="ark-deck" data-ark-deck-mode="page" ${GENERATED_ATTR}="1">` +
    title +
    `<div class="ark-deck-pages">${parsed.pages.map(renderPage).join("")}</div>` +
    `<nav class="ark-deck-nav">` +
    `<button type="button" class="ark-deck-step" data-ark-deck-go="-1" aria-label="前のページ">←</button>` +
    `<span class="ark-deck-dots ark-deck-step"></span>` +
    `<span class="ark-deck-pos ark-deck-step"></span>` +
    `<button type="button" class="ark-deck-step" data-ark-deck-go="1" aria-label="次のページ">→</button>` +
    `<button type="button" data-ark-deck-toggle>すべて表示</button>` +
    `</nav></div>` +
    `<script id="${DIAGRAM_DECK_MARKER}" data-ark-harness-ui="1">${DECK_SCRIPT}</script>`;

  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + projection;
  return html.slice(0, closing) + projection + html.slice(closing);
}
