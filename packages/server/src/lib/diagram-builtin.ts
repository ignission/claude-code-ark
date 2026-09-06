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
  /**
   * graph 以外の容れ物を持つ図種だけが実装する DOM builder。
   *
   * 既存 5 種はすべて graph（絶対配置 + edge + drag で x/y 保存）なので
   * 共通の `renderGraph` を使う。バックログのように「順位付きリスト」が
   * 主役の図種は node の並びそのものが意味を持ち、絶対配置に載せられない。
   */
  render?: (model: DiagramModel) => string;
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

/**
 * 業務フロー・シナリオ。分岐と出口の性格（成功 / エラー）が読めることが要件で、
 * group は「単一Tx境界」「同期応答」のような区間の枠として使う。
 */
const FLOW_CSS = `${BASE_CSS}
[data-ark-builtin="flow"] .ark-builtin-node::before{content:var(--kg,"\\25A3") "\\00A0" var(--kn,"")}
[data-ark-builtin="flow"] .ark-builtin-node{--kn:"step";--k:#38bdf8;--kb:#12283a;--kg:"\\25A3"}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="step"]{--kn:"step";--k:#38bdf8;--kb:#12283a;--kg:"\\25A3"}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="command"]{--kn:"command";--k:#60a5fa;--kb:#172a46;--kg:"\\25B6"}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="decision"]{--kn:"decision";--k:#c084fc;--kb:#302044;--kg:"\\25C7"}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="policy"]{--kn:"policy";--k:#c084fc;--kb:#241a33;--kg:"\\25C7"}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="event"]{--kn:"event";--k:#f59e0b;--kb:#2c1f0d;--kg:"\\26A1"}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="outcome"]{--kn:"outcome";--k:#4ade80;--kb:#153522;--kg:"\\2714"}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="error"]{--kn:"error";--k:#f87171;--kb:#3a1a1a;--kg:"\\2716"}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="actor"]{--kn:"actor";--k:#f472b6;--kb:#3b1e35;--kg:"\\25CE";width:9rem}
[data-ark-builtin="flow"] .ark-builtin-node[data-kind="note"]{--kn:"note";--k:#94a3b8;--kb:#1b2130;width:19rem;border-style:dashed;border-left-style:solid}
`;

/**
 * 状態遷移。開始と終了の区別が読めることが要件で、終了は「正常」と「取消」を
 * 別 kind にする。遷移は edge の label と direction で表す。
 */
const STATE_CSS = `${BASE_CSS}
[data-ark-builtin="state"] .ark-builtin-node{--k:#60a5fa;--kb:#172a46;--kg:"\\25CB";
width:11.5rem;border-radius:1.1rem;text-align:center}
[data-ark-builtin="state"] .ark-builtin-node[data-kind="initial"]{--k:#94a3b8;--kb:#242a36;--kg:"\\25CF"}
[data-ark-builtin="state"] .ark-builtin-node[data-kind="state"]{--k:#60a5fa;--kb:#172a46;--kg:"\\25CB"}
[data-ark-builtin="state"] .ark-builtin-node[data-kind="terminal-ok"]{--k:#4ade80;--kb:#153522;--kg:"\\2714";border-width:2px}
[data-ark-builtin="state"] .ark-builtin-node[data-kind="terminal-cancel"]{--k:#f87171;--kb:#3a1a1a;--kg:"\\2716";border-width:2px;border-style:dashed}
[data-ark-builtin="state"] .ark-builtin-node[data-kind="note"]{--k:#94a3b8;--kb:#1b2130;width:18rem;
border-radius:6px;text-align:left;border-style:dashed;border-left-style:solid}
`;

/**
 * コンテキストマップ（戦略設計）。中核と補助と外部の区別が読めることが要件で、
 * 上流下流や関係の種類は edge の label と `edge.ext` に置く。
 */
const CONTEXT_MAP_CSS = `${BASE_CSS}
[data-ark-builtin="context-map"] .ark-builtin-node::before{content:var(--kg,"\\25A3") "\\00A0" var(--kn,"")}
[data-ark-builtin="context-map"] .ark-builtin-node{--kn:"supporting";--k:#60a5fa;--kb:#172a46;--kg:"\\25A3";width:15rem}
[data-ark-builtin="context-map"] .ark-builtin-node[data-kind="core"]{--kn:"core domain";--k:#facc15;--kb:#332b0e;--kg:"\\2605";border-width:2px;border-left-width:5px}
[data-ark-builtin="context-map"] .ark-builtin-node[data-kind="supporting"]{--kn:"supporting";--k:#60a5fa;--kb:#172a46;--kg:"\\25A3"}
[data-ark-builtin="context-map"] .ark-builtin-node[data-kind="generic"]{--kn:"generic";--k:#4ade80;--kb:#153522;--kg:"\\25A3"}
[data-ark-builtin="context-map"] .ark-builtin-node[data-kind="developed"]{--kn:"this phase";--k:#c084fc;--kb:#2a2044;--kg:"\\25B6"}
[data-ark-builtin="context-map"] .ark-builtin-node[data-kind="external"]{--kn:"external";--k:#a3a3a3;--kb:#26262b;--kg:"\\2601";border-style:dashed;border-left-style:solid}
[data-ark-builtin="context-map"] .ark-builtin-node[data-kind="note"]{--kn:"note";--k:#94a3b8;--kb:#1b2130;width:19rem;border-style:dashed;border-left-style:solid}
`;

/**
 * バックログ。順位付きリストが主役で、graph ではない唯一の図種。
 *
 * 行は既存 5 種と同じ `.ark-builtin-node` / `data-model-id` / `data-kind` の
 * 投影契約をそのまま使う（label 編集も field 編集もハーネス側の実装が効く）。
 * 変えるのは容れ物と並べ方だけ。`node.ext.status` は行の `data-status` に載せ、
 * 状態名は CSS 変数から文字として出す（色だけで状態を伝えない）。
 */
const BACKLOG_CSS = `${BASE_CSS}
body{background:#f4f5f7;color:#172b4d}
.ark-builtin-title{color:#172b4d;font-size:1rem}
[data-ark-builtin="backlog"]{min-height:0;border:1px solid #dfe1e6;border-radius:3px;
background:#fff;overflow:hidden}
.ark-backlog-section{display:flex;align-items:center;gap:.5rem;margin:0;
padding:.42rem .7rem;background:#f4f5f7;border-bottom:1px solid #dfe1e6}
.ark-backlog-section .group-label{font-size:.72rem;font-weight:700;color:#172b4d}
.ark-backlog-count{font-size:.66rem;color:#6b778c}
[data-ark-builtin="backlog"] .ark-builtin-node{display:grid;
grid-template-columns:1.05rem 4.4rem minmax(0,1fr) minmax(0,16rem) 6rem;
align-items:center;gap:0 .6rem;width:auto;margin:0;padding:.42rem .7rem;
border:0;border-radius:0;border-bottom:1px solid #ebecf0;background:#fff}
[data-ark-builtin="backlog"] .ark-builtin-node:last-child{border-bottom:0}
[data-ark-builtin="backlog"] .ark-builtin-node:hover{background:#f4f5f7}
[data-ark-builtin="backlog"] .ark-builtin-node::before{content:none}
.ark-backlog-type{grid-column:1;display:grid;place-items:center;
width:1.05rem;height:1.05rem;border-radius:3px;background:var(--k,#8993a4)}
.ark-backlog-type::before{content:var(--kg,"\\25A3");color:#fff;font-size:.62rem;line-height:1}
.ark-backlog-key{grid-column:2;font-size:.68rem;color:#6b778c;white-space:nowrap;
overflow:hidden;text-overflow:ellipsis}
[data-ark-builtin="backlog"] .ark-builtin-label{grid-column:3;margin-top:0;
font-size:.8rem;font-weight:400;color:#172b4d;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-ark-builtin="backlog"] .ark-builtin-node:hover .ark-builtin-label{color:#0052cc}
[data-ark-builtin="backlog"] .ark-builtin-fields{grid-column:4;display:flex;
flex-wrap:nowrap;gap:.28rem;margin:0;padding:0;border-top:none;overflow:hidden;
-webkit-mask-image:linear-gradient(to right,#000 88%,transparent);
mask-image:linear-gradient(to right,#000 88%,transparent)}
[data-ark-builtin="backlog"] .ark-builtin-fields li{flex:0 0 auto;
padding:.06rem .4rem;border:0;border-radius:3px;background:#ebecf0;
font-size:.62rem;color:#42526e;white-space:nowrap;max-width:7.5rem;
overflow:hidden;text-overflow:ellipsis}
[data-ark-builtin="backlog"] .ark-builtin-node[data-status]::after{grid-column:5;
justify-self:end;content:var(--st,"");box-sizing:border-box;min-width:6rem;
padding:.11rem 0;border-radius:3px;text-align:center;
background:var(--sb,#dfe1e6);color:var(--sc,#42526e);
font-size:.58rem;font-weight:700;letter-spacing:.05em;white-space:nowrap}
[data-ark-builtin="backlog"] .ark-builtin-node[data-status="todo"]{--st:"TO DO";--sb:#dfe1e6;--sc:#42526e}
[data-ark-builtin="backlog"] .ark-builtin-node[data-status="doing"]{--st:"IN PROGRESS";--sb:#deebff;--sc:#0747a6}
[data-ark-builtin="backlog"] .ark-builtin-node[data-status="blocked"]{--st:"BLOCKED";--sb:#ffebe6;--sc:#bf2600}
[data-ark-builtin="backlog"] .ark-builtin-node[data-status="done"]{--st:"DONE";--sb:#e3fcef;--sc:#006644}
[data-ark-builtin="backlog"] .ark-builtin-node{--kn:"story";--k:#36b37e;--kg:"\\25A3"}
[data-ark-builtin="backlog"] .ark-builtin-node[data-kind="story"]{--kn:"story";--k:#36b37e;--kg:"\\25A3"}
[data-ark-builtin="backlog"] .ark-builtin-node[data-kind="bug"]{--kn:"bug";--k:#ff5630;--kg:"\\2716"}
[data-ark-builtin="backlog"] .ark-builtin-node[data-kind="task"]{--kn:"task";--k:#4bade8;--kg:"\\2714"}
[data-ark-builtin="backlog"] .ark-builtin-node[data-kind="spike"]{--kn:"spike";--k:#8777d9;--kg:"\\25C7"}
[data-ark-builtin="backlog"] .ark-builtin-node[data-kind="chore"]{--kn:"chore";--k:#8993a4;--kg:"\\25A4"}
[data-ark-builtin="backlog"] .ark-builtin-node[data-kind="epic"]{--kn:"epic";--k:#6554c0;--kg:"\\2605"}
`;

export const BUILTIN_DIAGRAM_TYPES: Readonly<Record<string, BuiltinType>> = {
  er: { css: ER_CSS },
  "event-storming": { css: STORMING_CSS },
  flow: { css: FLOW_CSS },
  state: { css: STATE_CSS },
  "context-map": { css: CONTEXT_MAP_CSS },
  backlog: { css: BACKLOG_CSS, render: renderBacklog },
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

/**
 * バックログの 1 行。`renderNode` と同じ投影契約に `data-status` だけ足す。
 *
 * status を kind に混ぜないのは、種別（story / bug）と状態（todo / done）が
 * 直交するから。kind に done を作ると「done な bug」が表せなくなる。
 */
function renderBacklogRow(node: DiagramNode, rank: number): string {
  const id = escapeHtml(node.id);
  const kind = node.kind && node.kind !== "" ? node.kind : "story";
  const status = node.ext?.status;
  const statusAttr =
    typeof status === "string" && status !== ""
      ? ` data-status="${escapeHtml(status)}"`
      : "";
  // 種別は色の付いた四角（Jira の type icon）で示すが、色だけに頼らないよう
  // 種別名を key 欄に文字としても出す。順位は nodes 配列の位置（rank）。
  const parts = [
    '<span class="ark-backlog-type" aria-hidden="true"></span>',
    `<span class="ark-backlog-key">${rank} \u00B7 ${escapeHtml(kind)}</span>`,
    `<span class="ark-builtin-label" data-model-id="${id}">${escapeHtml(node.label)}</span>`,
  ];
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
  // 1 行に収めるので、切り詰められた要約は title で読めるようにする
  return (
    `<article class="ark-builtin-node" data-model-id="${id}" data-kind="${escapeHtml(kind)}"` +
    ` data-rank="${rank}"${statusAttr} title="${escapeHtml(node.label)}">` +
    parts.join("") +
    "</article>"
  );
}

/**
 * バックログ投影。順位は `model.nodes` の並び、区切りは group。
 *
 * group に属さない node は最後にまとめて出す。同じ node を複数 group に入れた
 * 場合は最初の group にだけ出し、行の重複は作らない（順位が二つになるため）。
 */
function renderBacklog(model: DiagramModel): string {
  const placed = new Set<string>();
  const sections: string[] = [];
  const rankOf = new Map(
    model.nodes.map((node, index) => [node.id, index + 1])
  );

  for (const group of model.groups) {
    const rows = model.nodes
      .filter(node => group.nodes.includes(node.id) && !placed.has(node.id))
      .map(node => {
        placed.add(node.id);
        return renderBacklogRow(node, rankOf.get(node.id) ?? 0);
      });
    if (rows.length === 0) continue;
    const safeId = escapeHtml(group.id);
    sections.push(
      `<section class="ark-backlog-section" data-ark-group data-model-id="${safeId}">` +
        `<span class="group-label" data-model-id="${safeId}">${escapeHtml(group.label)}</span>` +
        `<span class="ark-backlog-count">${rows.length} 件</span>` +
        "</section>" +
        rows.join("")
    );
  }

  const rest = model.nodes
    .filter(node => !placed.has(node.id))
    .map(node => renderBacklogRow(node, rankOf.get(node.id) ?? 0));
  if (rest.length > 0) sections.push(rest.join(""));

  return sections.join("");
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
 * 見落とすと容れ物が二重になる。
 *
 * これから生成する容れ物と同じ名前だけを見る。graph 固定にすると、既に list を
 * 持つ HTML へ二度目の注入が通り、投影がまるごと重複する（codex review 指摘）。
 */
function hasContainer(html: string, name: string): boolean {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  return new RegExp(
    `data-ark-container\\s*=\\s*(?:"${name}"|'${name}'|${name}(?=[\\s/>]|$))`,
    "i"
  ).test(markup);
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
  // graph 以外の容れ物を持つ図種は自前の DOM を組む。graph という値は
  // ハーネスの自動レイアウト・edge 描画・drag の入口なので、リストの図種に
  // 付けてはならない（付けると絶対配置に載せられて行が重なる）。
  const container = type.render ? "list" : "graph";
  if (hasContainer(html, container)) return html;

  const safeType = escapeHtml(typeName);
  const title = model.title
    ? `<h1 class="ark-builtin-title" ${GENERATED_ATTR}="1">${escapeHtml(model.title)}</h1>`
    : "";
  const body = type.render
    ? type.render(model)
    : model.groups.map(g => renderGroup(g.id, g.label)).join("") +
      model.nodes.map(node => renderNode(node)).join("");
  const projection =
    `<style data-ark-harness-ui="1">${type.css}</style>` +
    title +
    `<div data-ark-container="${container}" data-ark-builtin="${safeType}" ${GENERATED_ATTR}="1">` +
    body +
    "</div>";

  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + projection;
  return html.slice(0, closing) + projection + html.slice(closing);
}
