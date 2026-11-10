import type { Messages } from "../ja";
import { plural } from "../plural";

const draftSuffix = (isDraft: boolean) => (isDraft ? " (draft)" : "");

export const session: Messages["session"] = {
  actions: {
    deleteSession: "Delete session",
    deleteWorktree: "Delete worktree",
    restart: "Restart",
    copy: "Copy",
  },
  status: {
    awaiting: "Needs response",
    error: "Problem",
    idle: "Waiting for input",
    working: "Working",
    ready: "Ready",
    stopped: "Stopped",
    notStarted: "Not started",
  },
  sections: {
    yourTurn: "Your turn",
    working: "Working",
    resting: "Inactive",
  },
  strip: {
    disconnected: "Not connected to the server",
    question: "Has a question for you",
    confirmation: "Waiting for your confirmation",
    thinking: "Thinking",
    working: "Working",
    error: "Something went wrong",
  },
  pr: {
    mergedText: (pr: string) => `${pr} merged`,
    mergedLabel: (pr: string) => `PR ${pr} is merged`,
    closedText: (pr: string) => `${pr} closed`,
    closedLabel: (pr: string) => `PR ${pr} is closed`,
    pendingText: (pr: string) => `${pr} pending`,
    checksFailedLabel: (pr: string, isDraft: boolean) =>
      `PR ${pr}${draftSuffix(isDraft)}: checks failed`,
    checksPendingLabel: (pr: string, isDraft: boolean) =>
      `PR ${pr}${draftSuffix(isDraft)}: checks running`,
    checksPassedLabel: (pr: string, isDraft: boolean) =>
      `PR ${pr}${draftSuffix(isDraft)}: checks passed`,
    noChecksLabel: (pr: string, isDraft: boolean) =>
      `PR ${pr}${draftSuffix(isDraft)}: no checks`,
  },
  planLimits: {
    weekShort: "wk",
    fiveHourName: "5-hour limit",
    weekName: "Weekly limit",
    summary: rows =>
      rows
        .map(
          r =>
            `${r.name} ${r.percent}%${r.resetAt ? ` (resets ${r.resetAt})` : ""}`
        )
        .join(", "),
    ariaLabel: (summary: string) => `Plan usage: ${summary}`,
  },
  contextUsage: {
    label: (tokens: string, window: string, percent: number) =>
      `Context: ${tokens} / ${window} tokens (${percent}%). The limit is an estimate.`,
  },
  browserNotifications: {
    granted: "Browser notifications are allowed",
    denied: "Browser notifications are blocked in your browser settings",
    enable: "Enable browser notifications",
  },
  notifications: {
    awaitingTitle: "Ark: Waiting for your decision",
    awaitingBody: (sessionLabel: string) =>
      `${sessionLabel} needs a permission approval`,
    questionTitle: "Ark: Question for you",
    questionBody: (sessionLabel: string) =>
      `${sessionLabel} is waiting for your answer`,
    completedTitle: "Ark: Work finished",
    completedBody: (sessionLabel: string) =>
      `${sessionLabel} has stopped running`,
    ciFailedTitle: "Ark: CI failed",
    ciFailedBody: (sessionLabel: string, prNumber: number | string) =>
      `Checks failed on PR #${prNumber} of ${sessionLabel}`,
  },
  header: {
    moreActions: "More actions",
    hideInputBar: "Hide input bar",
    showInputBar: "Show input bar",
    muteSession: "Turn off notifications for this session",
    unmuteSession: "Turn on notifications for this session",
    deleteConfirm: "Delete this session?",
    deleteConfirmKeepMain:
      "Delete this session? The main worktree will be kept.",
    deleteConfirmWithWorktree:
      "Delete this session and its worktree? The associated branch will also be deleted.",
  },
  row: {
    editDisplayName: "Edit display name",
    parentTitle: (parent: string) => `Parent: ${parent}`,
    openParentLabel: (parent: string) => `Open parent ${parent}`,
    individualProfile: "custom",
    childTasks: (count: number) =>
      `${count} child ${plural(count, "task", "tasks")}`,
    openTodos: (count: number) =>
      `${count} open ${plural(count, "TODO", "TODOs")}`,
    menuLabel: (name: string, branch: string | null | undefined) =>
      branch ? `Menu for ${name} (${branch})` : `Menu for ${name}`,
    staleProfile: "Outdated profile",
    staleProfileHint:
      "The profile assignment has changed. This session is still running with the previous one.",
  },
  menu: {
    open: "Open",
    startSession: "Start session",
    splitTask: "Split off a child task...",
    openParent: "Open parent",
    rename: "Rename",
    muteNotifications: "Turn off notifications",
    unmuteNotifications: "Turn on notifications",
    worktreeProfile: "Profile for this worktree",
    inheritRepoProfile: (profileName: string | null) =>
      `Inherit from repository (${profileName ?? "default"})`,
    repository: "Repository",
    newWorktree: "New worktree",
    openRepoGrid: "View all sessions in this repository side by side",
    repoDefaultProfile: "Default profile for repository",
    defaultProfile: "Default (~/.claude)",
    removeFromSidebar: "Remove from sidebar",
    openProfileManager: "Manage profiles...",
  },
  list: {
    empty: "No sessions",
    emptyHint: "Create one with “+”",
    repoEmpty: "No sessions in this repository yet",
    deleteWorktreeConfirm:
      "Delete this worktree? The associated branch will also be deleted.",
    restartConfirmTitle: "Restart this session?",
    restartConfirmBody:
      "Restarting discards the Claude conversation history, any running commands, and the terminal contents. Continue?",
    removeRepoTitle: "Remove repository from sidebar",
    removeRepoBody: (repoName: string) =>
      `“${repoName}” will be hidden from the sidebar. Its worktrees, sessions, and the repository itself are not deleted. Select the repository again to bring it back.`,
    removeRepoAction: "Remove",
  },
  sidebar: {
    arkMenu: "Ark menu",
    newTask: "New task",
    newSession: "New session",
    screens: "Screens",
    manageScreens: "Manage screens...",
    openBridge: "Open Bridge in a new tab",
  },
  update: {
    available: "A new version is available",
    changelog: "Changelog",
    newBuildTitle: "A new build is available",
    newBuildDescription:
      "Not reloaded automatically because you have unsent input",
    reload: "Reload",
  },
  socket: {
    disconnected: "Socket is disconnected",
    notConnected: "Not connected to the server. Try again in a moment.",
    shortcutFailed: (message: string) => `Shortcut action failed: ${message}`,
    usageStarted: "Fetching usage. This takes a few dozen seconds.",
    usageDone: (okCount: number, total: number) =>
      `Usage fetched: ${okCount}/${total} ${plural(total, "profile", "profiles")}`,
    usageFailed: (message: string) => `Couldn't fetch usage: ${message}`,
    listDirectoryTimeout: "Timed out listing the directory",
    listDirectoryFailed: "Failed to list the directory",
    listDiagramsTimeout: "Timed out listing boards",
    taskStartTimeout: "Timed out starting the task",
    uploadTimeout: "Upload timed out",
  },
  dashboard: {
    worktreeDeleted: "Worktree deleted",
    worktreeDeleting: "Deleting worktree...",
    sessionDeleted: "Session deleted",
    sessionStopped: "Session stopped",
    taskStarted: (branch: string) => `Task started: ${branch}`,
    emptyHint: "Create a session with “+” in the sidebar",
    tunnelSelectPort: "Select a port to expose",
    tunnelPortPlaceholder: "Select a port...",
    tunnelPortInput: "Or enter a port number",
    tunnelUrlDescription: "Use this URL to access it from outside",
    sessionCount: (count: number) =>
      `${count} ${plural(count, "session", "sessions")}`,
    tunnelPort: "Port",
    tunnelStart: "Start tunnel",
    tunnelStop: "Stop tunnel",
    tunnelAuthToken: "Auth token",
    cannotDeleteMainWorktree: "Can't delete the main worktree",
  },
};
