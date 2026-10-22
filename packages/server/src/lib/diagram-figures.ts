/**
 * 見て分かる内蔵図種（git-graph / timeline / tree / compare）。
 *
 * ## なぜ要るか
 *
 * デッキの部品（cards / chips / table / list …）は文字を枠に入れるだけで、ブランチの
 * 位置関係や経緯の順序は文字で読ませるしかなかった。実際、書かれたデッキのページの
 * 9 割強が部品のページで、その中身も表と箇条書きが大半だった。ブランチなら
 * コミットのグラフ、経緯なら時間の軸というように、中身に合う形で見せるための図種。
 *
 * ## 共通の決まり
 *
 * - sequence / call-tree と同じく座標を持たない。並びはモデルの順序と親子から決まる
 *   ので、デッキのページにも単独の図にも置ける。生成物はファイルへ焼き付けない
 * - core 語彙（node / edge / label / kind）だけを使い、図種固有の値は ext に置く
 * - 見た目は部品のページ（diagram-deck-blocks.ts）と同じ地と色で、OS の明暗に追従する
 * - 行（node）に `data-ark-id` を出し、コメントの付け先にする
 * - label と note の中では部品と同じ飾り（`{a:語}` / `` `語` `` / リンク）が効く
 *
 * ## 語彙
 *
 * - **git-graph**: node = コミット。**配列の先頭が新しい**（`git log` と同じ向き）。
 *   edge = 親（古い）→ 子（新しい）。`ext.branch` で列（レーン）を分け、`ext.sha`、
 *   `ext.refs`（ブランチ名・タグ・PR の札）、`ext.note` を書ける。`kind` は
 *   `commit`（既定）/ `added`（この作業で足した）/ `removed`（捨てる・消えた）。
 *   親を 2 つ以上持つ node がマージになる
 * - **timeline**: node = 出来事で、**配列の順序が時間順**。`ext.at`（日時の表記）、
 *   `ext.lane`（あればレーンを分ける）、`ext.note`。`kind` は `event`（既定）/ `ok` /
 *   `ng` / `warn` / `milestone`。edge は使わない
 * - **tree**: node = 項目、edge = 親 → 子。`kind` は `node`（既定）/ `added` /
 *   `removed` / `changed` / `kept`。`ext.note`、`ext.source`（worktree 相対のパス）
 * - **compare**: node を `ext.side` で 2 列に分ける（列の見出しは side の値）。
 *   edge で左右の対応する項目を 1 対 1 で結ぶ。`kind` は `same` / `changed` /
 *   `added` / `removed` で、書かなければ対応の有無と label の一致から決まる
 */

import { GENERATED_ATTR } from "./diagram-builtin.js";
import { DECK_BLOCKS_CSS, renderInline } from "./diagram-deck-blocks.js";
import type { DiagramModel, DiagramNode } from "./diagram-model.js";
import {
  isWorktreeSourceHref,
  STATIC_BASE_CSS,
} from "./diagram-static-builtin.js";

export const FIGURE_TYPES = [
  "git-graph",
  "timeline",
  "tree",
  "compare",
] as const;
export type FigureType = (typeof FIGURE_TYPES)[number];

export function isFigureType(type: unknown): type is FigureType {
  return (FIGURE_TYPES as readonly unknown[]).includes(type);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extString(node: DiagramNode, key: string): string {
  const value = node.ext?.[key];
  return typeof value === "string" ? value : "";
}

function idAttr(id: string): string {
  return `data-ark-id="${escapeHtml(id)}"`;
}

function note(node: DiagramNode, className: string): string {
  const text = extString(node, "note");
  return text ? `<span class="${className}">${renderInline(text)}</span>` : "";
}

// ===== 検証 =====

/**
 * 図種ごとの形の決まりを確かめる。モデル全体の検証（id の重複・参照切れ）は
 * parseDiagramModel が済ませている前提。黙って描き崩すより、書いた側に理由を返す。
 */
export function validateFigureModel(
  type: FigureType,
  model: DiagramModel
): { ok: true } | { ok: false; error: string } {
  if (type === "git-graph") {
    const row = new Map(model.nodes.map((node, index) => [node.id, index]));
    for (const edge of model.edges) {
      if ((row.get(edge.from) ?? 0) <= (row.get(edge.to) ?? 0)) {
        return {
          ok: false,
          error:
            `git-graph の edge ${edge.id} の向きが逆です。node は新しいコミットを先頭に並べ、` +
            "edge は親（古い）→ 子（新しい）で書きます",
        };
      }
    }
  }
  if (type === "timeline" && model.edges.length > 0) {
    return {
      ok: false,
      error:
        "timeline は edge を使いません。出来事は node を時間順に並べて書きます",
    };
  }
  if (type === "compare") {
    const sides = compareSides(model.nodes);
    const missing = model.nodes.find(node => !extString(node, "side"));
    if (missing) {
      return {
        ok: false,
        error: `compare の node ${missing.id} に ext.side がありません（列の見出しになる値）`,
      };
    }
    if (sides.length !== 2) {
      return {
        ok: false,
        error: `compare は ext.side で 2 列に分けます（${sides.length} 列ありました）`,
      };
    }
    const paired = new Set<string>();
    for (const edge of model.edges) {
      const fromSide = sideOf(model, edge.from);
      const toSide = sideOf(model, edge.to);
      if (fromSide === toSide) {
        return {
          ok: false,
          error: `compare の edge ${edge.id} は同じ列の項目を結んでいます。edge は左右の対応を結びます`,
        };
      }
      for (const id of [edge.from, edge.to]) {
        if (paired.has(id)) {
          return {
            ok: false,
            error:
              `compare の node ${id} に対応が 2 つ以上あります。対応は 1 対 1 で、` +
              "分かれる・まとまるときは ext.note に書きます",
          };
        }
        paired.add(id);
      }
    }
  }
  return { ok: true };
}

// ===== git-graph =====

const GIT_ROW = 34;
const GIT_LANE = 16;
const GIT_PAD = 8;
const GIT_COLORS = 6;

function gitX(lane: number): number {
  return GIT_PAD + lane * GIT_LANE + GIT_LANE / 2;
}

function gitY(row: number): number {
  return row * GIT_ROW + GIT_ROW / 2;
}

/** 縦に出て縦に入る曲線（a から b へ） */
function curve(ax: number, ay: number, bx: number, by: number): string {
  const my = (ay + by) / 2;
  return `C ${ax} ${my}, ${bx} ${my}, ${bx} ${by}`;
}

function renderGitGraph(model: DiagramModel): string {
  const nodes = model.nodes;
  if (nodes.length === 0) {
    return `<p class="ark-fig-empty">コミットがありません</p>`;
  }
  const row = new Map(nodes.map((node, index) => [node.id, index]));
  const parents = new Map<string, string[]>();
  for (const edge of model.edges) {
    if (!parents.has(edge.to)) parents.set(edge.to, []);
    parents.get(edge.to)?.push(edge.from);
  }

  // 古い順に見て、branch を書いていないコミットは最初の親の列を継ぐ。
  // 列の並びも古い順の初出にする（根のある main が左端に来る）
  const branch = new Map<string, string>();
  const lanes: string[] = [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    const firstParent = parents.get(node.id)?.[0];
    const name =
      extString(node, "branch") ||
      (firstParent ? branch.get(firstParent) : undefined) ||
      "main";
    branch.set(node.id, name);
    if (!lanes.includes(name)) lanes.push(name);
  }
  const laneOf = (id: string): number =>
    lanes.indexOf(branch.get(id) ?? "main");

  const paths: string[] = [];
  for (const edge of model.edges) {
    const pr = row.get(edge.from) ?? 0;
    const cr = row.get(edge.to) ?? 0;
    const pl = laneOf(edge.from);
    const cl = laneOf(edge.to);
    let d: string;
    let lane: number;
    if (pl === cl) {
      d = `M ${gitX(cl)} ${gitY(cr)} V ${gitY(pr)}`;
      lane = cl;
    } else if ((parents.get(edge.to) ?? []).some(id => laneOf(id) === cl)) {
      // 子が自分の列に別の親を持つ = 別の列から取り込んだマージ。
      // 取り込まれる側の列を子の 1 行下まで上り、そこから子へ曲がる
      const turn = cr + 1;
      d =
        `M ${gitX(pl)} ${gitY(pr)} V ${gitY(turn)} ` +
        curve(gitX(pl), gitY(turn), gitX(cl), gitY(cr));
      lane = pl;
    } else {
      // 分岐: 子の列を親の 1 行上まで下り、そこから親へ曲がる
      const turn = Math.max(cr, pr - 1);
      d =
        `M ${gitX(cl)} ${gitY(cr)} V ${gitY(turn)} ` +
        curve(gitX(cl), gitY(turn), gitX(pl), gitY(pr));
      lane = cl;
    }
    paths.push(`<path class="ark-git-c${lane % GIT_COLORS}" d="${d}"></path>`);
  }

  const dots = nodes
    .map((node, index) => {
      const lane = laneOf(node.id);
      const merge = (parents.get(node.id)?.length ?? 0) > 1;
      const kind = node.kind ?? "commit";
      return (
        `<circle class="ark-git-c${lane % GIT_COLORS}" data-kind="${escapeHtml(kind)}"` +
        `${merge ? ' data-merge="1"' : ""} cx="${gitX(lane)}" cy="${gitY(index)}"` +
        ` r="${merge ? 4 : 5}"></circle>`
      );
    })
    .join("");

  const width = GIT_PAD * 2 + lanes.length * GIT_LANE;
  const height = nodes.length * GIT_ROW;

  const rows = nodes
    .map(node => {
      const sha = extString(node, "sha");
      const refs = Array.isArray(node.ext?.refs)
        ? node.ext.refs.filter(
            (ref): ref is string => typeof ref === "string" && ref !== ""
          )
        : [];
      const kind = node.kind ?? "commit";
      return (
        `<li class="ark-git-row" ${idAttr(node.id)} data-kind="${escapeHtml(kind)}">` +
        (sha ? `<code class="ark-git-sha">${escapeHtml(sha)}</code>` : "") +
        refs
          .map(ref => `<span class="ark-git-ref">${renderInline(ref)}</span>`)
          .join("") +
        `<span class="ark-git-msg">${renderInline(node.label)}</span>` +
        note(node, "ark-git-note") +
        `</li>`
      );
    })
    .join("");

  const legend = lanes
    .map(
      (name, index) =>
        `<span class="ark-git-lane ark-git-c${index % GIT_COLORS}">${escapeHtml(name)}</span>`
    )
    .join("");

  return (
    `<div class="ark-git">` +
    `<div class="ark-git-legend">${legend}</div>` +
    `<div class="ark-git-body" style="--ark-git-w:${width}px">` +
    `<svg class="ark-git-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">` +
    `${paths.join("")}${dots}</svg>` +
    `<ol class="ark-git-rows">${rows}</ol>` +
    `</div></div>`
  );
}

// ===== timeline =====

const TIMELINE_MARK: Readonly<Record<string, string>> = {
  ok: "✓",
  ng: "✕",
  warn: "!",
};

function renderTimeline(model: DiagramModel): string {
  const events = model.nodes;
  if (events.length === 0) {
    return `<p class="ark-fig-empty">出来事がありません</p>`;
  }
  const lanes: string[] = [];
  for (const event of events) {
    const lane = extString(event, "lane");
    if (!lanes.includes(lane)) lanes.push(lane);
  }
  const columns = lanes.length;
  const head =
    columns > 1 || lanes[0] !== ""
      ? `<div></div>` +
        lanes
          .map(
            lane =>
              `<div class="ark-tl-lane">${renderInline(lane || "—")}</div>`
          )
          .join("")
      : "";

  const rows = events
    .map(event => {
      const lane = lanes.indexOf(extString(event, "lane"));
      const kind = event.kind ?? "event";
      const mark = TIMELINE_MARK[kind];
      const cells = lanes
        .map((_, index) =>
          index === lane
            ? `<div class="ark-tl-cell ark-tl-on" ${idAttr(event.id)} data-kind="${escapeHtml(kind)}">` +
              `<span class="ark-tl-dot"></span><span class="ark-tl-what">` +
              (mark ? `<b class="ark-tl-mark">${mark}</b>` : "") +
              `${renderInline(event.label)}</span>${note(event, "ark-tl-note")}</div>`
            : `<div class="ark-tl-cell"></div>`
        )
        .join("");
      return (
        `<div class="ark-tl-at">${escapeHtml(extString(event, "at"))}</div>` +
        cells
      );
    })
    .join("");

  return (
    `<div class="ark-tl" style="grid-template-columns:max-content repeat(${columns},minmax(0,1fr))">` +
    head +
    rows +
    `</div>`
  );
}

// ===== tree =====

const TREE_BADGE: Readonly<Record<string, string>> = {
  added: "追加",
  removed: "削除",
  changed: "変更",
  kept: "維持",
};

function renderTree(model: DiagramModel): string {
  if (model.nodes.length === 0) {
    return `<p class="ark-fig-empty">項目がありません</p>`;
  }
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of model.edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)?.push(edge.to);
    hasParent.add(edge.to);
  }

  const rows: string[] = [];
  const seen = new Set<string>();
  // prefix は祖先それぞれが最後の子かどうかで決まる（│ を続けるか空けるか）
  const walk = (id: string, prefix: string, twig: string): void => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    const kind = node.kind ?? "node";
    const badge = TREE_BADGE[kind];
    const source = extString(node, "source");
    const label = renderInline(node.label);
    rows.push(
      `<li class="ark-tr-row" ${idAttr(node.id)} data-kind="${escapeHtml(kind)}">` +
        (twig
          ? `<span class="ark-tr-twig">${escapeHtml(prefix + twig)}</span>`
          : "") +
        `<span class="ark-tr-what">` +
        (isWorktreeSourceHref(source)
          ? `<a href="${escapeHtml(source)}">${label}</a>`
          : label) +
        `</span>` +
        (badge ? `<span class="ark-tr-badge">${badge}</span>` : "") +
        note(node, "ark-tr-note") +
        `</li>`
    );
    const kids = (children.get(id) ?? []).filter(kid => !seen.has(kid));
    const nextPrefix = twig ? prefix + (twig === "└─ " ? "   " : "│  ") : "";
    for (const [index, kid] of kids.entries()) {
      walk(kid, nextPrefix, index === kids.length - 1 ? "└─ " : "├─ ");
    }
  };
  for (const node of model.nodes) {
    if (!hasParent.has(node.id)) walk(node.id, "", "");
  }
  // 循環で根から辿れなかった項目も落とさない
  for (const node of model.nodes) walk(node.id, "", "");

  return `<ul class="ark-tr">${rows.join("")}</ul>`;
}

// ===== compare =====

function compareSides(nodes: DiagramNode[]): string[] {
  const sides: string[] = [];
  for (const node of nodes) {
    const side = extString(node, "side");
    if (side && !sides.includes(side)) sides.push(side);
  }
  return sides;
}

function sideOf(model: DiagramModel, id: string): string {
  const node = model.nodes.find(candidate => candidate.id === id);
  return node ? extString(node, "side") : "";
}

const COMPARE_KINDS = ["same", "changed", "added", "removed"] as const;

function renderCompare(model: DiagramModel): string {
  const sides = compareSides(model.nodes);
  if (sides.length !== 2) {
    return `<p class="ark-fig-empty">比べる 2 列がありません</p>`;
  }
  const [leftSide, rightSide] = sides;
  const left = model.nodes.filter(node => extString(node, "side") === leftSide);
  const right = model.nodes.filter(
    node => extString(node, "side") === rightSide
  );
  const pair = new Map<string, string>();
  for (const edge of model.edges) {
    pair.set(edge.from, edge.to);
    pair.set(edge.to, edge.from);
  }
  const byId = new Map(model.nodes.map(node => [node.id, node]));

  // 左の並びを軸に、対応の無い右の項目は、右の並びで直前の項目の後ろへ差し込む
  const rows: Array<[DiagramNode | null, DiagramNode | null]> = [];
  const emitted = new Set<string>();
  const flushRightBefore = (limit: number): void => {
    for (const [index, node] of right.entries()) {
      if (index >= limit) break;
      if (!emitted.has(node.id) && !pair.has(node.id)) {
        rows.push([null, node]);
        emitted.add(node.id);
      }
    }
  };
  for (const node of left) {
    const partner = byId.get(pair.get(node.id) ?? "");
    if (partner) {
      flushRightBefore(right.indexOf(partner));
      rows.push([node, partner]);
      emitted.add(partner.id);
    } else {
      rows.push([node, null]);
    }
  }
  flushRightBefore(right.length);

  const kindOf = (a: DiagramNode | null, b: DiagramNode | null): string => {
    const explicit = [b?.kind, a?.kind].find(kind =>
      (COMPARE_KINDS as readonly (string | undefined)[]).includes(kind)
    );
    if (explicit) return explicit;
    if (!a) return "added";
    if (!b) return "removed";
    return a.label === b.label ? "same" : "changed";
  };
  const cell = (node: DiagramNode | null): string =>
    node
      ? `<div class="ark-cmp-cell" ${idAttr(node.id)}>` +
        `<span class="ark-cmp-what">${renderInline(node.label)}</span>${note(node, "ark-cmp-note")}</div>`
      : `<div class="ark-cmp-cell ark-cmp-none"></div>`;

  const body = rows
    .map(([a, b]) => {
      const kind = kindOf(a, b);
      return (
        `<div class="ark-cmp-row" data-kind="${kind}">` +
        `${cell(a)}<span class="ark-cmp-arrow">${a && b ? "→" : ""}</span>${cell(b)}</div>`
      );
    })
    .join("");

  return (
    `<div class="ark-cmp">` +
    `<div class="ark-cmp-row ark-cmp-head"><div>${renderInline(leftSide)}</div><span></span>` +
    `<div>${renderInline(rightSide)}</div></div>` +
    body +
    `</div>`
  );
}

// ===== 共通 =====

const RENDERERS: Readonly<Record<FigureType, (model: DiagramModel) => string>> =
  {
    "git-graph": renderGitGraph,
    timeline: renderTimeline,
    tree: renderTree,
    compare: renderCompare,
  };

/**
 * 図 1 枚分（見出しと本体）を描く。包む `ark-bk-page` は呼び出し側が付ける
 * （デッキはページの要素に、単独の図は body の直下に置く）。
 */
export function renderFigure(type: FigureType, model: DiagramModel): string {
  return (
    `<div class="ark-bk ark-fig" data-ark-fig="${type}">` +
    (model.title
      ? `<h2 class="ark-bk-title">${renderInline(model.title)}</h2>`
      : "") +
    RENDERERS[type](model) +
    `</div>`
  );
}

/**
 * 図種の見た目。色の変数（`--ark-bk-*`）は部品のページと共有する
 * （DECK_BLOCKS_CSS が `body:has(.ark-bk-page)` に置く）。git-graph の列の色だけここで持つ。
 */
export const FIGURE_CSS = `
body:has(.ark-bk-page){--ark-git-0:oklch(0.55 0.15 262);--ark-git-1:oklch(0.55 0.14 150);
--ark-git-2:oklch(0.55 0.16 310);--ark-git-3:oklch(0.6 0.15 60);--ark-git-4:oklch(0.55 0.16 15);--ark-git-5:oklch(0.55 0.1 200)}
@media (prefers-color-scheme:dark){body:has(.ark-bk-page){--ark-git-0:oklch(0.74 0.13 262);--ark-git-1:oklch(0.76 0.14 150);
--ark-git-2:oklch(0.74 0.14 310);--ark-git-3:oklch(0.8 0.13 70);--ark-git-4:oklch(0.74 0.15 15);--ark-git-5:oklch(0.76 0.1 200)}}
.ark-fig-empty{margin:0;color:var(--ark-bk-mute);font-size:.86rem}
.ark-git-c0{--c:var(--ark-git-0)}.ark-git-c1{--c:var(--ark-git-1)}.ark-git-c2{--c:var(--ark-git-2)}
.ark-git-c3{--c:var(--ark-git-3)}.ark-git-c4{--c:var(--ark-git-4)}.ark-git-c5{--c:var(--ark-git-5)}
.ark-git-legend{display:flex;flex-wrap:wrap;gap:.4rem .9rem;margin:0 0 .5rem;font:600 .78rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.ark-git-lane{color:var(--c)}
.ark-git-lane::before{content:"";display:inline-block;width:.55rem;height:.55rem;margin-right:.35rem;border-radius:50%;background:var(--c)}
.ark-git-body{position:relative;min-width:0}
.ark-git-svg{position:absolute;left:0;top:0;overflow:visible}
.ark-git-svg path{fill:none;stroke:var(--c);stroke-width:2;stroke-linecap:round}
.ark-git-svg circle{fill:var(--c);stroke:var(--ark-bk-panel);stroke-width:2}
.ark-git-svg circle[data-merge]{fill:var(--ark-bk-panel);stroke:var(--c)}
.ark-git-svg circle[data-kind="added"]{r:6;stroke:var(--ark-bk-ok);stroke-width:2.5}
.ark-git-svg circle[data-kind="removed"]{fill:var(--ark-bk-panel);stroke:var(--c);stroke-dasharray:2 2}
.ark-git-rows{margin:0;padding:0 0 0 var(--ark-git-w);list-style:none}
.ark-git-row{display:flex;align-items:center;gap:.45rem;height:${GIT_ROW}px;padding-left:.35rem;white-space:nowrap;font-size:.88rem;overflow:hidden}
.ark-git-row+.ark-git-row{box-shadow:inset 0 1px 0 var(--ark-bk-edge)}
.ark-git-sha{flex:none;color:var(--ark-bk-mute);background:transparent!important;padding:0!important;font-size:.78rem!important}
.ark-git-ref{flex:0 1 auto;min-width:1.5em;overflow:hidden;text-overflow:ellipsis;padding:.05rem .5rem;border-radius:999px;background:var(--ark-bk-well);font:600 .74rem/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
/* 狭いペインでは補足から縮め、題名は 4 文字ぶんまで残す */
.ark-git-msg{flex:1 0 4em;min-width:4em;overflow:hidden;text-overflow:ellipsis}
.ark-git-note{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ark-bk-mute);font-size:.8rem}
.ark-git-row[data-kind="added"] .ark-git-msg{font-weight:650}
.ark-git-row[data-kind="added"]::after{content:"new";order:-1;flex:none;color:var(--ark-bk-ok);font:700 .68rem/1 ui-monospace,SFMono-Regular,Consolas,monospace}
.ark-git-row[data-kind="removed"]{opacity:.6}
.ark-git-row[data-kind="removed"] .ark-git-msg{text-decoration:line-through}
.ark-tl{display:grid;column-gap:.9rem;font-size:.9rem}
.ark-tl-lane{padding:0 0 .45rem;color:var(--ark-bk-mute);font-size:.8rem;font-weight:600}
.ark-tl-at{padding:.55rem 0;color:var(--ark-bk-mute);font:.78rem/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;text-align:right;white-space:nowrap}
.ark-tl-cell{position:relative;min-width:0;padding:.5rem 0 .5rem 1.4rem}
.ark-tl-cell::before{content:"";position:absolute;left:.42rem;top:0;bottom:0;width:2px;background:var(--ark-bk-well)}
.ark-tl-dot{position:absolute;left:.16rem;top:.85rem;width:.66rem;height:.66rem;border-radius:50%;background:var(--ark-bk-mute);box-shadow:0 0 0 3px var(--ark-bk-panel)}
.ark-tl-on[data-kind="ok"] .ark-tl-dot{background:var(--ark-bk-ok)}
.ark-tl-on[data-kind="ng"] .ark-tl-dot{background:var(--ark-bk-ng)}
.ark-tl-on[data-kind="warn"] .ark-tl-dot{background:var(--ark-bk-warn)}
.ark-tl-on[data-kind="milestone"] .ark-tl-dot{left:.08rem;top:.75rem;width:.82rem;height:.82rem;border-radius:2px;transform:rotate(45deg);background:var(--ark-bk-a)}
.ark-tl-what{display:block;line-height:1.45}
.ark-tl-on[data-kind="milestone"] .ark-tl-what{font-weight:650}
.ark-tl-mark{margin-right:.35rem}
.ark-tl-on[data-kind="ok"] .ark-tl-mark{color:var(--ark-bk-ok)}
.ark-tl-on[data-kind="ng"] .ark-tl-mark{color:var(--ark-bk-ng)}
.ark-tl-on[data-kind="warn"] .ark-tl-mark{color:var(--ark-bk-warn)}
.ark-tl-note{display:block;color:var(--ark-bk-mute);font-size:.82rem}
.ark-tr{margin:0;padding:0;list-style:none;font-size:.9rem}
.ark-tr-row{display:flex;align-items:baseline;gap:.5rem;padding:.16rem 0;line-height:1.55}
.ark-tr-twig{flex:none;color:var(--ark-bk-mute);white-space:pre;font:.86rem/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
.ark-tr-what{min-width:0;overflow-wrap:anywhere}
.ark-tr-badge{flex:none;padding:0 .45rem;border-radius:999px;font-size:.72rem;font-weight:650;background:var(--ark-bk-well)}
.ark-tr-row[data-kind="added"] .ark-tr-badge{color:var(--ark-bk-ok)}
.ark-tr-row[data-kind="removed"] .ark-tr-badge{color:var(--ark-bk-ng)}
.ark-tr-row[data-kind="changed"] .ark-tr-badge{color:var(--ark-bk-warn)}
.ark-tr-row[data-kind="kept"] .ark-tr-badge{color:var(--ark-bk-a)}
.ark-tr-row[data-kind="removed"] .ark-tr-what{color:var(--ark-bk-mute);text-decoration:line-through}
.ark-tr-note{color:var(--ark-bk-mute);font-size:.82rem}
.ark-cmp{display:grid;gap:.45rem;font-size:.9rem}
.ark-cmp-row{display:grid;grid-template-columns:minmax(0,1fr) 1.4rem minmax(0,1fr);align-items:stretch;gap:.4rem}
.ark-cmp-head{color:var(--ark-bk-mute);font-size:.8rem;font-weight:600}
.ark-cmp-arrow{align-self:center;text-align:center;color:var(--ark-bk-mute)}
.ark-cmp-cell{min-width:0;padding:.45rem .7rem;border-radius:9px;background:var(--ark-bk-well)}
.ark-cmp-none{background:transparent;box-shadow:inset 0 0 0 1px var(--ark-bk-edge)}
.ark-cmp-what{display:block;overflow-wrap:anywhere}
.ark-cmp-note{display:block;color:var(--ark-bk-mute);font-size:.82rem}
.ark-cmp-row[data-kind="same"] .ark-cmp-cell{color:var(--ark-bk-mute)}
.ark-cmp-row[data-kind="changed"] .ark-cmp-cell:not(.ark-cmp-none):last-child{box-shadow:inset 0 0 0 1.5px var(--ark-bk-warn)}
.ark-cmp-row[data-kind="added"] .ark-cmp-cell:not(.ark-cmp-none){box-shadow:inset 0 0 0 1.5px var(--ark-bk-ok)}
.ark-cmp-row[data-kind="removed"] .ark-cmp-cell:not(.ark-cmp-none){box-shadow:inset 0 0 0 1.5px var(--ark-bk-ng)}
.ark-cmp-row[data-kind="removed"] .ark-cmp-what{text-decoration:line-through}
`;

/** 単独の図（デッキでない）に投影を差し込む。対象外の図種はそのまま返す */
export function injectFigureProjection(
  html: string,
  model: DiagramModel
): string {
  if (!isFigureType(model.type)) return html;
  const projection =
    `<style data-ark-harness-ui="1">${STATIC_BASE_CSS}${DECK_BLOCKS_CSS}${FIGURE_CSS}</style>` +
    `<div class="ark-bk-page ark-fig-page" ${GENERATED_ATTR}="1">${renderFigure(model.type, model)}</div>`;
  const closing = html.toLowerCase().lastIndexOf("</body>");
  if (closing === -1) return html + projection;
  return html.slice(0, closing) + projection + html.slice(closing);
}
