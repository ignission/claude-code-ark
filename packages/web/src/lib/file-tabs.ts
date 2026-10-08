/**
 * 中ペイン (ファイルペイン) のタブ状態。端末ペインのタブ列 (ViewerTab) とは分離する。
 * タブの中身 (ファイル内容) は持たない。開いている場所だけを持つ純関数群。
 */

export interface FileTab {
  id: string;
  kind: "file" | "html";
  filePath: string;
  targetLine?: number | null;
  targetEndLine?: number | null;
  /** 行指定で開き直すたびに増える。エディタがスクロールし直す合図 */
  revealSeq: number;
}

export interface FileTabsState {
  tabs: FileTab[];
  activeId: string | null;
}

export const EMPTY_FILE_TABS: FileTabsState = { tabs: [], activeId: null };

/** 絶対パスの .html / .htm だけ iframe 表示 (html)。他は通常のファイル */
export function fileTabKind(filePath: string): "file" | "html" {
  return /\.html?$/i.test(filePath) && filePath.startsWith("/")
    ? "html"
    : "file";
}

export function openFileInTabs(
  state: FileTabsState,
  filePath: string,
  id: string,
  line?: number | null,
  endLine?: number | null
): FileTabsState {
  const index = state.tabs.findIndex(t => t.filePath === filePath);
  if (index >= 0) {
    const tabs = [...state.tabs];
    const tab = tabs[index];
    tabs[index] = {
      ...tab,
      targetLine: line,
      targetEndLine: endLine,
      revealSeq: tab.revealSeq + 1,
    };
    return { tabs, activeId: tab.id };
  }
  const tab: FileTab = {
    id,
    kind: fileTabKind(filePath),
    filePath,
    targetLine: line,
    targetEndLine: endLine,
    revealSeq: 0,
  };
  return { tabs: [...state.tabs, tab], activeId: id };
}

export function closeFileTab(state: FileTabsState, id: string): FileTabsState {
  const index = state.tabs.findIndex(t => t.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(t => t.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  // アクティブを閉じたら右隣、無ければ左隣
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeId: next?.id ?? null };
}

export function selectFileTab(state: FileTabsState, id: string): FileTabsState {
  if (state.activeId === id) return state;
  if (!state.tabs.some(t => t.id === id)) return state;
  return { ...state, activeId: id };
}

/**
 * 保存する形は { tabs: [{ kind, filePath }], activeFilePath }。
 * 行指定 (targetLine など) は保存も復元もしない
 */
export function serializeFileTabs(state: FileTabsState): string {
  const active = state.tabs.find(t => t.id === state.activeId);
  return JSON.stringify({
    tabs: state.tabs.map(t => ({ kind: t.kind, filePath: t.filePath })),
    activeFilePath: active?.filePath ?? null,
  });
}

/**
 * 壊れた入力は例外にせず EMPTY を返す。id は保存せず makeId で振り直す。
 * アクティブは activeFilePath で選び、一致しなければ先頭のタブにする
 */
export function deserializeFileTabs(
  raw: string | null,
  makeId: () => string
): FileTabsState {
  if (!raw) return EMPTY_FILE_TABS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_FILE_TABS;
    const { tabs: rawTabs, activeFilePath } = parsed as {
      tabs?: unknown;
      activeFilePath?: unknown;
    };
    if (!Array.isArray(rawTabs)) return EMPTY_FILE_TABS;
    const tabs: FileTab[] = [];
    for (const item of rawTabs) {
      if (!item || typeof item !== "object") continue;
      const { filePath } = item as Record<string, unknown>;
      if (typeof filePath !== "string" || !filePath) continue;
      tabs.push({
        id: makeId(),
        kind: fileTabKind(filePath),
        filePath,
        revealSeq: 0,
      });
    }
    if (tabs.length === 0) return EMPTY_FILE_TABS;
    const active = tabs.find(t => t.filePath === activeFilePath) ?? tabs[0];
    return { tabs, activeId: active.id };
  } catch {
    return EMPTY_FILE_TABS;
  }
}

/** 同じ worktree の複数セッションは 1 つのキーを共有する (最後に書いた方が勝つ) */
export function fileTabsStorageKey(worktreePath: string): string {
  return `ark-file-tabs:${worktreePath}`;
}
