import type { Messages } from "../ja";

export const files: Messages["files"] = {
  confirmDiscard: "You have unsaved changes. Close anyway?",
  connecting: "Connecting…",
  cannotOpen: "Couldn't open the file",
  api: {
    noResponse: "No response from the server",
  },
  editor: {
    loading: "Loading…",
    retry: "Retry",
    readOnly: "Read-only",
    markdownView: "Markdown view",
    preview: "Preview",
    edit: "Edit",
    saveShortcut: "Save (Ctrl+S)",
    changedOnDisk: "Changed on disk",
    reloadDiscard: "Reload and discard edits",
    overwrite: "Overwrite",
    keepEditing: "Keep editing",
    saveFailed: (reason: string) => `Couldn't save: ${reason}`,
    cannotDisplay: "This file can't be displayed",
  },
  pane: {
    expandTree: "Show file tree",
    collapseTree: "Hide file tree",
    openFiles: "Open files",
    unsaved: "Unsaved",
    closeTab: (name: string) => `Close ${name}`,
    empty:
      "Pick a file from the tree, or click a link in the chat or a board to open it here",
  },
  peek: {
    openInFiles: "Open in Files",
    close: "Close peek",
  },
  tree: {
    title: "Files",
    reload: "Reload",
    label: "File tree",
    truncated: "…Too many entries; showing only some",
  },
  viewer: {
    binaryNoPreview: "Binary files can't be previewed",
    imageFile: (name: string) => `Image file: ${name}`,
  },
  html: {
    saveImage: "Save image",
    copyToClipboard: "Copy to clipboard",
    downloadPng: "Download PNG",
    copied: "Image copied to clipboard",
    copyFailed: (reason: string) => `Couldn't copy the image: ${reason}`,
    downloadFailed: (reason: string) =>
      `Couldn't download the image: ${reason}`,
    loadFailed: (reason: string) => `Failed to load the HTML file: ${reason}`,
  },
};
