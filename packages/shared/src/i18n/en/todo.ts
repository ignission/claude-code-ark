import type { Messages } from "../ja";

export const todo: Messages["todo"] = {
  scopeSession: "This session",
  scopeAll: "All",
  empty: "No parked topics",
  doneCount: (count: number) => `Done (${count})`,
  markDone: "Mark as done",
  markUndone: "Mark as not done",
  talkHere: "Discuss in the original session",
  talkInNewWorktree: "Discuss in a new worktree",
  remove: "Remove TODO",
  startedHere: "Started in this session",
  startedIn: (label: string | null) =>
    `→ Started in ${label ?? "a deleted worktree"}`,
  deletedWorktree: "Deleted worktree",
  api: {
    noResponse: "No response from the server",
  },
  draftOrigin: (branch: string) =>
    `(Branched TODO. Original branch: ${branch})`,
};
