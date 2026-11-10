import type { Messages } from "../ja";

export const dialogs: Messages["dialogs"] = {
  about: {
    description:
      "A web UI for managing multiple Claude Code sessions running locally.",
    thisMachine: "This machine",
    bundledComponents: "Bundled components",
    licensesLoadFailed: (reason: string) =>
      `Failed to load licenses: ${reason}`,
    notPackaged: "Bundled binaries are not packaged in this build.",
    noComponents: "No bundled components registered.",
    licenseUnavailable: "(LICENSE file not available)",
  },
  claudeInstall: {
    title: "Claude CLI setup",
    idle: "Waiting",
    checking: "Checking whether Claude CLI is installed...",
    alreadyInstalled: (path: string) =>
      `Claude CLI is already installed: ${path}`,
    installing: "Installing Claude CLI...",
    completed: (path: string) => `Installation complete: ${path}`,
    failed: (error: string) => `Installation failed: ${error}`,
  },
  folderBrowser: {
    title: "Select folder",
    description:
      'Browse to the folder you want, open it, then choose "Select this folder".',
    currentPath: "Current path",
    goToParent: "Go to parent directory",
    reload: "Reload",
    loading: "Loading…",
    hiddenOnly:
      "Only hidden folders here. Use the checkbox below to show them.",
    noSubfolders: "No subfolders",
    showHidden: "Show hidden folders",
    selectThisFolder: "Select this folder",
  },
  newTask: {
    title: "New task",
    descriptionWithParent: (parent: string) =>
      `Branches a new worktree off ${parent}, starts a session, and sends the prompt as the first message.`,
    description:
      "Starts a session in a new worktree and sends the prompt as the first message.",
    repository: "Repository",
    taskName: "Task name",
    prompt: "Prompt",
    promptPlaceholder: "First message to send",
    baseBranch: "Base branch (optional)",
    parentBranchPlaceholder: "Parent's current branch",
    defaultBranchPlaceholder: "Repository's default branch",
    starting: "Starting...",
    start: "Start",
  },
  profile: {
    title: "Profiles",
    description:
      "Use a separate Claude CLI config directory (CLAUDE_CONFIG_DIR) for each repository.",
    linuxOnly: "Linux only",
    unavailableOnOtherOs: "Not available on macOS or Windows",
    registered: (count: number) => `Profiles (${count})`,
    add: "Add",
    empty: "No profiles yet.",
    edit: "Edit",
    deleteTitle: "Delete this profile?",
    deleteDescription: (name: string) =>
      `Deletes "${name}". Repositories linked to this profile will be unlinked. The config directory itself is not deleted.`,
    addTitle: "New profile",
    editTitle: "Edit profile",
    name: "Name",
    namePlaceholder: "e.g. Work Max",
    nameHint: "Shown on the dashboard",
    configDir: "Config directory",
    configDirHint:
      "Where settings are stored. Use a different directory for each profile.",
    loginNotice:
      "After you add it, starting a session in a repository linked to this profile brings up the claude CLI login screen automatically.",
    submitAdd: "Add",
    nameRequired: "Enter a name",
    configDirRequired: "Enter a config directory",
    absolutePathRequired: "Enter an absolute path starting with / or ~/",
  },
  repoSelect: {
    title: "Select repository",
    descriptionAllowlist:
      "Pick one of the allowed repositories or enter a repository path.",
    descriptionScan: "Choose a folder to scan or enter a repository path.",
    scanPath: "Path to scan",
    chooseFolder: "Choose a folder...",
    allowedRepos: (shown: number, total: number) =>
      `Allowed repositories (${shown}/${total})`,
    scanning: "Scanning...",
    foundReposCount: (shown: number, total: number) =>
      `Repositories found (${shown}/${total})`,
    foundRepos: "Repositories found",
    searchPlaceholder: "Search repositories...",
    pathInputLabel: "Or enter a path",
    select: "Select",
    folderBrowserTitle: "Choose a folder to scan",
    folderBrowserDescription: "Scans for Git repositories under this folder.",
  },
  createWorktree: {
    title: "Create New Worktree",
    description: "Create a new git worktree with a new branch.",
    branchName: "Branch Name",
    baseBranch: "Base Branch (optional)",
    worktreePath: "Worktree Path (auto-generated)",
    submit: "Create Worktree",
  },
};
