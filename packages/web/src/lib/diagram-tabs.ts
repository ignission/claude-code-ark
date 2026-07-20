/**
 * 図タブの追加・フォーカス（純関数）。
 * id を引数で受け取り、テスト可能な純関数として保つ。
 */
import type { ViewerTab } from "../components/TerminalPane";

export function addOrFocusDiagramTab(
  tabs: ViewerTab[],
  worktreePath: string,
  relPath: string,
  id: string
): { tabs: ViewerTab[]; activeIndex: number } {
  const existing = tabs.findIndex(
    t =>
      t.type === "diagram" &&
      t.worktreePath === worktreePath &&
      t.relPath === relPath
  );
  if (existing >= 0) return { tabs, activeIndex: existing };

  const next: ViewerTab[] = [
    ...tabs,
    { type: "diagram", id, worktreePath, relPath },
  ];
  return { tabs: next, activeIndex: next.length - 1 };
}
