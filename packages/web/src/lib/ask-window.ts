/** 「聞く」のウィンドウの位置 (左上の座標)。画面の外へ出さない */

export interface AskWindowPosition {
  x: number;
  y: number;
}

export const ASK_WINDOW_WIDTH = 460;
export const ASK_WINDOW_HEIGHT = 560;
/** 画面の端とのすき間 */
const MARGIN = 12;
/** 縦は、少なくとも見出しのぶんを画面に残す */
const HEADER_HEIGHT = 44;

const STORAGE_KEY = "ark-ask-window-position";

export function clampAskWindowPosition(
  position: AskWindowPosition,
  viewport: { width: number; height: number }
): AskWindowPosition {
  const maxX = Math.max(MARGIN, viewport.width - ASK_WINDOW_WIDTH - MARGIN);
  const maxY = Math.max(MARGIN, viewport.height - HEADER_HEIGHT - MARGIN);
  return {
    x: Math.min(maxX, Math.max(MARGIN, position.x)),
    y: Math.min(maxY, Math.max(MARGIN, position.y)),
  };
}

/** 既定の位置は右下 */
export function defaultAskWindowPosition(viewport: {
  width: number;
  height: number;
}): AskWindowPosition {
  return clampAskWindowPosition(
    {
      x: viewport.width - ASK_WINDOW_WIDTH - 24,
      y:
        viewport.height -
        Math.min(ASK_WINDOW_HEIGHT, viewport.height * 0.7) -
        24,
    },
    viewport
  );
}

export function loadAskWindowPosition(): AskWindowPosition | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AskWindowPosition> | null;
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
      return null;
    }
    return { x: value.x as number, y: value.y as number };
  } catch {
    return null;
  }
}

export function saveAskWindowPosition(position: AskWindowPosition): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
  } catch {
    // 保存できなくても、位置はこの画面の間は保つ
  }
}
