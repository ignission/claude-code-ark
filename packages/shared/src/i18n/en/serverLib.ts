import type { Messages } from "../ja";

export const serverLib: Messages["serverLib"] = {
  slashCommands: {
    clear: "Clear the conversation history",
    compact: "Summarize the history to shorten it",
    help: "Show help",
    init: "Create CLAUDE.md",
    review: "Review a PR",
    installGithubApp: "Set up the GitHub App",
    login: "Log in to your Anthropic account",
    logout: "Log out",
    config: "View or edit settings",
    cost: "Show the cost of this session",
    model: "Switch the model",
    permissions: "View or change permissions",
    resume: "Resume a previous session",
  },
  tmuxRead: {
    noSession: "Session ID is not managed by TmuxManager",
    tmuxFailed: (command, parts, detail) =>
      `tmux ${command} failed (${parts})${detail ? `: ${detail}` : ""}`,
    notSet: "Variable is not set",
    noBuffer: "No tmux paste buffer",
    invalidPanePid: raw => `Could not parse pane_pid: ${raw}`,
    procError: (code, message) => `Failed to read /proc (${code}): ${message}`,
    unsupportedPlatform: platform =>
      `Reading the pane environ is Linux only (platform=${platform})`,
  },
  tmux: {
    specialKeyNotAllowed: key => `Special key not allowed: ${key}`,
  },
  screenInput: {
    nameRequired: "Enter a name",
    invalidHost: kind => `${kind} host must be a hostname or an IP address`,
    invalidSshUser: "Invalid SSH username",
    invalidPort: kind => `${kind} port must be an integer from 1 to 65535`,
    vncPasswordRequired: "Enter the VNC password",
    invalidInput: "Invalid input",
    duplicateName: "A screen with the same name already exists",
  },
  usage: {
    launchSendFailed: stderr =>
      `Failed to send the claude launch command (stderr: ${stderr})`,
    launchNotDetected: "Could not detect that the claude CLI started",
    usageSendFailed: "Failed to send /usage",
    usageResultTimeout: "The /usage result did not appear in time",
    usageParseFailed: "Failed to parse the /usage output",
  },
};
