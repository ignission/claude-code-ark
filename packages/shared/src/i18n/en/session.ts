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
    rested: "Inactive",
  },
  tabs: {
    list: "Open sessions",
    close: (name: string) => `Close the ${name} tab`,
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
  header: {
    moreActions: "More actions",
    hideInputBar: "Hide input bar",
    showInputBar: "Show input bar",
    deleteConfirm: "Delete this session?",
    deleteConfirmKeepMain:
      "Delete this session? The main worktree will be kept.",
    deleteConfirmWithWorktree:
      "Delete this session and its worktree? The associated branch will also be deleted.",
  },
  row: {
    editDisplayName: "Edit display name",
    openTodos: (count: number) =>
      `${count} open ${plural(count, "TODO", "TODOs")}`,
    menuLabel: (name: string, branch: string | null | undefined) =>
      branch ? `Menu for ${name} (${branch})` : `Menu for ${name}`,
  },
  menu: {
    open: "Open",
    startSession: "Start session",
    splitTask: "Split off a child task...",
    rename: "Rename",
    rest: "Move to resting",
    unrest: "Move back from resting",
  },
  repoMenu: {
    label: (repoName: string) => `Menu for ${repoName}`,
    newTask: "New task...",
    newTaskLabel: (repoName: string) => `New task in ${repoName}`,
    setHome: "Set main as home",
    newWorktree: "New worktree",
    openRepoGrid: "View all sessions in this repository side by side",
    removeFromSidebar: "Remove from sidebar",
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
    reorderRepo: (repoName: string) => `Move ${repoName} (drag or arrow keys)`,
  },
  /** ホーム (入口にするセッション。決まりは web の lib/home-session.ts) */
  home: {
    label: "Home",
    unset: "Unset home",
    back: "Back to home",
    menu: "Home menu",
    notRunning: "Not running (tap to start)",
    worktreeMissing:
      "The home worktree was not found. Add its repository to the list, or unset home",
  },
  sidebar: {
    arkMenu: "Ark menu",
    newTask: "New task",
    newSession: "New session",
    screens: "Screens",
    manageScreens: "Manage screens...",
    openBridge: "Open Bridge in a new tab",
    collapse: "Collapse sidebar",
    expand: "Expand sidebar",
    yourTurnCount: (count: number) => `Your turn: ${count}`,
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
    copiedToClipboard: "Copied to clipboard",
    creatingWorktree: branch => `Creating worktree: ${branch}`,
    sessionStarted: "Session started",
    connectFailed: "Failed to connect to the server",
    scanFailed: "Failed to scan repositories",
  },
};
