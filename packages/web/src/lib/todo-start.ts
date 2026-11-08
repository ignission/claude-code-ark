/**
 * 分岐TODOから会話を始めるときに、Dashboard が使う純粋な判定。
 * - 元のworktreeのリポジトリとブランチ (新しいタスクのダイアログの初期値)
 * - worktreeのパスからセッションを引く (セッションが現れたら選ぶ待ちに使う)
 */

import type { ManagedSession, Worktree } from "@ark/shared";
import { isPathWithin } from "@/utils/pathUtils";
import { isSessionBelongsToRepo } from "@/utils/sessionUtils";

export function findSessionIdByWorktreePath(
  sessions: Iterable<ManagedSession>,
  worktreePath: string
): string | null {
  for (const session of sessions) {
    if (session.worktreePath === worktreePath) return session.id;
  }
  return null;
}

export interface TodoOrigin {
  repoPath: string;
  /** worktreeの一覧に無ければ分からない (ダイアログの基点は空のまま) */
  branch: string | undefined;
}

/**
 * TODOの元のworktreeのリポジトリとブランチ。リポジトリはセッションの repoPath を先に見て、
 * 無ければ repoList から探す (中にある worktree、または兄弟ディレクトリの `<repo>-*`)。
 * worktreeを消した (セッションも一覧も無い) か、リポジトリが分からなければ null
 */
export function resolveTodoOrigin(
  worktreePath: string,
  sessions: Iterable<ManagedSession>,
  worktrees: readonly Pick<Worktree, "path" | "branch">[],
  repoList: readonly string[]
): TodoOrigin | null {
  let session: ManagedSession | undefined;
  for (const item of sessions) {
    if (item.worktreePath === worktreePath) {
      session = item;
      break;
    }
  }
  const worktree = worktrees.find(item => item.path === worktreePath);
  if (!session && !worktree) return null;
  const repoPath =
    session?.repoPath ??
    repoList.find(
      repo =>
        isPathWithin(worktreePath, repo) ||
        isSessionBelongsToRepo({ worktreePath }, repo)
    );
  if (!repoPath) return null;
  return { repoPath, branch: worktree?.branch };
}
