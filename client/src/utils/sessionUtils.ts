import type { ManagedSession } from "../../../shared/types";
import { getBaseName, getParentPath } from "./pathUtils";

/**
 * セッションが指定されたリポジトリに属するかどうかを判定する
 */
export function isSessionBelongsToRepo(
  session: ManagedSession,
  repoPath: string
): boolean {
  const { worktreePath } = session;

  if (worktreePath === repoPath) return true;

  const repoParent = getParentPath(repoPath);
  const repoName = getBaseName(repoPath);
  const worktreeParent = getParentPath(worktreePath);
  const worktreeName = getBaseName(worktreePath);

  return (
    worktreeParent === repoParent && worktreeName.startsWith(`${repoName}-`)
  );
}

/**
 * セッションが属するリポジトリをrepoListから検索する
 */
export function findRepoForSession(
  session: ManagedSession,
  repoList: string[]
): string | null {
  for (const repo of repoList) {
    if (isSessionBelongsToRepo(session, repo)) {
      return repo;
    }
  }
  return null;
}
