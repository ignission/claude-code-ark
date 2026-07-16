/**
 * ボード（Excalidraw scene）の diff 抽出と Claude 向け自然文整形。
 *
 * 設計原則（spec: 2026-07-16-session-whiteboard-design.md）:
 * - 要素 id ベースで追加 / 変更 / 削除を検出する
 * - 座標の生値は出力しない（「〜の近く」の空間要約のみ）
 * - container に紐づく text 要素は container のラベルとして扱い、単独では列挙しない
 */

export interface BoardElementLike {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  containerId?: string | null;
  isDeleted?: boolean;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  groupIds?: string[];
}

/** ラベル付きの論理要素（bound text を container に吸収した後の単位） */
interface LogicalElement {
  id: string;
  type: string;
  cx: number;
  cy: number;
  label: string | null;
  startId: string | null;
  endId: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  arrow: "矢印",
  line: "線",
  text: "付箋",
  rectangle: "カード",
  ellipse: "図形",
  diamond: "図形",
  image: "画像",
  freedraw: "手描き",
};

/** 「近く」とみなす中心間距離の閾値 (px) */
const NEAR_THRESHOLD = 400;

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? "図形";
}

/** bound text を container に吸収し、論理要素の配列に変換する */
function toLogical(elements: BoardElementLike[]): LogicalElement[] {
  const alive = elements.filter(el => !el.isDeleted);
  const labelByContainer = new Map<string, string>();
  for (const el of alive) {
    if (el.type === "text" && el.containerId && el.text) {
      labelByContainer.set(el.containerId, el.text);
    }
  }
  const result: LogicalElement[] = [];
  for (const el of alive) {
    if (el.type === "text" && el.containerId) continue; // container 側で表現
    result.push({
      id: el.id,
      type: el.type,
      cx: el.x + el.width / 2,
      cy: el.y + el.height / 2,
      label: el.text ?? labelByContainer.get(el.id) ?? null,
      startId: el.startBinding?.elementId ?? null,
      endId: el.endBinding?.elementId ?? null,
    });
  }
  return result;
}

/** 要素の表示名: 種別「ラベル」または種別のみ */
function describe(
  el: LogicalElement,
  all: Map<string, LogicalElement>
): string {
  if (el.type === "arrow" || el.type === "line") {
    const from = el.startId ? all.get(el.startId)?.label : null;
    const to = el.endId ? all.get(el.endId)?.label : null;
    if (from && to) return `${typeLabel(el.type)}「${from}」→「${to}」`;
  }
  return el.label ? `${typeLabel(el.type)}「${el.label}」` : typeLabel(el.type);
}

/** 最も近いラベル付き要素を探す（閾値内のみ） */
function nearestLabel(
  el: LogicalElement,
  others: LogicalElement[]
): string | null {
  let best: { label: string; d: number } | null = null;
  for (const o of others) {
    if (o.id === el.id || !o.label) continue;
    const d = Math.hypot(o.cx - el.cx, o.cy - el.cy);
    if (d <= NEAR_THRESHOLD && (best === null || d < best.d)) {
      best = { label: o.label, d };
    }
  }
  return best?.label ?? null;
}

/**
 * 前回送信時と現在の scene 要素を比較し、Claude に送る diff テキストを生成する。
 * 変更がなければ空文字列を返す。
 */
export function buildBoardDiffText(
  prevElements: BoardElementLike[],
  nextElements: BoardElementLike[]
): string {
  const prev = toLogical(prevElements);
  const next = toLogical(nextElements);
  const prevById = new Map(prev.map(el => [el.id, el]));
  const nextById = new Map(next.map(el => [el.id, el]));

  const lines: string[] = [];

  for (const el of next) {
    const before = prevById.get(el.id);
    if (!before) {
      const near = nearestLabel(el, next);
      const suffix = near && near !== el.label ? `（「${near}」の近く）` : "";
      lines.push(`追加: ${describe(el, nextById)}${suffix}`);
    } else if (before.label !== el.label && el.label) {
      lines.push(
        `変更: ${typeLabel(el.type)}「${before.label ?? ""}」→「${el.label}」`
      );
    }
  }
  for (const el of prev) {
    if (!nextById.has(el.id)) {
      lines.push(`削除: ${describe(el, prevById)}`);
    }
  }

  if (lines.length === 0) return "";
  return `[ボード更新]\n${lines.join("\n")}`;
}
