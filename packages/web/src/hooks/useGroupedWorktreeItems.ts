/**
 * useGroupedWorktreeItems - worktreeをリポジトリ別にグルーピングするカスタムフック
 *
 * SessionSidebarとMobileSessionListで共通のグルーピングロジックを提供する。
 *
 * グループキーは絶対パス (repoPath)。同じbasenameのリポジトリ（例:
 * `/work/a/app` と `/work/b/app`）が衝突しないようにするため、
 * UIで表示する短縮名は repoName を用い、basenameが他repoと重複する場合は
 * 親ディレクトリsegmentを末尾から付与した disambiguator を併記する。
 *
 * mainのworktree (Worktree.isMain。worktreeがまだ届いていないセッションは、パスがリポジトリの
 * パスと同じもの) は行にしない。worktreeが届けば isMain で決める (worktreeのあるリポジトリとして
 * 登録したlinked worktreeは、パスが同じでもmainではないので行に出す)。mainは人が作業しない場所で、作業は毎回新しいworktreeで始める。
 * 登録したリポジトリのグループは、行が1つも無くても作る (見出しのメニューから新しいタスクを始める)。
 */

import type { ManagedSession, Worktree } from "@ark/shared";
import { useMemo } from "react";
import { isCrossRepoChild } from "@/lib/child-task-repos";
import { isPathWithin } from "@/utils/pathUtils";
import { findRepoForSession } from "@/utils/sessionUtils";

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
  /** グループ配下のworktree/sessionアイテム (mainのworktreeは含めない) */
  items: GroupedItem[];
  /** mainのworktreeのパス。見出しの「ホームにする」に使う。worktreeが届く前はnull */
  mainWorktreePath: string | null;
};

function getBaseName(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

const NO_ACTIVE_SESSIONS: ReadonlySet<string> = new Set();

export function useGroupedWorktreeItems(
  worktrees: Worktree[],
  sessions: Map<string, ManagedSession>,
  repoList: string[],
  /**
   * いま動いているか直近に動いたセッションの id。リポジトリが未登録でも一覧に出す
   * (lib/unlisted-active-sessions.ts)。中身が同じなら同じ参照を渡すこと
   */
  activeSessionIds: ReadonlySet<string> = NO_ACTIVE_SESSIONS
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
        mainWorktreePath: null,
      };
      groups.set(repoPath, created);
      return created;
    };

    for (const repo of repoList) ensureGroup(repo);

    // worktreePath昇順で処理することでリロード間の並び順を安定させる
    const sortedWorktrees = [...worktrees].sort((a, b) =>
      a.path.localeCompare(b.path)
    );
    for (const wt of sortedWorktrees) {
      if (repoListEmpty) break;
      const session = sessionByWorktreeId.get(wt.id) ?? null;
      // 入れ子のリポジトリ (/work/app と /work/app/tools/plugin) は、いちばん深いものに入れる
      const matchedRepo = repoList
        .filter(repo => isPathWithin(wt.path, repo))
        .reduce<string | undefined>(
          (deepest, repo) =>
            deepest === undefined || repo.length > deepest.length
              ? repo
              : deepest,
          undefined
        );
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
      const group = ensureGroup(repoPath);
      if (wt.isMain) {
        group.mainWorktreePath = wt.path;
        continue;
      }
      group.items.push({ worktree: wt, session });
    }

    const sortedSessions = Array.from(sessions.values()).sort((a, b) =>
      a.worktreePath.localeCompare(b.worktreePath)
    );
    // 親のセッションのリポジトリ (別のリポジトリへ切り出した子かを見分けるのに使う)
    const repoPathByWorktreePath = new Map<string, string>();
    for (const session of sortedSessions) {
      if (session.repoPath) {
        repoPathByWorktreePath.set(session.worktreePath, session.repoPath);
      }
    }
    // 登録したリポジトリが空でも走査する。別のリポジトリへ切り出した子 (lib/child-task-repos.ts)
    // と、動いているか直近に動いたセッション (lib/unlisted-active-sessions.ts) は、リポジトリが
    // 未登録でも出す。それ以外の未登録のセッションは出さない
    for (const session of sortedSessions) {
      if (worktreeSessionIds.has(session.id)) continue;
      const repo = session.repoPath ?? findRepoForSession(session, repoList);
      const crossRepoChild = isCrossRepoChild(
        session,
        session.parentWorktreePath
          ? repoPathByWorktreePath.get(session.parentWorktreePath)
          : null
      );
      if (!repo) continue;
      // worktreeがまだ届いていないmainのセッションも行にしない (届く前は isMain が無いのでパスで見分ける)
      if (session.worktreePath === repo) continue;
      const shown =
        repoList.includes(repo) ||
        crossRepoChild ||
        activeSessionIds.has(session.id);
      if (!shown) continue;
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
  }, [worktrees, sessions, sessionByWorktreeId, repoList, activeSessionIds]);

  return { groupedItems, sessionByWorktreeId };
}
