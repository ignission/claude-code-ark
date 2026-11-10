export const server = {
  sessionNotFound: "セッションが見つかりません",
  idRequired: "id は必須です",
  invalidPayload: "payload が不正です",
  terminalStartFailed: (reason: string) =>
    `ターミナルの起動に失敗しました: ${reason}`,
  folderBrowseDisabled:
    "このサーバーでは許可リポジトリのみ利用可能なためフォルダ参照は無効です",
  repoNotSpecified: "リポジトリが指定されていません",
  sessionDeletedButWorktreeRemoveFailed: (reason: string) =>
    `セッションは削除しましたが、Worktreeの削除に失敗しました: ${reason}`,
  diagram: {
    paramsRequired: "worktreePath と path が必要です",
    unmanagedWorktree: "管理外の worktree です",
  },
  copy: {
    bufferEmpty: "バッファが空です",
    bufferUnavailable: (reason: string) =>
      `tmux バッファを取得できません: ${reason}`,
  },
  fileUpload: {
    invalidSessionId: "無効なセッションIDです",
    failed: "ファイルのアップロードに失敗しました",
  },
  fileRead: {
    tooManyRequests: "リクエストが多すぎます",
    validSessionRequired: "有効なセッションが必要です",
    invalidPath: "不正なパスです",
  },
  profile: {
    unsupported: "プロファイル切替機能は Linux + claude CLI 必須です",
    configDirRequired: "configDir は必須です",
    configDirNotAbsolute: "configDir は絶対パスで指定してください",
    configDirInvalidChars: "configDir に使用できない文字が含まれています",
    configDirForbidden: (forbiddenPath: string) =>
      `configDir に禁止パス (${forbiddenPath}) は使用できません`,
    nameRequired: "name は必須です",
    nameEmpty: "name は空にできません",
    repoPathRequired: "repoPath は必須です",
    repoPathUnresolvable: "リポジトリパスが解決できません",
    repoNotAllowed: "リポジトリが許可リストに含まれていません",
    notGitRepository: "リポジトリパスが有効なgitリポジトリではありません",
    worktreePathRequired: "worktreePath は必須です",
    worktreePathUnresolvable: "worktreeパスが解決できません",
    notGitWorkingTree: "worktreeパスがgit working treeではありません",
  },
  shortcut: {
    messageLength: (max: number) =>
      `message は 1〜${max} 文字で入力してください`,
    sortOrderNotInteger: "sortOrder は整数で指定してください",
    emptyPatch: "更新する項目を指定してください",
  },
  usage: {
    unavailable: "この環境ではプロファイル機能が使えません",
    inProgress: "Usage取得が既に進行中です",
    defaultProfileName: "デフォルト",
    noProfiles: "プロファイルが登録されていません",
  },
};
