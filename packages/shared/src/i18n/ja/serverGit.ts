export const serverGit = {
  sessionNotFound: "セッションが見つかりません",
  /** git の呼び出しそのものの失敗 */
  run: {
    notFound: "git コマンドが見つかりません",
    outputTooLarge: "git の出力が大きすぎます",
    timeout: "git がタイムアウトしました",
    notRepository: "git リポジトリではありません",
    /** reason は git の stderr か Node のエラーの文 (訳さない) */
    failed: (reason: string) => `git の実行に失敗しました: ${reason}`,
    failedWithExitCode: (code: number | null) =>
      `git の実行に失敗しました: 終了コード ${code}`,
  },
  /** Git タブの読み取り */
  view: {
    commitNotFound: "コミットが見つかりません",
    invalidCommit: "コミットの指定が不正です",
    invalidPath: "パスが不正です",
    invalidDiffTarget: "差分の対象が不正です",
  },
  /** Git タブの書き込み (ブランチとリモートの操作) */
  ops: {
    invalidRequest: "要求の形が不正です",
    inProgress: "別の Git の操作が実行中です",
    branchNameRequired: "ブランチ名を入力してください",
    invalidBranchName: (name: string) => `ブランチ名として使えません: ${name}`,
    remoteNotFound: (remote: string) => `リモートが見つかりません: ${remote}`,
    invalidUpstream: "追跡先が不正です",
    invalidStartPoint: "起点のコミットが不正です",
    branchExists: (name: string) => `ブランチ ${name} は既にあります`,
    branchNotFound: (name: string) => `ブランチ ${name} が見つかりません`,
    cannotCheckMerged: (name: string) =>
      `ブランチ ${name} の取り込みを確かめられません`,
    mainWorktreeUnknown: "リポジトリ本体の作業ツリーが分かりません",
    branchInMainWorktree: (name: string) =>
      `ブランチ ${name} はリポジトリ本体の作業ツリーで使用中なので、削除できません`,
    branchInWorktree: (name: string, worktreePath: string) =>
      `ブランチ ${name} は作業ツリー ${worktreePath} で使用中です`,
    /** 強制削除の確認で、画面がこの文の後ろに次の文をつなぐ。文末に句点を付けない */
    branchNotMerged: (name: string) =>
      `ブランチ ${name} には、どこにも取り込まれていないコミットがあります`,
    branchMoved: (name: string, shortSha: string) =>
      `ブランチ ${name} が確かめている間に ${shortSha} へ動いたので、削除をやめました`,
    cannotPullDetached: "ブランチにいないので pull できません",
    noRemotes: "リモートがありません",
    invalidRemoteBranch: "リモートのブランチの指定が不正です",
    trackingBranchNotFound: (trackingName: string) =>
      `${trackingName} が見つかりません`,
    trackingSourceUnknown: (trackingName: string) =>
      `${trackingName} がリモートのどのブランチか、fetch の設定から特定できません`,
    remoteDefaultUnknown: (remote: string) =>
      `リモート ${remote} の既定のブランチを確かめられないので、削除をやめました`,
    remoteDefaultBranch: (trackingName: string) =>
      `${trackingName} はリモートの既定のブランチなので消せません`,
  },
  /** リポジトリの探索と worktree の作成 */
  repo: {
    notADirectory: "指定されたパスはディレクトリではありません",
    pathNotFound: "指定されたパスが存在しません",
    worktreePathExists: (worktreePath: string) =>
      `作成先ディレクトリが既に存在します: ${worktreePath}（前回の worktree 削除の残骸の可能性があります。不要であれば削除してから再試行してください）`,
    branchUsedByWorktree: (branch: string, worktreePath: string) =>
      `ブランチ '${branch}' は既に別の worktree で使用中です: ${worktreePath}`,
  },
  /** 新しいタスク */
  task: {
    nameEmpty: "タスク名が空です",
    nameInvalid:
      "タスク名は英数字と . _ - / だけで書いてください (ブランチ名になります)",
    promptEmpty: "プロンプトが空です",
    promptSent: "最初の文を送りました",
    notSentAwaiting:
      "セッションが確認の応答を待っているため、最初の文を送っていません (セッションを開いて答えてから送ってください)",
    notSentTimeout:
      "claude の起動を確かめられなかったため、最初の文を送っていません",
    notSentUnsupported:
      "この環境では claude の起動を確かめられないため、最初の文を送っていません",
    notSentGone: "セッションが止められたため、最初の文を送っていません",
    sendFailed: (reason: string) => `最初の文の送信に失敗しました: ${reason}`,
  },
};
