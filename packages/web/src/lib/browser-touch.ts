/**
 * ブラウザ機能のタッチの番号づけ。
 *
 * サーバーへ送る点の番号は、0以上の小さい整数で、1メッセージに10個まで。DOMの
 * `Touch.identifier` は、ブラウザによっては大きい数や負の数になるので、そのままは送らない。
 * 触れている指ごとに、空いているいちばん小さい番号を割り当て、離すまで同じ番号を使う。
 * 11本目からの指は割り当てず、送らない。
 */

import type { BrowserTouchPoint } from "@ark/shared";

/** 1メッセージで送れる点の数の上限 */
export const MAX_TOUCH_POINTS = 10;

export interface TouchLike {
  identifier: number;
  clientX: number;
  clientY: number;
}

export class TouchIdMap {
  private readonly ids = new Map<number, number>();

  get size(): number {
    return this.ids.size;
  }

  get(identifier: number): number | undefined {
    return this.ids.get(identifier);
  }

  /** 割り当てた番号。もう割り当てていればその番号、上限に達していれば `null` */
  assign(identifier: number): number | null {
    const existing = this.ids.get(identifier);
    if (existing !== undefined) return existing;
    if (this.ids.size >= MAX_TOUCH_POINTS) return null;
    const used = new Set(this.ids.values());
    let id = 0;
    while (used.has(id)) id++;
    this.ids.set(identifier, id);
    return id;
  }

  /** 割り当てていた指なら `true` */
  release(identifier: number): boolean {
    return this.ids.delete(identifier);
  }

  clear(): void {
    this.ids.clear();
  }
}

/**
 * 触れている指のうち、番号を割り当て済みのものを、送る形にする。`toPoint` は
 * ビューポートの座標への換算で、換算できない指 (`null`) は入れない。
 */
export function touchPoints(
  touches: ArrayLike<TouchLike>,
  ids: TouchIdMap,
  toPoint: (touch: TouchLike) => { x: number; y: number } | null
): BrowserTouchPoint[] {
  const points: BrowserTouchPoint[] = [];
  for (let i = 0; i < touches.length; i++) {
    const touch = touches[i];
    const id = ids.get(touch.identifier);
    if (id === undefined) continue;
    const point = toPoint(touch);
    if (point) points.push({ id, x: point.x, y: point.y });
  }
  return points;
}
