/** セッション一覧、上部バー、状態の札、通知、ダッシュボードの文 */
export const session = {
  /** 複数の場所で使う操作の名前 */
  actions: {
    deleteSession: "セッションを削除",
    deleteWorktree: "Worktreeを削除",
    restart: "再起動",
    copy: "コピー",
  },
  /** 状態の札 (`status-tone.ts`) */
  status: {
    awaiting: "確認待ち",
    error: "問題",
    idle: "入力待ち",
    working: "作業中",
    ready: "待機",
    stopped: "停止",
    notStarted: "未起動",
  },
  sections: {
    yourTurn: "あなたの番",
    working: "作業中",
    resting: "休止中",
  },
  /** モバイルの会話画面のヘッダー直下の帯と、切断の表示 */
  strip: {
    disconnected: "サーバーとつながっていません",
    question: "質問があります",
    confirmation: "確認を求めています",
    thinking: "考えています",
    working: "作業しています",
    error: "問題が起きています",
  },
  /** PRの札 (`pr-status.ts`)。pr は `#550` の形 */
  pr: {
    mergedText: (pr: string) => `${pr} マージ済み`,
    mergedLabel: (pr: string) => `PR ${pr} はマージ済み`,
    closedText: (pr: string) => `${pr} クローズ`,
    closedLabel: (pr: string) => `PR ${pr} はクローズ済み`,
    pendingText: (pr: string) => `${pr} 待ち`,
    checksFailedLabel: (pr: string, isDraft: boolean) =>
      `PR ${pr}${isDraft ? " (下書き)" : ""}: チェックが失敗`,
    checksPendingLabel: (pr: string, isDraft: boolean) =>
      `PR ${pr}${isDraft ? " (下書き)" : ""}: チェックの実行中`,
    checksPassedLabel: (pr: string, isDraft: boolean) =>
      `PR ${pr}${isDraft ? " (下書き)" : ""}: チェックが通過`,
    noChecksLabel: (pr: string, isDraft: boolean) =>
      `PR ${pr}${isDraft ? " (下書き)" : ""}: チェックなし`,
  },
  planLimits: {
    weekShort: "週",
    fiveHourName: "5時間枠",
    weekName: "週枠",
    summary: (
      rows: readonly { name: string; percent: number; resetAt: string | null }[]
    ) =>
      rows
        .map(
          r =>
            `${r.name} ${r.percent}%${r.resetAt ? ` (${r.resetAt}にリセット)` : ""}`
        )
        .join("、"),
    ariaLabel: (summary: string) => `プランの使用量: ${summary}`,
  },
  contextUsage: {
    /** tokens と window は桁区切り済みの文字列 */
    label: (tokens: string, window: string, percent: number) =>
      `コンテキスト ${tokens} / ${window} トークン (${percent}%)。上限は推定`,
  },
  /** ブラウザ通知の許可のボタン */
  browserNotifications: {
    granted: "ブラウザ通知は許可済み",
    denied: "ブラウザ通知はブラウザ設定で拒否されています",
    enable: "ブラウザ通知を有効にする",
  },
  /** OSの通知 (`session-notifications.ts`) */
  notifications: {
    awaitingTitle: "Ark: 判断を待っています",
    awaitingBody: (sessionLabel: string) =>
      `${sessionLabel} で権限確認が必要です`,
    questionTitle: "Ark: 質問があります",
    questionBody: (sessionLabel: string) =>
      `${sessionLabel} が回答を待っています`,
    completedTitle: "Ark: 作業が完了しました",
    completedBody: (sessionLabel: string) =>
      `${sessionLabel} の実行が停止しました`,
    ciFailedTitle: "Ark: CIが落ちました",
    /** prNumber は番号か、分からないときの "?" */
    ciFailedBody: (sessionLabel: string, prNumber: number | string) =>
      `${sessionLabel} のPR #${prNumber} のチェックが失敗しました`,
  },
  /** PCの上部バーと `…` メニュー (`session-header.ts`) */
  header: {
    moreActions: "その他の操作",
    hideInputBar: "入力バーを隠す",
    showInputBar: "入力バーを表示",
    muteSession: "このセッションの通知をオフにする",
    unmuteSession: "このセッションの通知をオンにする",
    deleteConfirm: "このセッションを削除しますか？",
    deleteConfirmKeepMain:
      "このセッションを削除しますか？メインWorktreeは削除されません。",
    deleteConfirmWithWorktree:
      "このセッションとWorktreeを削除しますか？関連するブランチも削除されます。",
  },
  /** 一覧の行 */
  row: {
    editDisplayName: "表示名を編集",
    parentTitle: (parent: string) => `親: ${parent}`,
    openParentLabel: (parent: string) => `親 ${parent} を開く`,
    individualProfile: "個別",
    childTasks: (count: number) => `子のタスク ${count} 件`,
    openTodos: (count: number) => `未完了の TODO ${count} 件`,
    menuLabel: (name: string, branch: string | null | undefined) =>
      branch ? `${name} (${branch}) のメニュー` : `${name}のメニュー`,
    staleProfile: "古い設定",
    staleProfileHint:
      "プロファイルの割り当てが変わりました。このセッションは元の設定で動いています",
  },
  /** 行のメニュー */
  menu: {
    open: "開く",
    startSession: "セッションを起動",
    splitTask: "子タスクを分離...",
    openParent: "親を開く",
    rename: "表示名を変更",
    muteNotifications: "通知をオフにする",
    unmuteNotifications: "通知をオンにする",
    worktreeProfile: "このworktreeのプロファイル",
    inheritRepoProfile: (profileName: string | null) =>
      `リポジトリの設定を継承 (${profileName ?? "既定"})`,
    repository: "リポジトリ",
    newWorktree: "新規worktreeを作成",
    openRepoGrid: "このリポジトリの全セッションを並べて見る",
    repoDefaultProfile: "リポジトリの既定プロファイル",
    defaultProfile: "既定 (~/.claude)",
    removeFromSidebar: "サイドバーから除外",
    openProfileManager: "プロファイル管理を開く...",
  },
  /** 一覧と、その確認ダイアログ */
  list: {
    empty: "セッションがありません",
    emptyHint: "「+」から新規作成",
    repoEmpty: "このリポジトリにはまだセッションがありません",
    deleteWorktreeConfirm:
      "このWorktreeを削除しますか？関連するブランチも削除されます。",
    restartConfirmTitle: "セッションを再起動しますか？",
    restartConfirmBody:
      "このセッションを再起動するとClaude会話履歴・実行中コマンド・ターミナル内容がすべて失われます。続行しますか？",
    removeRepoTitle: "リポジトリをサイドバーから除外",
    removeRepoBody: (repoName: string) =>
      `「${repoName}」をサイドバー一覧から非表示にします。Worktreeやセッション、リポジトリ自体は削除されません。再度リポジトリを選択すれば復元できます。`,
    removeRepoAction: "除外",
  },
  sidebar: {
    arkMenu: "Arkのメニュー",
    newTask: "新しいタスク",
    newSession: "新規セッション",
    screens: "画面",
    manageScreens: "画面の管理...",
    openBridge: "Bridgeを別タブで開く",
  },
  /** 新しい版の知らせ (バナーと、読み込み直しのトースト) */
  update: {
    available: "新しいバージョンが利用可能です",
    changelog: "変更点",
    newBuildTitle: "新しい版があります",
    newBuildDescription:
      "書きかけの入力があるため、自動では読み込み直していません",
    reload: "読み込み直す",
  },
  /** サーバーとのやりとりの失敗と進み具合 (`useSocket.ts`) */
  socket: {
    disconnected: "ソケットが切断されています",
    notConnected:
      "サーバーに接続されていません。少し待ってから再試行してください",
    shortcutFailed: (message: string) => `ショートカット操作に失敗: ${message}`,
    usageStarted: "Usage取得を開始しました（数十秒かかります）",
    usageDone: (okCount: number, total: number) =>
      `Usage取得完了: ${okCount}/${total} プロファイル`,
    usageFailed: (message: string) => `Usage取得に失敗: ${message}`,
    listDirectoryTimeout: "ディレクトリ取得がタイムアウトしました",
    listDirectoryFailed: "ディレクトリ取得に失敗しました",
    listDiagramsTimeout: "図一覧の取得がタイムアウトしました",
    taskStartTimeout: "タスクの起動がタイムアウトしました",
    uploadTimeout: "アップロードがタイムアウトしました",
  },
  dashboard: {
    worktreeDeleted: "Worktreeを削除しました",
    worktreeDeleting: "Worktreeを削除中...",
    sessionDeleted: "セッションを削除しました",
    sessionStopped: "セッションを停止しました",
    taskStarted: (branch: string) => `タスクを起動しました: ${branch}`,
    emptyHint: "サイドバーの「+」からセッションを作成",
    tunnelSelectPort: "公開するポートを選択してください",
    tunnelPortPlaceholder: "ポートを選択...",
    tunnelPortInput: "またはポート番号を入力",
    tunnelUrlDescription: "外部からアクセスするためのURLです",
    sessionCount: (count: number) => `${count}セッション`,
    tunnelPort: "ポート",
    tunnelStart: "トンネルを開始",
    tunnelStop: "トンネルを停止",
    tunnelAuthToken: "認証トークン",
    cannotDeleteMainWorktree: "メインのworktreeは削除できません",
  },
};
