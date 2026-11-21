/**
 * ホーム: 仕事の入口にする 1 本のセッション。
 *
 * リポジトリごとのセッションを渡り歩く代わりに、ホームに頼み、ホームが task_start で
 * 各リポジトリへ子タスクを切り出す。画面はそれに合わせて組み替える。
 *
 * - ホームは worktree のパスで指す (設定 `homeWorktreePath`、サーバーに保存)。セッションの ID は
 *   再起動で替わるので使わない。行のメニューの「ホームにする」で決め、ホームの行のメニューで外す
 * - ホームを決めている間、PC は会話を左、タスクの一覧を右に置く。ホームは一覧の行から外し、
 *   一覧の先頭に固定の行で出す。開いたセッションのタブは出さない (行き来はホームと一覧で足りる)。
 *   タスクを開いている間は、会話の上に「ホームへ戻る」を出す
 * - Ark を開いたときはホームの会話から始める (前回選んでいたセッションは復元しない)
 * - ホームのセッションが無ければ起動する。開いて最初の 1 回だけで、人が止めたあとは起こし直さない
 * - ホームを決めていなければ、画面は今までどおり
 *
 * Ark がホームのセッションへ何かを注入することはない。ホームが何をするかは、
 * そのディレクトリの CLAUDE.md と .claude/ が決める。
 */

import type { ManagedSession, Worktree } from "@ark/shared";

export const HOME_WORKTREE_SETTING = "homeWorktreePath";

/** 設定から読んだ値を、パスか null に揃える (壊れた値は null) */
export function normalizeHomeWorktreePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function findHomeSession(
  sessions: Iterable<ManagedSession>,
  homeWorktreePath: string | null
): ManagedSession | null {
  if (!homeWorktreePath) return null;
  for (const session of sessions) {
    if (session.worktreePath === homeWorktreePath) return session;
  }
  return null;
}

export function findHomeWorktree(
  worktrees: readonly Worktree[],
  homeWorktreePath: string | null
): Worktree | null {
  if (!homeWorktreePath) return null;
  return worktrees.find(w => w.path === homeWorktreePath) ?? null;
}
