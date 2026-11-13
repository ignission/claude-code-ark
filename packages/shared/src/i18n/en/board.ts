import type { Messages } from "../ja";
import { plural } from "../plural";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const boards = (count: number) => plural(count, "board", "boards");

export const board: Messages["board"] = {
  empty: "No boards",
  loading: "Loading…",
  loadFailed: (status: number) => `Failed to load the board (${status})`,
  listFailed: "Failed to load the board list",
  deleteFailed: "Failed to delete the board",
  navigationBlocked:
    "The board tried to navigate to another page, so it was disconnected. Check the board file for scripts that navigate away.",
  selectFromList: "Select a board from the list above",
  disconnected: "Socket is disconnected",
  deleteTimeout: "Deleting the board timed out",
  quote: {
    start: "Select a part to ask about",
    startTitle:
      "Draw a box around part of the board to quote it in the chat input",
    stop: "Stop selecting",
    hint: "Drag to draw a box around the part you want to ask about",
    empty: "The box contained no text. Draw it around a part that has text.",
    header: (name: string, relPath: string) =>
      `About this part of the board "${name}" (${relPath}):`,
    truncated: "(quoted up to here because it is long)",
  },
  time: {
    today: (time: string) => `Today ${time}`,
    yesterday: (time: string) => `Yesterday ${time}`,
    monthDay: (month: number, day: number) => `${MONTHS[month - 1]} ${day}`,
    yearMonthDay: (year: number, month: number, day: number) =>
      `${MONTHS[month - 1]} ${day}, ${year}`,
  },
  switcher: {
    title: "Boards",
    select: "Select a board",
    backToList: "Board list",
    backToListTitle: "Back to the board list",
    forward: "Forward to board",
    forwardTitle: "Forward to the open board",
    count: (count: number) => `${count} ${boards(count)}`,
    refreshing: "Refreshing…",
    retry: "Retry",
    search: "Search boards",
    selectedCount: (count: number) => `${count} selected`,
    clearSelection: "Clear selection",
    deleteSelected: "Delete selected",
    selectAllVisible: "Select all visible boards",
    columnName: "Name",
    columnUpdated: "Updated",
    sortBy: (column: string) => `Sort by ${column.toLowerCase()}`,
    noMatch: "No matching boards",
    tracked: "Tracked by Git",
    untracked: "Untracked",
    rowTitle: (relPath: string, tracked: boolean) =>
      `${relPath} (${tracked ? "tracked by Git" : "untracked"})`,
    selectItem: (name: string) => `Select “${name}”`,
    deleteItem: (name: string) => `Delete “${name}”`,
    confirmDeleteOne: (name: string) => `Delete “${name}”?`,
    confirmDeleteMany: (count: number) => `Delete ${count} ${boards(count)}?`,
    andMore: (count: number) => `and ${count} more`,
    trackedCount: (count: number) => `${count} tracked by Git`,
    untrackedCount: (count: number) => `${count} untracked`,
    trackedAndUntracked: (tracked: number, untracked: number) =>
      `${tracked} tracked by Git / ${untracked} untracked`,
    deleteWarningTracked:
      "This also deletes the board's adjacent comment sidecar. The deletion shows up as a change in the worktree, and you can restore the board with Git if needed. Files not tracked by Git can't be restored. This can't be undone.",
    deleteWarningUntracked:
      "This also deletes the board's adjacent comment sidecar. Files not tracked by Git can't be restored. This can't be undone.",
    deleting: "Deleting…",
    deletingProgress: (current: number, total: number) =>
      `Deleting… ${current}/${total}`,
    deleteOne: "Delete",
    deleteMany: (count: number) => `Delete ${count} ${boards(count)}`,
    bulkDeleteFailed: (total: number, failed: number) =>
      `Couldn't delete ${failed} of ${total} ${boards(total)}`,
  },
};
