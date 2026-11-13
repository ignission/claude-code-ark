export const board = {
  empty: "図がありません",
  loading: "読み込み中…",
  loadFailed: (status: number) => `読み込みに失敗しました (${status})`,
  listFailed: "図一覧の取得に失敗しました",
  deleteFailed: "図の削除に失敗しました",
  navigationBlocked:
    "図が別のページへ遷移しようとしたため接続を遮断しました。図ファイルに外部遷移するスクリプトが含まれていないか確認してください",
  selectFromList: "上の一覧から図を選択",
  disconnected: "ソケットが切断されています",
  deleteTimeout: "図の削除がタイムアウトしました",
  /** 図の一部を囲んで、会話の入力欄へ引用する */
  quote: {
    start: "一部を選んで聞く",
    startTitle: "図の一部を囲んで、会話の入力欄に引用する",
    stop: "選ぶのをやめる",
    hint: "聞きたい部分をドラッグで囲んでください",
    empty: "囲んだ範囲に文字がありませんでした。文字のある部分を囲んでください",
    /** 引用の1行目。このあとに囲んだ文字が引用として続く */
    header: (name: string, relPath: string) =>
      `ボード「${name}」(${relPath}) のこの部分について:`,
    truncated: "(長いので、ここまでを引用)",
  },
  /** 一覧の更新日時 */
  time: {
    today: (time: string) => `今日 ${time}`,
    yesterday: (time: string) => `昨日 ${time}`,
    /** 今年の日付。month は 1 始まり */
    monthDay: (month: number, day: number) => `${month}/${day}`,
    yearMonthDay: (year: number, month: number, day: number) =>
      `${year}/${month}/${day}`,
  },
  switcher: {
    title: "図",
    select: "図を選択",
    backToList: "図の一覧",
    backToListTitle: "図の一覧へ戻る",
    forward: "図へ進む",
    forwardTitle: "開いていた図へ進む",
    count: (count: number) => `${count}件`,
    refreshing: "更新中…",
    retry: "再試行",
    search: "図を探す",
    selectedCount: (count: number) => `${count}件を選択中`,
    clearSelection: "選択を解除",
    deleteSelected: "選んだ図を削除",
    selectAllVisible: "見えている図をすべて選択",
    columnName: "名前",
    columnUpdated: "更新",
    sortBy: (column: string) => `${column}で並べ替え`,
    noMatch: "一致する図がありません",
    tracked: "Git管理",
    untracked: "未追跡",
    rowTitle: (relPath: string, tracked: boolean) =>
      `${relPath}（${tracked ? "Git管理" : "未追跡"}）`,
    selectItem: (name: string) => `「${name}」を選択`,
    deleteItem: (name: string) => `「${name}」を削除`,
    confirmDeleteOne: (name: string) => `「${name}」を削除しますか？`,
    confirmDeleteMany: (count: number) => `${count}件の図を削除しますか？`,
    andMore: (count: number) => `ほか${count}件`,
    trackedCount: (count: number) => `Git管理 ${count}件`,
    untrackedCount: (count: number) => `未追跡 ${count}件`,
    trackedAndUntracked: (tracked: number, untracked: number) =>
      `Git管理 ${tracked}件 / 未追跡 ${untracked}件`,
    deleteWarningTracked:
      "図と隣接するコメント sidecar も削除します。図は worktree に削除差分が残ります。必要なら Git で復元できます。ただし Git 未追跡のファイルは復元できません。この操作は取り消せません。",
    deleteWarningUntracked:
      "図と隣接するコメント sidecar も削除します。Git 未追跡のファイルは復元できません。この操作は取り消せません。",
    deleting: "削除中…",
    deletingProgress: (current: number, total: number) =>
      `削除中… ${current}/${total}`,
    deleteOne: "削除する",
    deleteMany: (count: number) => `${count}件を削除する`,
    bulkDeleteFailed: (total: number, failed: number) =>
      `${total}件のうち${failed}件を削除できませんでした`,
  },
};
