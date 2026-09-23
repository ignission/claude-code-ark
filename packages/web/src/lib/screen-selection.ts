/**
 * Dashboard の selectedSessionId は「セッション id」「"browser"」「"screen:<id>"」を
 * 1 本の文字列で持つ。画面の番兵はここで作り、ここで読む
 */

const PREFIX = "screen:";

export function screenSelectionId(screenId: string): string {
  return `${PREFIX}${screenId}`;
}

/** "screen:<id>" なら id、それ以外は null */
export function parseScreenSelection(
  selectedSessionId: string | null
): string | null {
  return selectedSessionId?.startsWith(PREFIX)
    ? selectedSessionId.slice(PREFIX.length)
    : null;
}
