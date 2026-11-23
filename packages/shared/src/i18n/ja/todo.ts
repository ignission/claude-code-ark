export const todo = {
  scopeSession: "このセッション",
  scopeAll: "すべて",
  empty: "保留にした話題はありません",
  doneCount: (count: number) => `完了 (${count})`,
  markDone: "完了にする",
  markUndone: "未完了に戻す",
  talkHere: "元のセッションで話す",
  talkInNewWorktree: "新しいworktreeで話す",
  startInRepo: (repoName: string) => `${repoName} で始める`,
  /** 始めた先のセッションがあるときに「始める」の代わりに出す。label はその表示名 */
  openStarted: (label: string) => `${label} へ移動`,
  /** 「へ移動」の右に並べる、その行を完了にするボタン */
  finishStarted: "完了",
  /** 始めた先のセッションがある行を完了にするときの確認。label は始めた先の表示名 */
  finishStartedConfirmTitle: "TODOを完了にする",
  finishStartedConfirm: (label: string) =>
    `${label} のセッションとworktreeを削除して、このTODOを完了にしますか？コミットしていない変更は失われます。`,
  finishStartedConfirmAction: "削除して完了",
  remove: "TODO を消す",
  startedHere: "このセッションで始めた",
  /** label は始めた先の worktree の表示名。worktree を消していれば null */
  startedIn: (label: string | null) =>
    `→ ${label ?? "削除済みのworktree"}で始めた`,
  deletedWorktree: "削除済み worktree",
  api: {
    noResponse: "サーバーから応答がありません",
  },
  /** 新しいworktreeで始めるときに、Claudeへ送る文の末尾に添える */
  draftOrigin: (branch: string) => `(分岐TODO。元のブランチ: ${branch})`,
};
