import type { ManagedSession } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { missingChildTaskRepos } from "./child-task-repos";

function session(overrides: Partial<ManagedSession>): ManagedSession {
  return {
    id: "s",
    worktreeId: "w",
    worktreePath: "/r/app",
    status: "active",
    createdAt: new Date(0),
    tmuxSessionName: "ark-s",
    ttydPort: null,
    ttydUrl: null,
    ...overrides,
  };
}

describe("missingChildTaskRepos", () => {
  it("未登録のリポジトリにいる子のリポジトリを返す", () => {
    const sessions = [
      session({ id: "home", repoPath: "/note" }),
      session({ id: "b", repoPath: "/r/b", parentWorktreePath: "/note" }),
      session({ id: "a", repoPath: "/r/a", parentWorktreePath: "/note" }),
      session({ id: "a2", repoPath: "/r/a", parentWorktreePath: "/note" }),
    ];
    expect(missingChildTaskRepos(sessions, ["/note"])).toEqual([
      "/r/a",
      "/r/b",
    ]);
  });

  it("登録済みのリポジトリと、親を持たないセッションは足さない", () => {
    const sessions = [
      session({ id: "a", repoPath: "/r/a", parentWorktreePath: "/note" }),
      session({ id: "x", repoPath: "/r/x" }),
      session({ id: "y", parentWorktreePath: "/note" }),
    ];
    expect(missingChildTaskRepos(sessions, ["/note", "/r/a"])).toEqual([]);
  });
});
