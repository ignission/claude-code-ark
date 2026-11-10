import type { Messages } from "../ja";
import { plural } from "../plural";

export const mobile: Messages["mobile"] = {
  list: {
    arkMenu: "Ark menu",
    manageScreens: "Manage screens",
    newTask: "New task",
    newSession: "New session",
  },
  layout: {
    back: "Back",
    screenSelect: "Screen to show",
    screenFallbackName: "Screen",
    manage: "Manage",
    tabsLabel: "Switch view",
    sessionTab: "Sessions",
    screenTab: "Screens",
  },
  quickActions: {
    attachFile: "Attach file",
    pasteImage: "Paste image",
    slashCommands: "Slash commands",
  },
  viewMode: {
    label: "View mode",
    chat: "Chat",
    board: "Board",
  },
  session: {
    unsupportedFile: "Unsupported file",
    readFailed: "Failed to read the file",
    clipboardNoImage: "No image in the clipboard",
    clipboardReadFailed: "Couldn't read the clipboard",
    uploadFailed: "Upload failed",
    copyTerminalBuffer: "Copy terminal buffer",
    reloadTerminal: "Reload terminal",
    terminalStarting: "Starting terminal...",
    sendFilesTitle: (count: number) =>
      `Send ${count} ${plural(count, "file", "files")}`,
    removeFile: "Remove this file",
    addMessagePlaceholder: "Add a message (optional)",
    sending: "Sending...",
    send: "Send",
    messagePlaceholder: "Type a message... (Enter to send)",
    backToList: "Back to list",
    moreActions: "More actions",
    restartSession: "Restart session",
    deleteSession: "Delete session",
    answerInChat: "Answer in chat",
    restartConfirmTitle: "Restart this session?",
    restartConfirmBody:
      "Restarting discards the Claude conversation history, running commands, and terminal contents. Continue?",
    restart: "Restart",
  },
};
