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
  notes: {
    add: "Add a note",
    addTitle: "Add a sticky note at the centre of the visible area",
    handOff: "Hand to Claude",
    handOffTitle:
      "Hand the notes to Claude. Claude answers by rewriting the board",
    handOffEmpty: "Add a note to hand the board over",
    handOffBusy: "You can hand it over when Claude finishes",
    handOffStopped: "The session is stopped",
    notStarted: "Claude did not start. Check the chat",
    handOffDisconnected: "Disconnected",
    turn: "Claude's turn. The board changes when it is done",
    awaiting: "Claude is waiting for your confirmation. Check the chat",
    invalid:
      "The notes file cannot be read (it is malformed). Showing the last notes that could be read. Ask Claude to fix the notes file",
    limit: "The board has reached the maximum number of notes",
    failed: "Failed to save the note",
    dropped: (count: number) =>
      `Skipped ${count} malformed ${plural(count, "note or frame", "notes or frames")}`,
    newBoard: "New board",
    newBoardTitle: "Create a blank board and start with sticky notes",
    blankName: (month: number, day: number, time: string) =>
      `Whiteboard ${MONTHS[month - 1]} ${day} ${time}`,
    createFailed: "Failed to create the board",
    handOffMessage: (notesPath: string, diagramPath: string) =>
      `Here are the sticky notes on the board. Read \`${notesPath}\`, respond to the notes, and rewrite the same file (group similar notes in frames, answer questions with notes of your own, and add a note for anything missing). The notes sit on top of the board \`${diagramPath}\`. Your answer shows on the board, so write only one line in the chat.`,
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
      "This also deletes the sticky notes on the board. The deletion shows up as a change in the worktree, and you can restore the board with Git if needed. Files not tracked by Git can't be restored. This can't be undone.",
    deleteWarningUntracked:
      "This also deletes the sticky notes on the board. Files not tracked by Git can't be restored. This can't be undone.",
    deleting: "Deleting…",
    deletingProgress: (current: number, total: number) =>
      `Deleting… ${current}/${total}`,
    deleteOne: "Delete",
    deleteMany: (count: number) => `Delete ${count} ${boards(count)}`,
    bulkDeleteFailed: (total: number, failed: number) =>
      `Couldn't delete ${failed} of ${total} ${boards(total)}`,
  },
};
