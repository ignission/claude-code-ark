/**
 * モバイルのセッション画面の表示モードと、その保存。
 *
 * モードは「会話 / 図 / TODO」の3つ。端末はモードではなく、会話の帯から開く窓で見せる
 * (開閉は保存しない)。以前の「端末」モードの保存値は、不正値と同じく会話として読む。
 */

export const MOBILE_SESSION_VIEW_MODE_VALUES = [
  "chat",
  "board",
  "todo",
] as const;

export type MobileSessionViewMode =
  (typeof MOBILE_SESSION_VIEW_MODE_VALUES)[number];

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
 * ファイル / HTMLを開く操作があったので、端末の窓を開く必要があるか。
 * ビューアは端末と同じタブの並びに属し、窓の中に出る。開く操作の通し番号が、
 * 前に見た値より増えたときだけ開く (同じファイルの開き直しでも番号は進む)
 */
export function shouldOpenTerminalForViewerOpen(
  seenOpenSeq: number,
  openSeq: number
): boolean {
  return openSeq > seenOpenSeq;
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
