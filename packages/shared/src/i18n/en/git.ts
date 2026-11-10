import type { Messages } from "../ja";
import { plural } from "../plural";

export const git: Messages["git"] = {
  loading: "Loading…",
  loadingLabel: "Loading",
  retry: "Retry",
  connecting: "Connecting…",
  noResponse: "No response from the server",
  uncommittedChanges: "Uncommitted changes",

  time: {
    justNow: "just now",
    minutesAgo: (minutes: number) =>
      `${minutes} ${plural(minutes, "minute", "minutes")} ago`,
    hoursAgo: (hours: number) =>
      `${hours} ${plural(hours, "hour", "hours")} ago`,
    yesterday: "yesterday",
    daysAgo: (days: number) => `${days} ${plural(days, "day", "days")} ago`,
  },

  fileStatus: {
    added: "Added",
    modified: "Modified",
    deleted: "Deleted",
    renamed: "Renamed",
    copied: "Copied",
    typeChanged: "Type changed",
    conflicted: "Conflicted",
    untracked: "Untracked",
  },

  detail: {
    binary: "Binary",
    groupStaged: "Staged",
    groupUnstaged: "Unstaged",
    groupUntracked: "Untracked",
    empty: "Select a commit to see its details",
    tabCommit: "Commit",
    tabChanges: "Changes",
    tabChangesCount: (count: number) => `Changes ${count}`,
    noUncommittedChanges: "No uncommitted changes",
    noChanges: "No changes",
    changedFiles: "Changed files",
    binaryFile: "Binary file",
    tooLarge: "Too large to display",
    tabsLabel: "Detail view",
    deletedFileCannotOpen: "Deleted files can't be opened",
    openInFilesTab: "Open in the Files tab",
    openInFiles: "Open in Files",
    copyHash: "Copy hash",
    copied: "Copied",
    committer: "Committer",
    hash: "Hash",
    parents: "Parents",
    noParents: "None (root commit)",
  },

  list: {
    filterPlaceholder: "Filter by subject, author, or hash",
    filterLabel: "Filter commits",
    matchCount: (count: number) =>
      `${count} ${plural(count, "match", "matches")}`,
    clearFilter: "Clear filter",
    reload: "Reload",
    commitsLabel: "Commits",
    noMatches: "No matching commits",
    noCommits: "No commits",
    uncommittedChangesCount: (count: number) =>
      `Uncommitted changes (${count})`,
    createBranchHere: "Create branch here",
    loadMoreFailed: "Couldn't load more commits",
    loadMore: "Load more",
  },

  pane: {
    openSidebar: "Open sidebar",
    collapseSidebar: "Collapse sidebar",
    resizeHandle: "Resize the list and details",
    fetchTitle: "fetch (all remotes)",
    pullTitle: (branch: string) => `pull: fast-forward ${branch}`,
    pullDisabled: "Can't pull: not on a branch",
    pushTitle: (branch: string, upstream: string | undefined) =>
      `push: ${branch}${upstream ? ` → ${upstream}` : " (creates a new upstream)"}`,
    pushDisabled: "Can't push: not on a branch",
  },

  refs: {
    currentBranchTitle: (name: string) => `${name} (current branch)`,
  },

  sidebar: {
    navLabel: "Git refs",
    changes: (count: number) => (count > 0 ? `Changes (${count})` : "Changes"),
    allCommits: "All commits",
    branches: "Branches",
    remotes: "Remotes",
    tags: "Tags",
    stashes: "Stashes",
    currentBranch: "Current branch",
    mainWorktreeBlocked:
      "Can't delete: checked out in the repository's main worktree",
    newBranchHere: "New branch from here",
    rename: "Rename",
    pushNew: "new",
    deleteWithWorktree: "Delete with worktree",
    thisSessionWorktree: "This session's worktree",
    inUseAt: (worktreePath: string) => `In use: ${worktreePath}`,
    deleteFromRemote: "Delete from remote",
    defaultBranchBlocked: "The remote's default branch can't be deleted",
    unknownRemote: (remote: string) =>
      `Remote ${remote} isn't in the Git config`,
  },

  ops: {
    failed: "Operation failed",
    branchRestored: (name: string) => `Restored branch ${name}`,
    branchDeleted: (name: string) => `Deleted branch ${name}`,
    branchDeletedWithWorktree: (name: string) =>
      `Deleted branch ${name} and its worktree`,
    undoRestoresBranchOnly: (sha: string) =>
      `${sha} (Undo restores only the branch)`,
    undo: "Undo",
    pushed: (name: string) => `Pushed ${name}`,
    fetched: "Fetched",
    pulled: (name: string) => `Pulled ${name}`,
    nameRequired: "Enter a branch name",
    branchCreated: (name: string) => `Created branch ${name}`,
    branchRenamed: (from: string, to: string) => `Renamed ${from} to ${to}`,
    remoteBranchDeleted: (trackingName: string) =>
      `Deleted ${trackingName} from the remote`,
    renameTitle: "Rename branch",
    createTitle: "New branch",
    renameDescription: (from: string) => `New name for ${from}`,
    createDescription: (sha: string) =>
      `Creates the branch at ${sha} without checking it out`,
    branchName: "Branch name",
    renameSubmit: "Rename",
    createSubmit: "Create",
    confirmRemoteDeleteTitle: (trackingName: string) =>
      `Delete ${trackingName} from the remote?`,
    confirmWorktreeDeleteTitle: (name: string) =>
      `Delete ${name} and its worktree?`,
    confirmForceDeleteTitle: (name: string) => `Force delete ${name}?`,
    confirmRemoteDeleteDescription: (remote: string) =>
      `This deletes the branch from remote ${remote}. Anyone else using this remote will no longer see it.`,
    confirmWorktreeDeleteDescription: (
      worktreePath: string,
      isCurrentSession: boolean,
      notMerged: boolean
    ) =>
      [
        `This removes the worktree ${worktreePath} and stops `,
        isCurrentSession ? "this session." : "the session running there.",
        " Uncommitted changes will be lost.",
        notMerged
          ? " Some commits aren't merged anywhere. Right after deleting, Undo can restore the branch."
          : "",
      ].join(""),
    confirmForceDeleteDescription: (reason: string) =>
      `${reason}. Deleting the branch leaves these commits unreachable from any branch. Right after deleting, Undo can restore it.`,
  },
};
