/**
 * task_start の repo で別のリポジトリへ切り出した子を、一覧に出すための判定。
 *
 * 一覧は、画面に登録したリポジトリ (repoList) のセッションだけを出す。子のリポジトリが
 * 未登録だと、親が起こした子がどこにも出ない。そこで、別のリポジトリへ切り出した子の
 * セッションだけを、リポジトリが未登録でも一覧に出す (useGroupedWorktreeItems)。
 *
 * リポジトリを repoList に足すことはしない。足すと、そのリポジトリの無関係なセッションと
 * worktree まで一覧に出てくる。同じリポジトリの中で分けた子 (行のメニューの「子タスクを分離」)
 * は対象にしない。親と同じ扱いで、リポジトリを登録していなければ出さない。
 *
 * イベントではなくセッションの一覧から導くので、起こした瞬間につないでいなかった画面
 * (リロード後、後から開いたモバイル) でも同じ結果になる。
 */

import type { ManagedSession } from "@ark/shared";

/** パスがそのリポジトリのもの (本体、中の worktree、兄弟ディレクトリの `<repo>-*`) か */
function belongsToRepo(path: string, repoPath: string): boolean {
  return (
    path === repoPath ||
    path.startsWith(`${repoPath}/`) ||
    path.startsWith(`${repoPath}-`)
  );
}

/**
 * 親と別のリポジトリへ切り出した子のセッションか。
 * 親のリポジトリは、起こした時点でサーバーがセッションに記録したもの (parentRepoPath) と比べる。
 * 記録の無い古い行は、いま一覧にある親のセッションのリポジトリ (parentSessionRepoPath) と比べる。
 * どちらも無いとき (記録より前に起こした子で、親を止めたあと) だけ、親のパスが子の
 * リポジトリのものかどうかの形で見分ける
 */
export function isCrossRepoChild(
  session: ManagedSession,
  parentSessionRepoPath?: string | null
): boolean {
  if (!session.parentWorktreePath || !session.repoPath) return false;
  const parentRepoPath = session.parentRepoPath ?? parentSessionRepoPath;
  if (parentRepoPath) return parentRepoPath !== session.repoPath;
  return !belongsToRepo(session.parentWorktreePath, session.repoPath);
}
