/**
 * useGroupedWorktreeItems - worktreeをリポジトリ別にグルーピングするカスタムフック
 *
 * SessionSidebarとMobileSessionListで共通のグルーピングロジックを提供する。
 *
 * グループキーは絶対パス (repoPath)。同じbasenameのリポジトリ（例:
 * `/work/a/app` と `/work/b/app`）が衝突しないようにするため、
 * UIで表示する短縮名は repoName を用い、basenameが他repoと重複する場合は
 * 親ディレクトリsegmentを末尾から付与した disambiguator を併記する。
 */

import { useMemo } from "react";
import { findRepoForSession } from "@/utils/sessionUtils";
import type { ManagedSession, Worktree } from "../../../shared/types";

export type GroupedItem = {
  worktree: Worktree | null;
  session: ManagedSession | null;
};

export type RepoGroup = {
  /** 表示用のリポジトリ名（basename） */
  repoName: string;
  /**
   * 同じbasenameの他repoが存在する場合の区別用ヒント（親ディレクトリ名等）。
   * 重複がない場合はnull。UI側でrepoName横に括弧書きで表示する想定。
   */
  disambiguator: string | null;
  /** グループ配下のworktree/sessionアイテム */
  items: GroupedItem[];
};

function getBaseName(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

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
    const groups = new Map<string, RepoGroup>();
    const worktreeSessionIds = new Set<string>();

    // repoListに含まれるrepoのworktree/sessionのみ表示する。
    // repoListが空の場合は何も表示しない（「全件表示」にフォールバックすると、
    // 最後の1件を除外した直後に除外対象が再表示されてしまう）。
    const repoListEmpty = repoList.length === 0;

    const ensureGroup = (repoPath: string): RepoGroup => {
      const existing = groups.get(repoPath);
      if (existing) return existing;
      const created: RepoGroup = {
        repoName: getBaseName(repoPath),
        disambiguator: null,
        items: [],
      };
      groups.set(repoPath, created);
      return created;
    };

    // worktreePath昇順で処理することでリロード間の並び順を安定させる
    const sortedWorktrees = [...worktrees].sort((a, b) =>
      a.path.localeCompare(b.path)
    );
    for (const wt of sortedWorktrees) {
      if (repoListEmpty) break;
      const session = sessionByWorktreeId.get(wt.id) ?? null;
      const matchedRepo = repoList.find(repo => wt.path.startsWith(repo));
      const sessionRepoMatched = session?.repoPath
        ? repoList.includes(session.repoPath)
        : false;
      if (!matchedRepo && !sessionRepoMatched) continue;
      if (session) worktreeSessionIds.add(session.id);
      const repoPath = (() => {
        if (session?.repoPath) return session.repoPath;
        if (matchedRepo) return matchedRepo;
        return wt.path.split("/.worktrees/")[0] || wt.path;
      })();
      ensureGroup(repoPath).items.push({ worktree: wt, session });
    }

    const sortedSessions = Array.from(sessions.values()).sort((a, b) =>
      a.worktreePath.localeCompare(b.worktreePath)
    );
    for (const session of sortedSessions) {
      if (repoListEmpty) break;
      if (worktreeSessionIds.has(session.id)) continue;
      const repo = session.repoPath ?? findRepoForSession(session, repoList);
      if (!repo || !repoList.includes(repo)) continue;
      ensureGroup(repo).items.push({ worktree: null, session });
    }

    // 同じbasenameが複数repoで使われている場合、先祖ディレクトリを必要分付与して一意にする。
    // 例: /a/services/api と /b/services/api → "api (a/services)" / "api (b/services)"
    const nameBuckets = new Map<string, string[]>();
    for (const [repoPath, group] of groups.entries()) {
      const arr = nameBuckets.get(group.repoName) ?? [];
      arr.push(repoPath);
      nameBuckets.set(group.repoName, arr);
    }
    for (const [name, paths] of nameBuckets.entries()) {
      if (paths.length < 2) continue;
      // 各pathの親部分（basenameを除く）をsegment配列に分解。末尾側から追加していく。
      const parentSegments = paths.map(p => {
        const parent = p.replace(/\/+[^/]+\/?$/, "");
        return parent.split("/").filter(Boolean);
      });
      // 一意になるまで末尾segment数を増やす
      let suffixLen = 1;
      while (suffixLen <= Math.max(...parentSegments.map(s => s.length))) {
        const suffixes = parentSegments.map(s =>
          s.slice(Math.max(0, s.length - suffixLen)).join("/")
        );
        if (new Set(suffixes).size === suffixes.length) break;
        suffixLen++;
      }
      paths.forEach((p, i) => {
        const group = groups.get(p);
        if (!group) return;
        const segs = parentSegments[i];
        const suffix = segs
          .slice(Math.max(0, segs.length - suffixLen))
          .join("/");
        group.disambiguator = suffix || name; // 最悪fallbackで同名のまま
      });
    }

    // リポジトリ名(basename)→ full pathで安定ソートする
    return new Map(
      Array.from(groups.entries()).sort(([pathA, a], [pathB, b]) => {
        const byName = a.repoName.localeCompare(b.repoName);
        return byName !== 0 ? byName : pathA.localeCompare(pathB);
      })
    );
  }, [worktrees, sessions, sessionByWorktreeId, repoList]);

  return { groupedItems, sessionByWorktreeId };
}
