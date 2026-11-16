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
  /** ボードの中の画像を押したときの拡大表示 */
  imageZoom: {
    label: "画像の拡大表示",
    close: "閉じる",
  },
  /** ボードの付箋と、Claudeへの受け渡し */
  notes: {
    add: "付箋を足す",
    addTitle: "見えている範囲の中央に付箋を足す",
    handOff: "Claudeに渡す",
    handOffTitle: "付箋をClaudeに渡す。Claudeはボードを書き換えて返す",
    handOffEmpty: "付箋を置くと渡せます",
    handOffBusy: "Claudeの作業が終わると渡せます",
    handOffChecking: "Claudeの状態を確認しています",
    handOffStopped: "セッションが止まっています",
    notStarted: "Claudeが動き出しませんでした。会話を見てください",
    handOffDisconnected: "接続が切れています",
    turn: "Claudeの番です。終わるとボードが書き換わります",
    awaiting: "Claudeが確認を待っています。会話を見てください",
    invalid:
      "付箋のファイルを読めません (書き方が壊れています)。直前の付箋を表示しています。Claudeに「付箋のファイルを直して」と頼んでください",
    limit: "付箋の数が上限に達しています",
    failed: "付箋を保存できませんでした",
    dropped: (count: number) =>
      `形の合わない付箋や枠を${count}件読み飛ばしました`,
    newBoard: "新しいボード",
    newBoardTitle: "白紙のボードを作って、付箋から書き始める",
    /** 白紙のボードの名前。month は 1 始まり */
    blankName: (month: number, day: number, time: string) =>
      `ホワイトボード ${month}/${day} ${time}`,
    createFailed: "ボードを作れませんでした",
    /** 「Claudeに渡す」で送る定型文。人は書かない */
    handOffMessage: (notesPath: string, diagramPath: string) =>
      `ボードの付箋を渡します。\`${notesPath}\` を読み、付箋に応えて、同じファイルを書き換えてください (似たものを枠でまとめる、問いにはあなたの付箋で答える、抜けているものがあればあなたの付箋で足す)。付箋は図 \`${diagramPath}\` の上に置かれています。返事はボードに出るので、チャットには1行だけ書いてください。`,
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
      "図に置いた付箋も削除します。図は worktree に削除差分が残ります。必要なら Git で復元できます。ただし Git 未追跡のファイルは復元できません。この操作は取り消せません。",
    deleteWarningUntracked:
      "図に置いた付箋も削除します。Git 未追跡のファイルは復元できません。この操作は取り消せません。",
    deleting: "削除中…",
    deletingProgress: (current: number, total: number) =>
      `削除中… ${current}/${total}`,
    deleteOne: "削除する",
    deleteMany: (count: number) => `${count}件を削除する`,
    bulkDeleteFailed: (total: number, failed: number) =>
      `${total}件のうち${failed}件を削除できませんでした`,
  },
};
