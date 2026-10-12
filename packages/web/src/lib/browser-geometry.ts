/**
 * ブラウザ機能の寸法と座標の計算。DOMに触れない。
 *
 * 登場する座標は3つ。ビューポートの座標 (サーバーのChromiumのCSSピクセル)、canvasの
 * 表示上の矩形、canvasを置く領域 (ペインからツールバーを除いた部分)。canvasはビューポートを
 * 映すので、ビューポートの座標とcanvas上の位置は、両者の寸法の比で行き来できる。
 *
 * ビューポートは視聴者の全員が共有する1つで、このペインの領域と寸法が違うことがある。
 * そのときは、canvasを引き伸ばさず、縦横比を保って領域に収まる最大の寸法で中央に置く
 * (`letterboxRect`)。余白は領域の背景のまま残す。寸法が同じとき (ふつうはこちら) と、
 * 縦横比が同じときは、canvasは領域の全体を使う。
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 左上の位置と寸法。`DOMRect` をそのまま渡せる */
export interface Box extends Size {
  left: number;
  top: number;
}

export interface LetterboxRect extends Box {
  /** 領域の全体を使うなら `true` (余白が無い) */
  fill: boolean;
}

/** 選択リストの高さの上限 (px)。超える分はリストの中でスクロールする */
export const SELECT_LIST_MAX_HEIGHT = 320;
/** `<select>` と選択リストの間隔 (px) */
export const SELECT_LIST_GAP = 2;
/** 選択リストの行、見出し、上下の余白の高さ (px)。CSSの高さと合わせる */
export const SELECT_OPTION_HEIGHT = 28;
export const SELECT_GROUP_HEIGHT = 22;
export const SELECT_LIST_PADDING = 8;
/** 選択リストに最低限見せる行の数 */
export const SELECT_LIST_MIN_ROWS = 3;
/** 選択リストの高さの下限 (px)。中身か領域がこれより低ければ、そちらに合わせる */
export const SELECT_LIST_MIN_HEIGHT =
  SELECT_LIST_MIN_ROWS * SELECT_OPTION_HEIGHT + SELECT_LIST_PADDING;
/**
 * 余白とみなさない寸法の差 (px)。ビューポートの寸法は整数に丸めてあるので、領域の端数の
 * 分だけ縦横比がずれる。1px未満の隙間は作らない
 */
const FILL_TOLERANCE = 1;

/**
 * 領域の中でcanvasを置く矩形 (領域の左上から測る)。ビューポートを知らないときと、
 * 領域が見えていないときは、領域の全体を返す。
 */
export function letterboxRect(
  area: Size,
  viewport: Size | null
): LetterboxRect {
  const full = { left: 0, top: 0, width: area.width, height: area.height };
  if (
    !viewport ||
    !(area.width > 0 && area.height > 0) ||
    !(viewport.width > 0 && viewport.height > 0)
  ) {
    return { ...full, fill: true };
  }
  const ratio = Math.min(
    area.width / viewport.width,
    area.height / viewport.height
  );
  const width = viewport.width * ratio;
  const height = viewport.height * ratio;
  if (
    area.width - width < FILL_TOLERANCE &&
    area.height - height < FILL_TOLERANCE
  ) {
    return { ...full, fill: true };
  }
  return {
    left: (area.width - width) / 2,
    top: (area.height - height) / 2,
    width,
    height,
    fill: false,
  };
}

/**
 * canvasの左上から測った位置を、ビューポートの座標へ直す。
 * ビューポートの寸法をまだ知らないか、canvasが見えていなければ `null`。
 */
export function screenToViewport(
  point: Point,
  canvas: Size,
  viewport: Size | null
): Point | null {
  if (!viewport || canvas.width <= 0 || canvas.height <= 0) return null;
  return {
    x: (point.x * viewport.width) / canvas.width,
    y: (point.y * viewport.height) / canvas.height,
  };
}

/**
 * ビューポートの座標の矩形を、表示上の矩形へ直す (`screenToViewport` の逆)。
 * 返す位置は `canvas` の `left` / `top` と同じ原点から測る。ビューポートの寸法を
 * 知らなければ、倍率1として扱う。
 */
export function viewportToScreen(
  rect: Point & Size,
  canvas: Box,
  viewport: Size | null
): Box {
  const scaleX =
    viewport && viewport.width > 0 ? canvas.width / viewport.width : 1;
  const scaleY =
    viewport && viewport.height > 0 ? canvas.height / viewport.height : 1;
  return {
    left: canvas.left + rect.x * scaleX,
    top: canvas.top + rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

export function containsPoint(rect: Box, x: number, y: number): boolean {
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  );
}

export interface SelectListPlacement {
  left: number;
  /** 下に出すときだけ。領域の上端から測る */
  top?: number;
  /** 上に出すときだけ。領域の下端から測る */
  bottom?: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 選択リストを置く場所。`anchor` は `<select>` の表示上の矩形で、領域の左上から測る。
 * `contentHeight` はリストの中身の高さ。
 *
 * ふつうは `<select>` のすぐ下に出す。下に収まらず、上のほうが広ければ上に出す。
 * どちらにも収まらなければ、広いほうに出して高さを空きに合わせる。
 *
 * 広いほうにも最小の高さ (`SELECT_LIST_MIN_HEIGHT`) が無ければ、`<select>` に重ねてでも、
 * 領域の中に最小の高さで出す。高さが0のリストは、見えないのに入力を止めてしまう。
 * `<select>` が領域の外にあるとき (スクロールで外れた、寸法が変わった) も、領域の端に
 * 寄せて同じ決まりで置く。
 *
 * 幅の上限は、置いた位置から領域の右端まで。領域の幅のままにすると、右端の近くで
 * 開いたリストが領域の外へはみ出して切れる。
 */
export function placeSelectList(
  anchor: Box,
  area: Size,
  contentHeight: number
): SelectListPlacement {
  const minWidth = Math.max(0, Math.min(anchor.width, area.width));
  const left = clamp(anchor.left, 0, area.width - minWidth);
  const horizontal = {
    left,
    minWidth,
    maxWidth: Math.max(0, area.width - left),
  };

  const wanted = Math.min(contentHeight, SELECT_LIST_MAX_HEIGHT);
  const minHeight = Math.min(wanted, SELECT_LIST_MIN_HEIGHT, area.height);
  const anchorTop = clamp(anchor.top, 0, area.height);
  const anchorBottom = clamp(anchor.top + anchor.height, 0, area.height);
  const top = anchorBottom + SELECT_LIST_GAP;
  const below = area.height - top;
  const above = anchorTop - SELECT_LIST_GAP;
  const placeBelow = wanted <= below || below >= above;
  if (placeBelow && below >= minHeight) {
    return {
      ...horizontal,
      top,
      maxHeight: Math.min(SELECT_LIST_MAX_HEIGHT, below),
    };
  }
  if (!placeBelow && above >= minHeight) {
    return {
      ...horizontal,
      bottom: area.height - anchorTop + SELECT_LIST_GAP,
      maxHeight: Math.min(SELECT_LIST_MAX_HEIGHT, above),
    };
  }
  const overlapTop = clamp(top, 0, area.height - minHeight);
  return {
    ...horizontal,
    top: overlapTop,
    maxHeight: Math.max(
      0,
      Math.min(SELECT_LIST_MAX_HEIGHT, area.height - overlapTop)
    ),
  };
}
