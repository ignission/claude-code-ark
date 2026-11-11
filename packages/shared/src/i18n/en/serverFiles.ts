import type { Messages } from "../ja";

export const serverFiles: Messages["serverFiles"] = {
  sessionNotFound: "Session not found",
  invalidRequest: "Invalid request",
  unmanagedWorktree: "Not a managed worktree",
  board: {
    pathEmpty: "The board path is empty",
    pathTooLong: "The board path is too long",
    pathNotRelative: "The board path must be relative to the worktree",
    pathBadSuffix: (suffix: string) => `The board path must end with ${suffix}`,
    pathOutsideDir: (dir: string) =>
      `The board path is outside ${dir} in the worktree`,
    deletePathOutsideDir: (dir: string) => `Board files must be under ${dir}`,
    notFound: "Board file not found",
    accessDenied: (code: string) =>
      `Access to the board file was denied (${code})`,
    identityUnverifiable: "Could not verify the board file",
    realPathOutsideDir: (dir: string) =>
      `The board file resolves outside ${dir} in the worktree`,
    readFailed: (code: string, reason: string) =>
      `Failed to read the board file (${code}): ${reason}`,
    listFailed: (code: string, reason: string) =>
      `Failed to list boards (${code}): ${reason}`,
    worktreePathTooLong: "The worktree path is too long",
    symlinkUnverifiable:
      "Cannot delete the board file because symlinks cannot be verified safely in this environment",
    notRegularFile: "The delete target is not a regular file",
    changedBeforeDelete: "The board file changed just before deletion",
    deleteFailed: (reason: string) =>
      `Failed to delete the board file: ${reason}`,
    deleteFailedWithCode: (code: string, reason: string) =>
      `Failed to delete the board file (${code}): ${reason}`,
    gitStatusCheckFailed: (code: string, reason: string) =>
      `Failed to check the Git tracking status (${code}): ${reason}`,
    gitStatusChanged:
      "The Git tracking status changed. Refresh the list and check again",
    deletedButClearFailed: (reason: string) =>
      `The file was deleted, but clearing the restore info failed: ${reason}`,
  },
  file: {
    accessDenied: "Access to the file was denied",
    notFound: (filePath: string) => `File not found: ${filePath}`,
    notAFile: (filePath: string) => `Not a file: ${filePath}`,
    notADirectory: (dirPath: string) => `Not a directory: ${dirPath}`,
    tooLarge: (maxMb: number, bytes: number) =>
      `The file exceeds the size limit (${maxMb}MB): ${bytes} bytes`,
    writeOutsideWorktree: "Only files inside the worktree can be written",
    writeInsideGitDir: "Cannot write under .git",
    modifiedSinceRead: "The file was modified after it was loaded",
    notTextFile: "Only text files can be written",
    notUtf8: "Only UTF-8 (no BOM) files can be written",
    editTooLarge: (maxMb: number) => `The size exceeds the limit (${maxMb}MB)`,
  },
  upload: {
    invalidSessionId: "Invalid session ID",
    invalidMimeType: (mimeType: string) => `File type not allowed: ${mimeType}`,
    tooLarge: (sizeMb: string) =>
      `The file exceeds the size limit (20MB): ${sizeMb}MB`,
    saveFailed: (reason: string) => `Failed to save the file: ${reason}`,
  },
  fsBrowser: {
    pathNotAbsolute: "path must be an absolute path",
    notFound: "Directory not found",
    permissionDenied: "Permission denied",
    notADirectory: "Not a directory",
  },
  screenshot: {
    chromiumLaunchFailed: (reason: string) =>
      `Failed to launch Chromium: ${reason}. Playwright Chromium may not be installed (pnpm exec playwright install chromium-headless-shell)`,
  },
  shortcut: {
    messageNotString: "message must be a string",
    messageEmpty: "message cannot be empty",
    messageTooLong: (max: number) =>
      `message must be ${max} characters or fewer`,
    sortOrderNotInteger: "sortOrder must be an integer",
  },
  todo: {
    notFound: "TODO not found",
  },
};
