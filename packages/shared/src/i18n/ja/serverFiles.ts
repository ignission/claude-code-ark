export const serverFiles = {
  sessionNotFound: "セッションが見つかりません",
  invalidRequest: "不正なリクエストです",
  unmanagedWorktree: "管理対象の worktree ではありません",
  board: {
    pathEmpty: "図のパスが空です",
    pathTooLong: "図のパスが長すぎます",
    pathNotRelative: "図のパスは worktree 相対で指定してください",
    pathBadSuffix: (suffix: string) =>
      `図のパスは ${suffix} で終わる必要があります`,
    pathOutsideDir: (dir: string) =>
      `図のパスが worktree の ${dir} から出ています`,
    deletePathOutsideDir: (dir: string) =>
      `図ファイルは ${dir} 配下で指定してください`,
    notFound: "図ファイルが見つかりません",
    accessDenied: (code: string) =>
      `図ファイルへのアクセスが拒否されました (${code})`,
    identityUnverifiable: "図ファイルの実体を検証できません",
    realPathOutsideDir: (dir: string) =>
      `図ファイルの実体が worktree の ${dir} から出ています`,
    readFailed: (code: string, reason: string) =>
      `図ファイルの読み込みに失敗しました (${code}): ${reason}`,
    listFailed: (code: string, reason: string) =>
      `図一覧の取得に失敗しました (${code}): ${reason}`,
    worktreePathTooLong: "worktree のパスが長すぎます",
    symlinkUnverifiable:
      "この環境では symlink を安全に検証できないため図ファイルを削除できません",
    notRegularFile: "削除対象は通常ファイルではありません",
    changedBeforeDelete: "削除直前に図ファイルの実体が変化しました",
    deleteFailed: (reason: string) =>
      `図ファイルの削除に失敗しました: ${reason}`,
    deleteFailedWithCode: (code: string, reason: string) =>
      `図ファイルの削除に失敗しました (${code}): ${reason}`,
    gitStatusCheckFailed: (code: string, reason: string) =>
      `Git 管理状態の確認に失敗しました (${code}): ${reason}`,
    gitStatusChanged:
      "Git 管理状態が変化しました。一覧を更新して再確認してください",
    deletedButClearFailed: (reason: string) =>
      `ファイルは削除済みですが復元情報の消去に失敗しました: ${reason}`,
  },
  file: {
    accessDenied: "ファイルへのアクセスが拒否されました",
    notFound: (filePath: string) => `ファイルが見つかりません: ${filePath}`,
    notAFile: (filePath: string) => `ファイルではありません: ${filePath}`,
    notADirectory: (dirPath: string) =>
      `ディレクトリではありません: ${dirPath}`,
    tooLarge: (maxMb: number, bytes: number) =>
      `ファイルサイズが上限（${maxMb}MB）を超えています: ${bytes} bytes`,
    writeOutsideWorktree: "書き込めるのは worktree 内のファイルだけです",
    writeInsideGitDir: ".git 配下には書き込めません",
    modifiedSinceRead: "ファイルが読み込み後に変更されています",
    notTextFile: "テキストファイル以外には書き込めません",
    notUtf8: "UTF-8 (BOM なし) 以外のファイルには書き込めません",
    editTooLarge: (maxMb: number) => `サイズが上限（${maxMb}MB）を超えています`,
  },
  upload: {
    invalidSessionId: "無効なセッションIDです",
    invalidMimeType: (mimeType: string) =>
      `許可されていないファイル形式です: ${mimeType}`,
    tooLarge: (sizeMb: string) =>
      `ファイルサイズが上限（10MB）を超えています: ${sizeMb}MB`,
    saveFailed: (reason: string) => `ファイルの保存に失敗しました: ${reason}`,
  },
  fsBrowser: {
    pathNotAbsolute: "pathは絶対パスのみ指定可能",
    notFound: "ディレクトリが存在しません",
    permissionDenied: "権限がありません",
    notADirectory: "ディレクトリではありません",
  },
  screenshot: {
    chromiumLaunchFailed: (reason: string) =>
      `Chromium 起動失敗: ${reason}。Playwright Chromium がインストールされていない可能性があります (pnpm exec playwright install chromium-headless-shell)`,
  },
  shortcut: {
    messageNotString: "message は文字列で指定してください",
    messageEmpty: "message は空にできません",
    messageTooLong: (max: number) =>
      `message は ${max} 文字以内で指定してください`,
    sortOrderNotInteger: "sortOrder は整数で指定してください",
  },
  todo: {
    notFound: "TODO が見つかりません",
  },
};
