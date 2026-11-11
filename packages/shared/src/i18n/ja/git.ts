export const git = {
  loading: "読み込み中…",
  loadingLabel: "読み込み中",
  retry: "再試行",
  connecting: "接続中…",
  noResponse: "サーバーから応答がありません",
  uncommittedChanges: "未コミットの変更",

  /** 相対時刻 (`git-format.ts` の `formatRelativeTime`) */
  time: {
    justNow: "たった今",
    minutesAgo: (minutes: number) => `${minutes}分前`,
    hoursAgo: (hours: number) => `${hours}時間前`,
    yesterday: "昨日",
    daysAgo: (days: number) => `${days}日前`,
  },

  /** ファイルの変更の種類 */
  fileStatus: {
    added: "追加",
    modified: "変更",
    deleted: "削除",
    renamed: "名前の変更",
    copied: "コピー",
    typeChanged: "種類の変更",
    conflicted: "競合",
    untracked: "未追跡",
  },

  detail: {
    binary: "バイナリ",
    groupStaged: "ステージ済み",
    groupUnstaged: "変更",
    groupUntracked: "未追跡",
    empty: "コミットを選ぶと、ここに詳細が出ます",
    tabCommit: "コミット",
    tabChanges: "変更",
    tabChangesCount: (count: number) => `変更 ${count}`,
    noUncommittedChanges: "未コミットの変更はありません",
    noChanges: "変更はありません",
    changedFiles: "変更されたファイル",
    binaryFile: "バイナリファイルです",
    tooLarge: "大きすぎるため表示できません",
    tabsLabel: "詳細の表示",
    deletedFileCannotOpen: "削除されたファイルは開けません",
    openInFilesTab: "ファイルのタブで開く",
    openInFiles: "ファイルで開く",
    copyHash: "ハッシュをコピー",
    copied: "コピーしました",
    committer: "コミッター",
    hash: "ハッシュ",
    parents: "親",
    noParents: "なし (最初のコミット)",
  },

  list: {
    filterPlaceholder: "件名・作者・ハッシュで絞り込み",
    filterLabel: "コミットを絞り込む",
    matchCount: (count: number) => `${count}件`,
    clearFilter: "絞り込みを解除",
    reload: "読み直す",
    commitsLabel: "コミット",
    noMatches: "一致するコミットがありません",
    noCommits: "コミットがありません",
    uncommittedChangesCount: (count: number) => `未コミットの変更 (${count})`,
    createBranchHere: "ここからブランチを作成",
    loadMoreFailed: "続きを読み込めませんでした",
    loadMore: "さらに読み込む",
  },

  pane: {
    openSidebar: "サイドバーを開く",
    collapseSidebar: "サイドバーを折りたたむ",
    resizeHandle: "一覧と詳細の高さを調整",
    fetchTitle: "fetch (すべてのリモート)",
    pullTitle: (branch: string) => `pull: ${branch} を fast-forward で進める`,
    pullDisabled: "ブランチにいないので pull できません",
    pushTitle: (branch: string, upstream: string | undefined) =>
      `push: ${branch}${upstream ? ` → ${upstream}` : " (新しく upstream を作る)"}`,
    pushDisabled: "ブランチにいないので push できません",
  },

  refs: {
    currentBranchTitle: (name: string) => `${name} (いまのブランチ)`,
  },

  sidebar: {
    navLabel: "Git の参照",
    changes: (count: number) => (count > 0 ? `変更 (${count})` : "変更"),
    allCommits: "すべてのコミット",
    branches: "ブランチ",
    remotes: "リモート",
    tags: "タグ",
    stashes: "スタッシュ",
    currentBranch: "いまのブランチ",
    mainWorktreeBlocked:
      "リポジトリ本体の作業ツリーで使用中なので削除できません",
    newBranchHere: "ここから新しいブランチ",
    rename: "名前を変更",
    pushNew: "新規",
    deleteWithWorktree: "作業ツリーごと削除",
    thisSessionWorktree: "このセッションの作業ツリー",
    inUseAt: (worktreePath: string) => `使用中: ${worktreePath}`,
    deleteFromRemote: "リモートから削除",
    defaultBranchBlocked: "リモートの既定のブランチは削除できません",
    unknownRemote: (remote: string) => `リモート ${remote} は設定にありません`,
  },

  ops: {
    failed: "失敗しました",
    branchRestored: (name: string) => `ブランチ ${name} を戻しました`,
    branchDeleted: (name: string) => `ブランチ ${name} を削除しました`,
    branchDeletedWithWorktree: (name: string) =>
      `ブランチ ${name} を作業ツリーごと削除しました`,
    /** 作業ツリーごと消したあとのtoastの補足。shaは短い形 */
    undoRestoresBranchOnly: (sha: string) =>
      `${sha} (元に戻すで戻るのはブランチだけです)`,
    undo: "元に戻す",
    pushed: (name: string) => `${name} を push しました`,
    fetched: "fetch しました",
    pulled: (name: string) => `${name} を pull しました`,
    nameRequired: "ブランチ名を入力してください",
    branchCreated: (name: string) => `ブランチ ${name} を作成しました`,
    branchRenamed: (from: string, to: string) =>
      `${from} を ${to} に変更しました`,
    remoteBranchDeleted: (trackingName: string) =>
      `${trackingName} をリモートから削除しました`,
    renameTitle: "ブランチの名前を変更",
    createTitle: "新しいブランチ",
    renameDescription: (from: string) => `${from} の新しい名前`,
    createDescription: (sha: string) =>
      `${sha} から作成します (チェックアウトはしません)`,
    branchName: "ブランチ名",
    renameSubmit: "変更",
    createSubmit: "作成",
    confirmRemoteDeleteTitle: (trackingName: string) =>
      `${trackingName} をリモートから削除しますか?`,
    confirmWorktreeDeleteTitle: (name: string) =>
      `${name} を作業ツリーごと削除しますか?`,
    confirmForceDeleteTitle: (name: string) => `${name} を強制削除しますか?`,
    confirmRemoteDeleteDescription: (remote: string) =>
      `リモート ${remote} からブランチを消します。ほかの人もこのリモートを使っていれば、その人からも見えなくなります。`,
    confirmWorktreeDeleteDescription: (
      worktreePath: string,
      isCurrentSession: boolean,
      notMerged: boolean
    ) =>
      [
        `作業ツリー ${worktreePath} を消し、`,
        isCurrentSession
          ? "このセッションを止めます。"
          : "そこで動いているセッションを止めます。",
        "コミットしていない変更も消えます。",
        notMerged
          ? "どこにも取り込まれていないコミットがあります (直後なら「元に戻す」でブランチは戻せます)。"
          : "",
      ].join(""),
    /** reasonはサーバーが返した、未マージの理由の文 */
    confirmForceDeleteDescription: (reason: string) =>
      `${reason}。削除するとこれらのコミットはブランチから辿れなくなります (直後なら「元に戻す」で戻せます)。`,
  },
};
