/**
 * task_start の repo で別のリポジトリへ切り出した子を、一覧に出すための補い。
 *
 * 一覧は、画面に登録したリポジトリ (repoList) のセッションだけを出す。子のリポジトリが
 * 未登録だと、親が起こした子がどこにも出ない。そこで、親を持つセッション
 * (parentWorktreePath がある行) のリポジトリを repoList に足す。
 *
 * イベントで足さずにセッションの一覧から導くのは、起こした瞬間につないでいなかった画面
 * (リロード後、後から開いたモバイル) でも同じ結果にするため。
 * 子のセッションが残っている間は、そのリポジトリを一覧から外しても足し直される。
 */

import type { ManagedSession } from "@ark/shared";

/** repoList に無い、子のセッションのリポジトリ (重複なし、パスの昇順) */
export function missingChildTaskRepos(
  sessions: Iterable<ManagedSession>,
  repoList: readonly string[]
): string[] {
  const missing = new Set<string>();
  for (const session of sessions) {
    if (!session.parentWorktreePath || !session.repoPath) continue;
    if (!repoList.includes(session.repoPath)) missing.add(session.repoPath);
  }
  return Array.from(missing).sort((a, b) => a.localeCompare(b));
}
