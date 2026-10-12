/**
 * モバイルのセッション画面の表示モードと、その保存。
 *
 * モードは「会話 / 図」の2つ。端末はモードではなく、会話の帯から開く窓で見せる
 * (開閉は保存しない)。以前の「端末」モードの保存値は、不正値と同じく会話として読む。
 */

export const MOBILE_SESSION_VIEW_MODE_VALUES = ["chat", "board"] as const;

export type MobileSessionViewMode =
  (typeof MOBILE_SESSION_VIEW_MODE_VALUES)[number];

type MobileActiveTabType = "terminal" | "file" | "html" | "diagram";

export interface DiagramOpenRequest {
  sessionId: string;
  relPath: string;
  sequence: number;
}

interface ViewModeStorageReader {
  getItem(key: string): string | null;
}

interface ViewModeStorageWriter {
  setItem(key: string, value: string): void;
}

export const STORAGE_KEY_MOBILE_VIEW = "ark-mobile-session-view";

export function createDiagramOpenRequest(
  previous: DiagramOpenRequest | null,
  sessionId: string,
  relPath: string
): DiagramOpenRequest {
  return {
    sessionId,
    relPath,
    sequence: (previous?.sequence ?? 0) + 1,
  };
}

export function getViewModeForDiagramOpenRequest(
  sessionId: string,
  request: DiagramOpenRequest | null,
  handledSequence: number | null
): MobileSessionViewMode | null {
  if (
    request &&
    request.sessionId === sessionId &&
    request.sequence !== handledSequence
  ) {
    return "board";
  }
  return null;
}

/**
 * 選ばれたビューワータブを見せるために、端末の窓を開く必要があるか。
 * ファイルとHTMLのビューアは端末と同じタブの並びに属し、窓の中に出る
 */
export function shouldOpenTerminalForViewerTab(
  activeTabType: MobileActiveTabType | undefined
): boolean {
  return activeTabType === "file" || activeTabType === "html";
}

export function normalizeMobileSessionViewMode(
  value: unknown
): MobileSessionViewMode {
  return MOBILE_SESSION_VIEW_MODE_VALUES.includes(
    value as MobileSessionViewMode
  )
    ? (value as MobileSessionViewMode)
    : "chat";
}

export function readSavedViewMode(
  storage?: ViewModeStorageReader
): MobileSessionViewMode {
  try {
    const source = storage ?? window.localStorage;
    return normalizeMobileSessionViewMode(
      source.getItem(STORAGE_KEY_MOBILE_VIEW)
    );
  } catch {
    return "chat";
  }
}

export function writeSavedViewMode(
  mode: MobileSessionViewMode,
  storage?: ViewModeStorageWriter
): void {
  try {
    const target = storage ?? window.localStorage;
    target.setItem(STORAGE_KEY_MOBILE_VIEW, mode);
  } catch {
    // Storage unavailable (SSR / private mode / quota) must not break navigation.
  }
}
