export const MOBILE_SESSION_VIEW_MODE_VALUES = [
  "chat",
  "terminal",
  "board",
] as const;

export type MobileSessionViewMode =
  (typeof MOBILE_SESSION_VIEW_MODE_VALUES)[number];

type MobileActiveTabType = "terminal" | "file" | "html" | "diagram";

interface ViewModeStorageReader {
  getItem(key: string): string | null;
}

interface ViewModeStorageWriter {
  setItem(key: string, value: string): void;
}

export const STORAGE_KEY_MOBILE_VIEW = "ark-mobile-session-view";

export function getViewModeForActiveTab(
  activeTabType: MobileActiveTabType | undefined
): MobileSessionViewMode | null {
  if (activeTabType === "diagram") return "board";
  if (activeTabType && activeTabType !== "terminal") return "terminal";
  return null;
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
