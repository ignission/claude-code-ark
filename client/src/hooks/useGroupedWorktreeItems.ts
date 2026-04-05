/**
 * useGroupedWorktreeItems - worktreeをリポジトリ別にグルーピングするカスタムフック
 *
 * SessionSidebarとMobileSessionListで共通のグルーピングロジックを提供する。
 */

import { useMemo } from "react";
import { getBaseName } from "@/utils/pathUtils";
import { findRepoForSession } from "@/utils/sessionUtils";
import type { ManagedSession, Worktree } from "../../../shared/types";

export type GroupedItem = {
  worktree: Worktree | null;
  session: ManagedSession | null;
};

export function useGroupedWorktreeItems(
  worktrees: Worktree[],
  sessions: Map<string, ManagedSession>,
  repoList: string[]
) {
  const sessionByWorktreeId = useMemo(() => {
    const map = new Map<string, ManagedSession>();
    sessions.forEach(session => {
      map.set(session.worktreeId, session);
    });
    return map;
  }, [sessions]);

  const groupedItems = useMemo(() => {
    const groups = new Map<string, GroupedItem[]>();
    const worktreeSessionIds = new Set<string>();

    for (const wt of worktrees) {
      const session = sessionByWorktreeId.get(wt.id) ?? null;
      if (session) worktreeSessionIds.add(session.id);
      const repoName = (() => {
        if (session?.repoPath) return getBaseName(session.repoPath);
        const matchedRepo = repoList.find(repo => wt.path.startsWith(repo));
        if (matchedRepo) return getBaseName(matchedRepo);
        return getBaseName(wt.path.split("/.worktrees/")[0] || wt.path);
      })();
      const existing = groups.get(repoName) || [];
      existing.push({ worktree: wt, session });
      groups.set(repoName, existing);
    }

    for (const session of Array.from(sessions.values())) {
      if (worktreeSessionIds.has(session.id)) continue;
      const repo = session.repoPath ?? findRepoForSession(session, repoList);
      const repoName = repo ? getBaseName(repo) : "unknown";
      const existing = groups.get(repoName) || [];
      existing.push({ worktree: null, session });
      groups.set(repoName, existing);
    }

    return groups;
  }, [worktrees, sessions, sessionByWorktreeId, repoList]);

  return { groupedItems, sessionByWorktreeId };
}
