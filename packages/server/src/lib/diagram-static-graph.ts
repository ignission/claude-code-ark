/**
 * デッキのページに置く flow / state（動かさない graph）。
 *
 * ## なぜ要るか
 *
 * flow と state は単独の図では編集ハーネスに載り、node をドラッグした座標を
 * 一番上のモデルへ書き戻す。デッキは 1 ファイルに複数のページを持つので、その書き戻し
 * 先が無く、これまではページにできなかった。その結果、処理の分岐も状態の移り変わりも
 * 部品のページ（文字の矢印）で書かれていた。
 *
 * ページの上では座標を持たせず、自動レイアウト（diagram-layout.ts の `layoutDiagram`。
 * DOM に依存しない）をサーバーで回して、動かない図として描く。ドラッグして直したい図は、
 * 今までどおり単独のファイルに描く。
 *
 * ## 語彙
 *
 * 単独の flow / state と同じ node / edge / kind を使う。ページには group を置けない
 * （ページの定義に groups が無い）。向きは上から下に固定する（狭いペインで横に溢れない）。
 */

import { renderInline } from "./diagram-deck-blocks.js";
import { layoutDiagram } from "./diagram-layout.js";
import type { DiagramModel, DiagramNode } from "./diagram-model.js";

export const STATIC_GRAPH_PAGE_TYPES = ["flow", "state"] as const;
export type StaticGraphPageType = (typeof STATIC_GRAPH_PAGE_TYPES)[number];

export function isStaticGraphPageType(
  type: unknown
): type is StaticGraphPageType {
  return (STATIC_GRAPH_PAGE_TYPES as readonly unknown[]).includes(type);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** kind の札（既定の kind には付けない）と色 */
const KIND_TAG: Readonly<Record<string, { tag: string; tone?: string }>> = {
  command: { tag: "コマンド", tone: "a" },
  decision: { tag: "分岐", tone: "warn" },
  policy: { tag: "ポリシー" },
  event: { tag: "イベント", tone: "a" },
  outcome: { tag: "成功", tone: "ok" },
  error: { tag: "失敗", tone: "ng" },
  actor: { tag: "アクター" },
  note: { tag: "メモ" },
  initial: { tag: "開始", tone: "a" },
  "terminal-ok": { tag: "完了", tone: "ok" },
  "terminal-cancel": { tag: "中止", tone: "ng" },
};

const NODE_WIDTH = 168;
const INNER_WIDTH = NODE_WIDTH - 22;
const LINE_HEIGHT = 18;
const MAX_LINES = 4;

/** 描く前に高さを決める必要があるので、文字幅から行数を見積もる（全角 13px・半角 7.4px） */
function estimateLines(text: string): number {
  let width = 0;
  for (const char of text) {
    width += (char.codePointAt(0) ?? 0) <= 0xff ? 7.4 : 13;
  }
  return Math.min(MAX_LINES, Math.max(1, Math.ceil(width / INNER_WIDTH)));
}

function nodeText(node: DiagramNode): string {
  return node.kind === "note" ? (node.noteText ?? node.label) : node.label;
}

function nodeHeight(node: DiagramNode): number {
  const tag = node.kind && KIND_TAG[node.kind] ? 14 : 0;
  return 16 + tag + estimateLines(nodeText(node)) * LINE_HEIGHT;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 箱の中心から点 (tx, ty) へ向かう線が、箱の縁と交わる点 */
function borderPoint(box: Box, tx: number, ty: number): [number, number] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const scale = Math.min(
    dx === 0 ? Infinity : box.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.height / 2 / Math.abs(dy)
  );
  return [cx + dx * scale, cy + dy * scale];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 線分 (x1, y1)-(x2, y2) が箱を通るか（縁を少し内側に寄せて、接するだけの箱は数えない） */
function crosses(
  box: Box,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  const left = box.x + 2;
  const right = box.x + box.width - 2;
  const top = box.y + 2;
  const bottom = box.y + box.height - 2;
  for (let step = 1; step < 24; step++) {
    const t = step / 24;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    if (x > left && x < right && y > top && y < bottom) return true;
  }
  return false;
}

/** 矢じり（終点 (x, y) に、angle の向きで置く三角形） */
function arrowHead(x: number, y: number, angle: number): string {
  const wing = (offset: number): string =>
    `${round(x - 9 * Math.cos(angle + offset))},${round(y - 9 * Math.sin(angle + offset))}`;
  return `<polygon points="${round(x)},${round(y)} ${wing(0.42)} ${wing(-0.42)}"></polygon>`;
}

/** flow / state のページ 1 枚分（見出しと図）を描く */
export function renderStaticGraph(
  type: StaticGraphPageType,
  model: DiagramModel
): string {
  const title = model.title
    ? `<h2 class="ark-bk-title">${renderInline(model.title)}</h2>`
    : "";
  if (model.nodes.length === 0) {
    return `<div class="ark-bk ark-fig" data-ark-fig="${type}">${title}<p class="ark-fig-empty">node がありません</p></div>`;
  }

  const heights = new Map(model.nodes.map(node => [node.id, nodeHeight(node)]));
  const layout = layoutDiagram({
    nodes: model.nodes.map((node, index) => ({
      id: node.id,
      index,
      width: NODE_WIDTH,
      height: heights.get(node.id) ?? LINE_HEIGHT,
    })),
    edges: model.edges.map(edge => ({ from: edge.from, to: edge.to })),
    groups: [],
    direction: "TB",
    rankSpacing: 60,
    nodeSpacing: 28,
    padding: 12,
  });

  const boxes = new Map<string, Box>();
  for (const node of model.nodes) {
    const position = layout.positions[node.id] ?? { x: 0, y: 0 };
    boxes.set(node.id, {
      x: position.x,
      y: position.y,
      width: NODE_WIDTH,
      height: heights.get(node.id) ?? LINE_HEIGHT,
    });
  }
  let width = 0;
  let height = 0;
  for (const box of boxes.values()) {
    width = Math.max(width, box.x + box.width + 12);
    height = Math.max(height, box.y + box.height + 12);
  }

  const lines: string[] = [];
  const labels: string[] = [];
  for (const edge of model.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;
    if (edge.from === edge.to) {
      // 自分へ戻る遷移は右の縁に小さな輪を描く
      const x = from.x + from.width;
      const y = from.y + from.height / 2;
      lines.push(
        `<path d="M ${x} ${y - 6} c 22 -14, 22 26, 0 12"></path>` +
          `<polygon points="${x},${y + 6} ${x + 7},${y + 2} ${x + 6},${y + 10}"></polygon>`
      );
      if (edge.label) {
        labels.push(
          `<text x="${x + 22}" y="${y + 4}">${escapeHtml(edge.label)}</text>`
        );
      }
      continue;
    }
    const [x1, y1] = borderPoint(
      from,
      to.x + to.width / 2,
      to.y + to.height / 2
    );
    const [x2, y2] = borderPoint(
      to,
      from.x + from.width / 2,
      from.y + from.height / 2
    );
    // ランクを飛び越す線が間の箱を通るときは、箱の右へ回す（裏を通ると線もラベルも隠れる）
    const blockers = [...boxes.entries()]
      .filter(
        ([id, box]) =>
          id !== edge.from && id !== edge.to && crosses(box, x1, y1, x2, y2)
      )
      .map(([, box]) => box);
    if (blockers.length > 0) {
      const sx = from.x + from.width;
      const sy = from.y + from.height / 2;
      const ex = to.x + to.width;
      const ey = to.y + to.height / 2;
      const bx =
        Math.max(sx, ex, ...blockers.map(box => box.x + box.width)) + 28;
      width = Math.max(width, bx + 12);
      lines.push(
        `<path d="M ${sx} ${sy} C ${bx} ${sy}, ${bx} ${ey}, ${ex} ${ey}"></path>` +
          arrowHead(ex, ey, Math.PI)
      );
      if (edge.label) {
        labels.push(
          `<text x="${round(bx - 6)}" y="${round((sy + ey) / 2 + 4)}" text-anchor="middle">${escapeHtml(edge.label)}</text>`
        );
      }
      continue;
    }
    // 矢じりは線の終点に、線の向きへ回した三角形で描く（marker の id をページ間で
    // 一意にする手間を避ける）
    lines.push(
      `<path d="M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}"></path>` +
        arrowHead(x2, y2, Math.atan2(y2 - y1, x2 - x1))
    );
    if (edge.label) {
      labels.push(
        `<text x="${round((x1 + x2) / 2)}" y="${round((y1 + y2) / 2 + 4)}" text-anchor="middle">${escapeHtml(edge.label)}</text>`
      );
    }
  }

  const nodes = model.nodes
    .map(node => {
      const box = boxes.get(node.id);
      if (!box) return "";
      const kind = node.kind ?? "";
      const meta = KIND_TAG[kind];
      return (
        `<div class="ark-sg-node" data-ark-id="${escapeHtml(node.id)}"` +
        (kind ? ` data-kind="${escapeHtml(kind)}"` : "") +
        (meta?.tone ? ` data-tone="${meta.tone}"` : "") +
        ` style="left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px">` +
        (meta ? `<span class="ark-sg-tag">${meta.tag}</span>` : "") +
        `<span class="ark-sg-label">${renderInline(nodeText(node))}</span></div>`
      );
    })
    .join("");

  return (
    `<div class="ark-bk ark-fig" data-ark-fig="${type}">${title}` +
    `<div class="ark-sg" style="width:${width}px;height:${height}px">` +
    `<svg class="ark-sg-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">` +
    `${lines.join("")}${labels.join("")}</svg>${nodes}</div></div>`
  );
}

export const STATIC_GRAPH_CSS = `
.ark-sg{position:relative;max-width:none}
.ark-sg-svg{position:absolute;left:0;top:0;overflow:visible}
.ark-sg-svg path{fill:none;stroke:var(--ark-bk-mute);stroke-width:1.5}
.ark-sg-svg polygon{fill:var(--ark-bk-mute)}
.ark-sg-svg text{fill:var(--ark-bk-ink);font-size:11.5px;paint-order:stroke;stroke:var(--ark-bk-panel);stroke-width:4px;stroke-linejoin:round}
.ark-sg-node{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;
padding:.35rem .65rem;border-radius:10px;background:var(--ark-bk-well);font-size:13px;line-height:${LINE_HEIGHT}px;overflow:hidden}
.ark-sg-node[data-tone]{box-shadow:inset 0 0 0 1.5px var(--ark-sg-tone)}
.ark-sg-node[data-tone="a"]{--ark-sg-tone:var(--ark-bk-a)}.ark-sg-node[data-tone="ok"]{--ark-sg-tone:var(--ark-bk-ok)}
.ark-sg-node[data-tone="ng"]{--ark-sg-tone:var(--ark-bk-ng)}.ark-sg-node[data-tone="warn"]{--ark-sg-tone:var(--ark-bk-warn)}
.ark-sg-node[data-kind="note"]{background:transparent;box-shadow:inset 0 0 0 1px var(--ark-bk-edge);color:var(--ark-bk-mute)}
.ark-sg-node[data-kind="decision"]{border-radius:3px}
.ark-sg-node[data-kind="initial"],.ark-sg-node[data-kind^="terminal"]{border-radius:999px;text-align:center}
.ark-sg-tag{font-size:10px;line-height:14px;font-weight:650;color:var(--ark-sg-tone,var(--ark-bk-mute))}
.ark-sg-label{overflow-wrap:anywhere}
`;
