/**
 * 既知の図種の投影（DOM + CSS）を配信時に生成する。
 *
 * ## なぜサーバー側で生成するか
 *
 * ER 図やイベントストーミングのように書式が決まっている図では、モデルから
 * 見た目への写像は一意に決まる。それでも生成物に HTML を書かせると、
 * (1) モデルと投影という食い違いうる真実が二つできる、
 * (2) 同じ概念の CSS が図ごとに少しずつ違う、
 * (3) 生成コストの半分が転記作業になる、
 * という三つの問題が出る。図種が既知なら投影は導出できるので、ここで生成する。
 *
 * ハーネス（diagram-harness.ts）側に足さないのは注入サイズの都合。ハーネスは
 * 全図に配られるため上限（128KiB）が近く、図種ごとの CSS を積むと全図が
 * その分を払うことになる。ここで生成すれば、費用を払うのはその図種の図だけ。
 *
 * ## 生成物をファイルに焼き付けない
 *
 * 生成した DOM には `data-ark-harness-generated` を、CSS には
 * `data-ark-harness-ui` を付ける。どちらもハーネスの `buildSubmissionHtml` が
 * 送信 HTML から取り除くため、図ファイルはモデルだけの状態を保つ。
 * これが崩れると最初の保存で投影が焼き付き、二重管理へ逆戻りする。
 *
 * ## 手書き投影との関係
 *
 * 生成物が自前の graph container を持つ図には一切触らない。決まった図種でない
 * 図（ロードマップ、説明図）を自由に書ける現状の強みを残すための逃げ道。
 */

import type { DiagramModel, DiagramNode } from "./diagram-model.js";

/** ハーネスが送信 HTML から取り除く印（生成 DOM 用） */
export const GENERATED_ATTR = "data-ark-harness-generated";

interface BuiltinType {
  /** 図種専用の CSS（外部リソースを参照しない） */
  css: string;
}

const BASE_CSS = `
body{margin:0;padding:1.25rem;background:#0f1117;color:#e2e8f0;
font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;font-size:14px}
.ark-builtin-title{margin:0 0 .9rem;font-size:1.05rem;font-weight:700}
[data-ark-builtin]{position:relative;min-height:60vh}
.ark-builtin-node{box-sizing:border-box;width:13.5rem;padding:.45rem .6rem;
border:1px solid var(--k,#565f89);border-left:5px solid var(--k,#565f89);
border-radius:6px;background:var(--kb,#1e202b)}
.ark-builtin-node::before{display:block;font-size:.58rem;letter-spacing:.05em;
color:var(--k,#94a3b8);content:var(--kg,"\\25A3")}
.ark-builtin-label{display:block;font-size:.84rem;font-weight:650;line-height:1.35;margin-top:.05rem}
.ark-builtin-fields{list-style:none;margin:.32rem 0 0;padding:.28rem 0 0;
border-top:1px solid rgba(148,163,184,.28)}
.ark-builtin-fields li{padding:.14rem 0;font-size:.7rem;line-height:1.4;color:#aeb7d6}
.ark-builtin-note{white-space:pre-wrap;font-size:.72rem;line-height:1.45;color:#cbd5e1}
.ark-builtin-group{display:none;box-sizing:border-box;position:absolute;
left:calc(var(--ark-harness-group-x) - 1.3rem);
top:calc(var(--ark-harness-group-y) - 2.3rem);
width:calc(var(--ark-harness-group-width) + 2.6rem);
height:calc(var(--ark-harness-group-height) + 3.4rem);
border:1px solid #475569;border-radius:.8rem;background:rgba(125,207,255,.05)}
.ark-builtin-group.ark-harness-graph-group{display:block}
.ark-builtin-group .group-label{position:absolute;top:.5rem;left:.8rem;
font-size:.72rem;font-weight:700;color:#7dd3fc}
`;

/**
 * ER / 集約図。entity と field 一覧が主役で、多重度は edge.ext からハーネスが
 * 描く。DDD の戦術設計で使う root / vo / invariant も同じ形なのでここに含める。
 */
const ER_CSS = `${BASE_CSS}
[data-ark-builtin="er"] .ark-builtin-node{--k:#60a5fa;--kb:#172a46;--kg:"\\25B7"}
[data-ark-builtin="er"] .ark-builtin-node[data-kind="root"]{--k:#facc15;--kb:#332b0e;--kg:"\\25C6";border-width:2px;border-left-width:5px}
[data-ark-builtin="er"] .ark-builtin-node[data-kind="vo"]{--k:#4ade80;--kb:#153522;--kg:"\\25C7"}
[data-ark-builtin="er"] .ark-builtin-node[data-kind="external"]{--k:#a3a3a3;--kb:#26262b;--kg:"\\25A4";border-style:dashed;border-left-style:solid}
[data-ark-builtin="er"] .ark-builtin-node[data-kind="invariant"]{--k:#f87171;--kb:#3a1c1c;--kg:"\\26A0";border-style:dashed;border-left-style:solid}
[data-ark-builtin="er"] .ark-builtin-node[data-kind="principle"]{--k:#c084fc;--kb:#2a2044;--kg:"\\00A7";width:15rem}
[data-ark-builtin="er"] .ark-builtin-node[data-kind="note"]{--k:#94a3b8;--kb:#1b2130;width:17rem;border-style:dashed;border-left-style:solid}
`;

/**
 * イベントストーミング。kind ごとの色は event=橙 / command=青 / aggregate=黄 /
 * policy=紫 / actor=桃 / read-model=緑 を既定にし、必ず kind 名を併置する。
 */
const STORMING_CSS = `${BASE_CSS}
[data-ark-builtin="event-storming"] .ark-builtin-node::before{content:var(--kg,"\\25A3") "\\00A0" var(--kn,"")}
[data-ark-builtin="event-storming"] .ark-builtin-node{--k:#94a3b8;--kb:#202b3c;--kg:"\\25A3"}
[data-ark-builtin="event-storming"] .ark-builtin-node[data-kind="event"]{--kn:"event";--k:#f59e0b;--kb:#3b2810;--kg:"\\26A1"}
[data-ark-builtin="event-storming"] .ark-builtin-node[data-kind="command"]{--kn:"command";--k:#60a5fa;--kb:#172a46;--kg:"\\25B6"}
[data-ark-builtin="event-storming"] .ark-builtin-node[data-kind="aggregate"]{--kn:"aggregate";--k:#facc15;--kb:#3a3111;--kg:"\\25C6"}
[data-ark-builtin="event-storming"] .ark-builtin-node[data-kind="policy"]{--kn:"policy";--k:#c084fc;--kb:#302044;--kg:"\\25C7"}
[data-ark-builtin="event-storming"] .ark-builtin-node[data-kind="actor"]{--kn:"actor";--k:#f472b6;--kb:#3b1e35;--kg:"\\25CE";width:9rem}
[data-ark-builtin="event-storming"] .ark-builtin-node[data-kind="read-model"]{--kn:"read-model";--k:#4ade80;--kb:#153522;--kg:"\\25A4"}
[data-ark-builtin="event-storming"] .ark-builtin-node[data-kind="external-system"]{--kn:"external-system";--k:#94a3b8;--kb:#202b3c;--kg:"\\2601"}
[data-ark-builtin="event-storming"] .ark-builtin-node[data-kind="note"]{--kn:"note";--k:#94a3b8;--kb:#1b2130;width:17rem;border-style:dashed;border-left-style:solid}
`;

export const BUILTIN_DIAGRAM_TYPES: Readonly<Record<string, BuiltinType>> = {
  er: { css: ER_CSS },
  "event-storming": { css: STORMING_CSS },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * node 1 個の投影。
 *
 * kind の見出し（icon と kind 名）は DOM に書かず、node root の `::before` を
 * CSS 変数で出す。ハーネスは kind 変更時に root の `data-kind` を更新するだけで
 * 中身の装飾までは面倒を見ないため、静的テキストで書くと kind を変えた後も
 * 古い名前が残る（実機で再現済み）。CSS 由来にすれば表示は `data-kind` の
 * 純粋な関数になり、パレットで追加した node も同じ見出しを得る。
 */
function renderNode(node: DiagramNode): string {
  const id = escapeHtml(node.id);
  const kindAttr = node.kind ? ` data-kind="${escapeHtml(node.kind)}"` : "";
  const parts: string[] = [];

  if (node.kind === "note") {
    // note は label ではなく noteText が本文。ハーネスの note 投影契約に合わせる
    parts.push(
      `<div class="ark-builtin-note" data-ark-harness-note>${escapeHtml(node.noteText ?? "")}</div>`
    );
  } else {
    parts.push(
      `<span class="ark-builtin-label" data-model-id="${id}">${escapeHtml(node.label)}</span>`
    );
    const fields = node.fields ?? [];
    if (fields.length > 0) {
      const items = fields
        .map(
          field =>
            `<li data-model-id="${escapeHtml(field.id)}">${escapeHtml(field.label)}</li>`
        )
        .join("");
      parts.push(`<ul class="ark-builtin-fields">${items}</ul>`);
    }
  }

  return `<article class="ark-builtin-node" data-model-id="${id}"${kindAttr}>${parts.join("")}</article>`;
}

function renderGroup(id: string, label: string): string {
  const safeId = escapeHtml(id);
  return (
    `<section class="ark-builtin-group" data-ark-group data-model-id="${safeId}">` +
    `<span class="group-label" data-model-id="${safeId}">${escapeHtml(label)}</span>` +
    "</section>"
  );
}

/**
 * 生成物が自前の graph を持っているか（持っていれば作者のものを尊重する）。
 *
 * HTML は引用符なしの属性値も許すため `data-ark-container=graph` も拾う。
 * 逆に script 本文（モデル JSON の label 等）や HTML コメントの中の同じ文字列は
 * 属性ではないので、判定前に取り除く。誤検出すると投影を生成せず白紙になり、
 * 見落とすと graph が二重になる。
 */
function hasAuthoredGraph(html: string): boolean {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  return /data-ark-container\s*=\s*(?:"graph"|'graph'|graph(?=[\s/>]|$))/i.test(
    markup
  );
}

/**
 * 既知の図種なら投影 DOM と CSS を html へ差し込む。
 * 未知・未指定の図種、または自前の graph を持つ図はそのまま返す。
 */
export function injectBuiltinProjection(
  html: string,
  model: DiagramModel
): string {
  const typeName = model.type;
  if (typeof typeName !== "string") return html;
  if (!Object.hasOwn(BUILTIN_DIAGRAM_TYPES, typeName)) return html;
  const type = BUILTIN_DIAGRAM_TYPES[typeName];
  if (!type) return html;
  if (hasAuthoredGraph(html)) return html;

  const safeType = escapeHtml(typeName);
  const title = model.title
    ? `<h1 class="ark-builtin-title" ${GENERATED_ATTR}="1">${escapeHtml(model.title)}</h1>`
    : "";
  const groups = model.groups
    .map(group => renderGroup(group.id, group.label))
    .join("");
  const nodes = model.nodes.map(node => renderNode(node)).join("");
  const projection =
    `<style data-ark-harness-ui="1">${type.css}</style>` +
    title +
    `<div data-ark-container="graph" data-ark-builtin="${safeType}" ${GENERATED_ATTR}="1">` +
    groups +
    nodes +
    "</div>";

  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + projection;
  return html.slice(0, closing) + projection + html.slice(closing);
}
