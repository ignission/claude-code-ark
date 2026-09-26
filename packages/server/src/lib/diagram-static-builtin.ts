/**
 * 静的な投影を持つ内蔵図種（sequence / call-tree）。
 *
 * ## なぜ graph と分けるか
 *
 * er や flow は「node を置いて線で結ぶ」図なので、ハーネスの自動レイアウトと
 * edge 描画に載せられる。sequence と call-tree はそうではない。
 *
 * - sequence は **時間順**が意味を持つ。node をどこへ置くかではなく、step が
 *   何番目かが読みたいものなので、自由に動かせる canvas に置くと壊れる
 * - call-tree は **入れ子**が意味を持つ。深さと親子が読みたいもので、座標は
 *   何も語らない
 *
 * どちらも「モデルから見た目への写像が一意に決まる」点は他の内蔵図種と同じ
 * なので、投影はここで生成してファイルへは焼き付けない（モデルだけが残る）。
 *
 * ## 語彙
 *
 * core 語彙（node / edge / label / kind）だけを使い、図種固有の値は ext に置く。
 *
 * - **sequence**: node = 参加者（kind 既定 `actor`）。edge = メッセージで、
 *   **配列の順序が時間順**。`edge.ext.style` は `call` / `return` / `async`、
 *   `edge.ext.source` は `path#L10-L20` 形式のコードの在処
 * - **call-tree**: node = フレーム。親子は edge（`from` = 親）で表す。
 *   `node.kind` は `frame`（既定）/ `added`（この変更で足された）/
 *   `removed`（消えた）。`node.ext.source` はコードの在処、
 *   `node.ext.added` / `node.ext.removed` は差分量、`node.ext.via` は
 *   `call` / `queue` / `callback` / `rpc`、`node.ext.note` は 1 行の補足
 *
 * リンクは worktree 相対パスだけを受け付ける。`http(s)` も `..` も絶対パスも
 * 弾く（押すとファイルビューアが開く経路なので、図から外へ出さない）。
 */

import { GENERATED_ATTR } from "./diagram-builtin.js";
import type {
  DiagramEdge,
  DiagramModel,
  DiagramNode,
} from "./diagram-model.js";

export const STATIC_BUILTIN_TYPES = ["sequence", "call-tree"] as const;
export type StaticBuiltinType = (typeof STATIC_BUILTIN_TYPES)[number];

export function isStaticBuiltinType(type: unknown): type is StaticBuiltinType {
  return (STATIC_BUILTIN_TYPES as readonly unknown[]).includes(type);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extString(
  ext: Record<string, unknown> | undefined,
  key: string
): string {
  const value = ext?.[key];
  return typeof value === "string" ? value : "";
}

function extCount(
  ext: Record<string, unknown> | undefined,
  key: string
): number | null {
  const value = ext?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * コードの在処（`packages/foo.ts#L10-L20`）をリンクにする。
 * 外へ出る href（スキーム付き・絶対パス・`..`）は素のテキストに落とす。
 */
function renderSource(source: string, text: string): string {
  const safeText = escapeHtml(text);
  if (!source) return safeText;
  const outside =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source) ||
    source.startsWith("/") ||
    source.startsWith("#") ||
    source.split("/").includes("..");
  if (outside) return safeText;
  return `<a href="${escapeHtml(source)}">${safeText}</a>`;
}

const STATIC_BASE_CSS = `
body{margin:0;padding:1.1rem;background:#0b1018;color:#dbe4f0;
font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;font-size:14px}
.ark-static-title{margin:0 0 .8rem;font-size:1.02rem;font-weight:700}
.ark-static-panel{border:1px solid #22304a;border-radius:10px;background:#101827;
overflow:hidden;margin:0 0 .9rem}
.ark-static-head{display:flex;align-items:center;gap:.5rem;padding:.45rem .65rem;
border-bottom:1px solid #1c2740;background:#0d1420}
.ark-static-tag{padding:.08rem .36rem;border-radius:4px;background:#1e2a40;color:#8fa6c4;
font:700 .6rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.06em}
.ark-static-name{font-size:.78rem;font-weight:650;color:#e6edf8}
.ark-static-count{margin-left:auto;color:#6b7b93;font-size:.66rem}
.ark-static-body{padding:.6rem .65rem .7rem}
.ark-static-empty{color:#6b7b93;font-size:.75rem}
a{color:#7dd3fc}
`;

const SEQUENCE_CSS = `${STATIC_BASE_CSS}
.ark-seq{position:relative}
.ark-seq-actors{display:grid;gap:.3rem;margin:0 0 .35rem}
.ark-seq-actor{padding:.25rem .3rem;border:1px solid #33445f;border-radius:5px;
background:#141d2e;color:#e6edf8;text-align:center;
font:700 .66rem/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;
overflow-wrap:anywhere}
.ark-seq-actor[data-kind="new"]{border-color:#2f855a}
.ark-seq-steps{position:relative;display:grid;gap:.1rem}
.ark-seq-lifelines{position:absolute;inset:0;pointer-events:none}
.ark-seq-life{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed #2b3a57}
.ark-seq-step{display:grid;align-items:end;row-gap:.12rem;padding:.18rem 0 .34rem}
/* ラベルは矢印の幅に押し込むと 1 語が途中で折れて読めなくなるので、
   矢印の 1 行上にパネル全幅で置く（狭いペインでの可読性を優先する） */
.ark-seq-label{grid-row:1;grid-column:2/-1;color:#b6c6dd;
font:.64rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.ark-seq-msg{grid-row:2;position:relative;min-height:.7rem;
display:flex;flex-direction:column;justify-content:flex-end}
.ark-seq-line{position:relative;height:0;border-top:1px solid #7f9ec4}
.ark-seq-step[data-style="async"] .ark-seq-line{border-top-style:dashed}
.ark-seq-step[data-style="return"] .ark-seq-line{border-top-style:dotted;border-top-color:#5d789c}
.ark-seq-line::after{content:"";position:absolute;top:-4px;width:0;height:0;
border-top:4px solid transparent;border-bottom:4px solid transparent}
.ark-seq-step[data-dir="right"] .ark-seq-line::after{right:-1px;border-left:7px solid #7f9ec4}
.ark-seq-step[data-dir="left"] .ark-seq-line::after{left:-1px;border-right:7px solid #7f9ec4}
.ark-seq-step[data-dir="self"] .ark-seq-line{border:1px solid #5d789c;border-left:0;
height:.55rem;width:55%;margin-left:45%;border-radius:0 4px 4px 0}
.ark-seq-step[data-dir="self"] .ark-seq-line::after{left:45%;bottom:-4px;top:auto;
border-right:7px solid #5d789c}
.ark-seq-no{grid-row:2;grid-column:1;align-self:end;padding-right:.35rem;color:#5b6b83;
text-align:right;font:.6rem/1 ui-monospace,SFMono-Regular,Consolas,monospace}
`;

const CALL_TREE_CSS = `${STATIC_BASE_CSS}
.ark-tree{margin:0;padding:0;list-style:none;
font:.69rem/1.75 ui-monospace,SFMono-Regular,Consolas,monospace}
.ark-tree-row{display:flex;align-items:baseline;gap:.35rem;padding:.12rem 0}
.ark-tree-row + .ark-tree-row{border-top:1px solid #151f31}
.ark-tree-twig{color:#44546e;white-space:pre}
.ark-tree-what{flex:1;color:#cfe0f5;overflow-wrap:anywhere}
.ark-tree-note{color:#7f8fa6}
.ark-tree-via{padding:0 .28rem;border:1px solid #33445f;border-radius:3px;
color:#8fa6c4;font-size:.6rem}
.ark-tree-stat{white-space:nowrap;color:#5f7186;font-size:.64rem}
.ark-tree-add{color:#3fb950}
.ark-tree-del{color:#f85149}
.ark-tree-row[data-kind="added"] .ark-tree-twig{color:#3fb950}
.ark-tree-row[data-kind="removed"]{opacity:.72}
.ark-tree-row[data-kind="removed"] .ark-tree-what{text-decoration:line-through;
text-decoration-color:#f8514980}
`;

export const STATIC_BUILTIN_CSS: Readonly<Record<StaticBuiltinType, string>> = {
  sequence: SEQUENCE_CSS,
  "call-tree": CALL_TREE_CSS,
};

function panel(
  tag: string,
  name: string,
  count: string,
  body: string,
  kind: string
): string {
  return (
    `<section class="ark-static-panel" data-ark-static="${kind}" ${GENERATED_ATTR}="1">` +
    `<header class="ark-static-head"><span class="ark-static-tag">${escapeHtml(tag)}</span>` +
    `<span class="ark-static-name">${escapeHtml(name)}</span>` +
    `<span class="ark-static-count">${escapeHtml(count)}</span></header>` +
    `<div class="ark-static-body">${body}</div></section>`
  );
}

/** 参加者の並び順（モデルの node 順）と、id から列番号への対応 */
function actorColumns(nodes: DiagramNode[]): Map<string, number> {
  const columns = new Map<string, number>();
  for (const [index, node] of nodes.entries()) columns.set(node.id, index);
  return columns;
}

function renderSequence(model: DiagramModel): string {
  const actors = model.nodes;
  if (actors.length === 0) {
    return panel(
      "SEQ",
      model.title ?? "",
      "",
      `<p class="ark-static-empty">参加者がありません</p>`,
      "sequence"
    );
  }
  const columns = actorColumns(actors);
  const count = actors.length;
  const gridStyle = `grid-template-columns:2rem repeat(${count},1fr)`;

  const actorCells = actors
    .map(actor => {
      const kind = actor.kind ? ` data-kind="${escapeHtml(actor.kind)}"` : "";
      return (
        `<div class="ark-seq-actor" data-ark-id="${escapeHtml(actor.id)}"` +
        ` data-model-id="${escapeHtml(actor.id)}"${kind}>${escapeHtml(actor.label)}</div>`
      );
    })
    .join("");

  const lifelines = actors
    .map((_, index) => {
      // 左端の番号列 2rem を除いた幅を count 等分し、その中央へ引く
      const left = `calc(2rem + (100% - 2rem) / ${count} * ${index} + (100% - 2rem) / ${count * 2})`;
      return `<span class="ark-seq-life" style="left:${left}"></span>`;
    })
    .join("");

  const steps = model.edges
    .map((edge, index) => renderStep(edge, index, columns, gridStyle))
    .filter(step => step.length > 0)
    .join("");

  const body =
    `<div class="ark-seq">` +
    `<div class="ark-seq-actors" style="${gridStyle};grid-template-areas:none">` +
    `<div></div>${actorCells}</div>` +
    `<div class="ark-seq-steps"><div class="ark-seq-lifelines">${lifelines}</div>${steps}</div>` +
    `</div>`;

  return panel(
    "SEQ",
    model.title ?? "",
    `${model.edges.length} steps`,
    body,
    "sequence"
  );
}

function renderStep(
  edge: DiagramEdge,
  index: number,
  columns: Map<string, number>,
  gridStyle: string
): string {
  const from = columns.get(edge.from);
  const to = columns.get(edge.to);
  if (from === undefined || to === undefined) return "";

  const style = extString(edge.ext, "style") || "call";
  const direction = from === to ? "self" : to > from ? "right" : "left";
  const startColumn = Math.min(from, to) + 2;
  const endColumn = Math.max(from, to) + 3;
  const span =
    direction === "self"
      ? `grid-column:${from + 2}/${from + 3}`
      : `grid-column:${startColumn}/${endColumn}`;

  const source = extString(edge.ext, "source");
  const label = renderSource(source, edge.label ?? "");

  return (
    `<div class="ark-seq-step" data-ark-id="${escapeHtml(edge.id)}"` +
    ` data-style="${escapeHtml(style)}" data-dir="${direction}"` +
    ` style="${gridStyle}">` +
    `<span class="ark-seq-label">${label}</span>` +
    `<span class="ark-seq-no">${index + 1}</span>` +
    `<span class="ark-seq-msg" style="${span}">` +
    `<span class="ark-seq-line"></span></span>` +
    `</div>`
  );
}

/** 親 → 子の edge から、根から辿れる順（深さ優先）に並べ直す */
function orderFrames(
  model: DiagramModel
): Array<{ node: DiagramNode; depth: number }> {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of model.edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)?.push(edge.to);
    hasParent.add(edge.to);
  }
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const ordered: Array<{ node: DiagramNode; depth: number }> = [];
  const seen = new Set<string>();

  const walk = (id: string, depth: number): void => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    ordered.push({ node, depth });
    for (const child of children.get(id) ?? []) walk(child, depth + 1);
  };

  for (const node of model.nodes) {
    if (!hasParent.has(node.id)) walk(node.id, 0);
  }
  // 循環や親不明で辿り着けなかった node も落とさず末尾に出す
  for (const node of model.nodes) {
    if (!seen.has(node.id)) ordered.push({ node, depth: 0 });
  }
  return ordered;
}

function renderCallTree(model: DiagramModel): string {
  const frames = orderFrames(model);
  if (frames.length === 0) {
    return panel(
      "CALL TREE",
      model.title ?? "",
      "",
      `<p class="ark-static-empty">フレームがありません</p>`,
      "call-tree"
    );
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  const rows = frames
    .map(({ node, depth }) => {
      const added = extCount(node.ext, "added");
      const removed = extCount(node.ext, "removed");
      totalAdded += added ?? 0;
      totalRemoved += removed ?? 0;

      const twig = depth === 0 ? "└" : `${" ".repeat(depth)}└`;
      const via = extString(node.ext, "via");
      const note = extString(node.ext, "note");
      const stat = [
        node.kind === "added" ? `<span class="ark-tree-add">new</span>` : "",
        added === null ? "" : `<span class="ark-tree-add">+${added}</span>`,
        removed === null || removed === 0
          ? ""
          : `<span class="ark-tree-del">−${removed}</span>`,
      ]
        .filter(part => part.length > 0)
        .join(" ");

      return (
        `<li class="ark-tree-row" data-ark-id="${escapeHtml(node.id)}"` +
        ` data-kind="${escapeHtml(node.kind ?? "frame")}">` +
        `<span class="ark-tree-twig">${escapeHtml(twig)}</span>` +
        `<span class="ark-tree-what">${renderSource(extString(node.ext, "source"), node.label)}` +
        (via ? ` <span class="ark-tree-via">${escapeHtml(via)}</span>` : "") +
        (note
          ? ` <span class="ark-tree-note">${escapeHtml(note)}</span>`
          : "") +
        `</span>` +
        (stat ? `<span class="ark-tree-stat">${stat}</span>` : "") +
        `</li>`
      );
    })
    .join("");

  const total =
    totalAdded === 0 && totalRemoved === 0
      ? `${frames.length} frames`
      : `+${totalAdded} −${totalRemoved}`;

  return panel(
    "CALL TREE",
    model.title ?? "",
    total,
    `<ul class="ark-tree">${rows}</ul>`,
    "call-tree"
  );
}

/**
 * 静的な内蔵図種の投影を html へ差し込む。
 * 対象外の図種、または自前の投影を持つ図（`data-ark-static` が既にある）はそのまま返す。
 */
export function injectStaticBuiltinProjection(
  html: string,
  model: DiagramModel
): string {
  if (!isStaticBuiltinType(model.type)) return html;
  if (
    /data-ark-static\s*=/i.test(
      html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    )
  ) {
    return html;
  }

  const css = STATIC_BUILTIN_CSS[model.type];
  const title = model.title
    ? `<h1 class="ark-static-title" ${GENERATED_ATTR}="1">${escapeHtml(model.title)}</h1>`
    : "";
  const projection =
    `<style data-ark-harness-ui="1">${css}</style>` +
    title +
    (model.type === "sequence" ? renderSequence(model) : renderCallTree(model));

  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + projection;
  return html.slice(0, closing) + projection + html.slice(closing);
}
