/**
 * 分岐TODOから会話を始めるときに、Dashboard が使う純粋な判定。
 * - 元のworktreeのリポジトリとブランチ (新しいworktreeの作成ダイアログの初期値)
 * - 作成を頼んだworktreeが届いたときの、下書きの行き先と本文
 * - worktreeのパスからセッションを引く (セッションが現れたら選ぶ待ちに使う)
 */

import type { ManagedSession, Todo, Worktree } from "@ark/shared";
import { isPathWithin } from "@/utils/pathUtils";
import { isSessionBelongsToRepo } from "@/utils/sessionUtils";
import { buildTodoDraft } from "./todo-draft";

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

/** 新しいworktreeで始めるために、作成の完了を待っているTODO (1件だけ持つ) */
export interface PendingTodoWorktree {
  todoId: string;
  todo: Todo;
  originBranch: string | undefined;
}

/**
 * todoId 付きの worktree:created が、待っている作成のものなら、下書きの行き先と本文を返す。
 * 別のセッションも同時に作成しうるので、ブランチ名ではなく todoId で見分ける
 */
export function draftForCreatedWorktree(
  pending: PendingTodoWorktree | null,
  created: { todoId: string; worktree: Pick<Worktree, "path"> }
): { worktreePath: string; draft: string } | null {
  if (!pending || pending.todoId !== created.todoId) return null;
  return {
    worktreePath: created.worktree.path,
    draft: buildTodoDraft(pending.todo, pending.originBranch),
  };
}
