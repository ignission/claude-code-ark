/**
 * 図タブの追加・フォーカス（純関数）。
 * id を引数で受け取り、テスト可能な純関数として保つ。
 */
import type { ViewerTab } from "../components/TerminalPane";

/**
 * 図タブを追加した（または既存を再利用した）後の tabs 配列を返す。
 *
 * diagram タブは右ペイン専属でタブバー上の active 概念を持たないため、
 * 呼び出し側は追加後の active index を必要としない（openDiagramTab は
 * setSessionActiveTab を呼ばない）。そのため配列だけを返す。
 */
export function addOrFocusDiagramTab(
  tabs: ViewerTab[],
  worktreePath: string,
  relPath: string,
  id: string,
  restoredOnLoad?: boolean
): ViewerTab[] {
  const existing = tabs.some(
    t =>
      t.type === "diagram" &&
      t.worktreePath === worktreePath &&
      t.relPath === relPath
  );
  // 既存タブがあればそのまま返す。restoredOnLoad タグは最初に追加された時点の
  // ものを維持する（後から同じ図を live open しても付け替えない）。
  if (existing) return tabs;

  return [
    ...tabs,
    { type: "diagram", id, worktreePath, relPath, restoredOnLoad },
  ];
}
