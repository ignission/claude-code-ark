import type { Messages } from "../ja";
import { plural } from "../plural";

export const chat: Messages["chat"] = {
  send: "Send",
  sending: "Sending",
  composer: {
    message: "Message",
    placeholderMobile: "Type a message",
    placeholder: "Type a message (Enter to send, Shift+Enter for a new line)",
    placeholderWithUpload:
      "Type a message (Enter to send, Shift+Enter for a new line; drop or paste images)",
    attachFile: "Attach files",
    attachFileHint: "Attach files (or drop or paste them)",
    quickActionHint: (label: string) => `${label} (applies to your draft)`,
    dropHere: "Drop here",
    unsupportedFile: (name: string) => `${name}: unsupported file`,
    uploadFailed: (name: string, reason: string) =>
      `${name}: upload failed (${reason})`,
    clipboardNoImage: "No image on the clipboard",
    clipboardReadFailed: "Couldn't read the clipboard",
    scrollToLatest: "Jump to latest",
  },
  messages: {
    claudeWorking: "Claude is working",
    thinking: "Thinking",
    working: "Working",
    openTerminal: "Open terminal",
    fileNotFound: "File not found",
    externalImageBlocked:
      "External images from model output aren't loaded automatically",
    image: "Image",
    compacted: "Conversation compacted (/compact)",
    questionCancelled: "Question cancelled",
    questionAnswered: "Answer",
    running: "Running:",
    statusCompleted: "Done",
    statusFailed: "Failed",
    statusKilled: "Stopped",
    taskNotification: "Task notification",
    system: "System",
    toolCalls: (count: number) =>
      `${count} ${plural(count, "tool call", "tool calls")}`,
    subagent: (count: number) =>
      `Subagent (${count} ${plural(count, "event", "events")})`,
    noHistory: "No history in this session yet",
  },
  awaiting: {
    title: "Claude is waiting for your input",
    sendDigit: (digit: string) => `Send ${digit} (jump to or toggle an option)`,
    focusUp: "Move focus up",
    focusDown: "Move focus down",
    nextTab: "Next tab / go to Submit",
    toggleCheck: "Toggle the checkbox",
    selectFocused: "Select or confirm the focused item",
    freeText: "Free text",
    freeTextPlaceholder:
      "Free text: press the number for Type something first, then type (Enter to confirm)",
    submitFreeText: "Type and confirm",
  },
  terminal: {
    title: "Terminal",
    close: "Close terminal",
    copyBuffer: "Copy terminal buffer",
    reload: "Reload terminal",
    bufferCopied: "Terminal buffer copied",
    nothingToCopy: "Nothing to copy",
    copyBufferFailed: "Couldn't copy the buffer",
    starting: "Starting the terminal",
  },
  panel: {
    label: "Panel",
    open: "Open panel",
    close: "Close panel",
    views: "Panel views",
    resize: "Resize panes",
    tabBoard: "Board",
    tabFiles: "Files",
  },
  viewer: {
    diagram: "Board",
  },
  upload: {
    tooLarge: (name: string, sizeMb: string) =>
      `${name}: larger than 10 MB (${sizeMb} MB)`,
    unsupportedType: (name: string, mime: string) =>
      `${name}: unsupported file type (${mime})`,
    unsupportedFile: "Unsupported file",
    readFailed: (name: string) => `${name}: failed to read the file`,
    uploadFailed: "Upload failed",
    dropToSend: "Drop files to send",
    sendFilesTitle: (count: number) =>
      `Send ${count} ${plural(count, "file", "files")}`,
    removeFile: "Remove this file",
    messagePlaceholder: "Add a message (optional)",
    sendingButton: "Sending...",
  },
  shortcuts: {
    title: "Message shortcuts",
    buttonLabel: "Message shortcuts",
    description:
      "Selecting a shortcut sends it to the session right away. Multiple lines are allowed, and Enter is pressed at the end.",
    empty: "No shortcuts yet. Add one with the form below.",
    bodyPlaceholder:
      "Message to send (1–4000 characters, multiple lines allowed)",
    addHeading: "New shortcut",
    newPlaceholder: "Message to send (e.g. How is the current task going?)",
    add: "Add",
    deleteTitle: "Delete shortcut",
    deleteConfirm: (preview: string) => `Delete "${preview}"?`,
    deleteConfirmGeneric: "Delete this shortcut?",
    none: "No shortcuts",
    manage: "Manage shortcuts",
  },
  quickActions: {
    label: {
      diagram: "Diagram on the board",
      todo: "Save to TODO",
    },
    prompt: {
      diagram: {
        alone: "Diagram your last explanation on the board.",
        withText: "Diagram this on the board.",
      },
      todo: {
        alone:
          "Add the topics we set aside in this conversation to the TODO list.",
        withText: "Add this to the TODO list.",
      },
    },
  },
  codeBlock: {
    copy: "Copy code",
    copied: "Copied",
    copyFailed: "Couldn't copy",
  },
  mermaid: {
    renderFailed: (error: string) => `Failed to render the diagram: ${error}`,
  },
};
