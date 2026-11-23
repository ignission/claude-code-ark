import type { Messages } from "../ja";

export const server: Messages["server"] = {
  sessionNotFound: "Session not found",
  idRequired: "id is required",
  invalidPayload: "Invalid payload",
  terminalStartFailed: reason => `Failed to start the terminal: ${reason}`,
  folderBrowseDisabled:
    "Folder browsing is disabled because this server only allows the listed repositories",
  repoNotSpecified: "No repository specified",
  sessionDeletedButWorktreeRemoveFailed: reason =>
    `Session deleted, but failed to remove the worktree: ${reason}`,
  diagram: {
    paramsRequired: "worktreePath and path are required",
    unmanagedWorktree: "This worktree is not managed by Ark",
  },
  copy: {
    bufferEmpty: "The buffer is empty",
    bufferUnavailable: reason => `Failed to read the tmux buffer: ${reason}`,
  },
  fileUpload: {
    invalidSessionId: "Invalid session ID",
    failed: "Failed to upload the file",
  },
  fileRead: {
    tooManyRequests: "Too many requests",
    validSessionRequired: "A valid session is required",
    invalidPath: "Invalid path",
  },
  shortcut: {
    messageLength: max => `message must be 1 to ${max} characters long`,
    sortOrderNotInteger: "sortOrder must be an integer",
    emptyPatch: "Specify at least one field to update",
  },
};
