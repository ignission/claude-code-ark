import type { Messages } from "../ja";

export const serverGit: Messages["serverGit"] = {
  sessionNotFound: "Session not found",
  run: {
    notFound: "git command not found",
    outputTooLarge: "git output is too large",
    timeout: "git timed out",
    notRepository: "Not a git repository",
    failed: (reason: string) => `git failed: ${reason}`,
    failedWithExitCode: (code: number | null) =>
      `git failed with exit code ${code}`,
  },
  view: {
    commitNotFound: "Commit not found",
    invalidCommit: "Invalid commit",
    invalidPath: "Invalid path",
    invalidDiffTarget: "Invalid diff target",
  },
  ops: {
    invalidRequest: "Invalid request",
    inProgress: "Another Git operation is in progress",
    branchNameRequired: "Enter a branch name",
    invalidBranchName: (name: string) => `Invalid branch name: ${name}`,
    remoteNotFound: (remote: string) => `Remote not found: ${remote}`,
    invalidUpstream: "Invalid upstream",
    invalidStartPoint: "Invalid start commit",
    branchExists: (name: string) => `Branch ${name} already exists`,
    branchNotFound: (name: string) => `Branch ${name} not found`,
    cannotCheckMerged: (name: string) =>
      `Couldn't check whether branch ${name} is merged`,
    mainWorktreeUnknown: "Couldn't determine the repository's main worktree",
    branchInMainWorktree: (name: string) =>
      `Branch ${name} is checked out in the repository's main worktree, so it can't be deleted`,
    branchInWorktree: (name: string, worktreePath: string) =>
      `Branch ${name} is checked out in worktree ${worktreePath}`,
    branchNotMerged: (name: string) =>
      `Branch ${name} has commits that aren't merged anywhere`,
    branchMoved: (name: string, shortSha: string) =>
      `Branch ${name} moved to ${shortSha} during the check, so it wasn't deleted`,
    cannotPullDetached: "Can't pull: not on a branch",
    noRemotes: "No remotes configured",
    invalidRemoteBranch: "Invalid remote branch",
    trackingBranchNotFound: (trackingName: string) =>
      `${trackingName} not found`,
    trackingSourceUnknown: (trackingName: string) =>
      `Couldn't tell from the fetch configuration which remote branch ${trackingName} tracks`,
    remoteDefaultUnknown: (remote: string) =>
      `Couldn't check the default branch of remote ${remote}, so nothing was deleted`,
    remoteDefaultBranch: (trackingName: string) =>
      `${trackingName} is the remote's default branch, so it can't be deleted`,
  },
  repo: {
    notADirectory: "The path is not a directory",
    pathNotFound: "The path does not exist",
    worktreePathExists: (worktreePath: string) =>
      `The target directory already exists: ${worktreePath} (it may be left over from a previous worktree removal; delete it if you don't need it, then try again)`,
    branchUsedByWorktree: (branch: string, worktreePath: string) =>
      `Branch '${branch}' is already checked out in another worktree: ${worktreePath}`,
  },
  task: {
    nameEmpty: "Task name is empty",
    nameInvalid:
      "Use only letters, digits, and . _ - / in the task name (it becomes the branch name)",
    promptEmpty: "Prompt is empty",
    promptSent: "Sent the first message",
    notSentAwaiting:
      "The session is waiting for a confirmation, so the first message wasn't sent (open the session, answer it, then send the message)",
    notSentTimeout:
      "Couldn't confirm that claude started, so the first message wasn't sent",
    notSentUnsupported:
      "Can't confirm that claude started in this environment, so the first message wasn't sent",
    notSentGone: "The session was stopped, so the first message wasn't sent",
    sendFailed: (reason: string) =>
      `Failed to send the first message: ${reason}`,
  },
};
