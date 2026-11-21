import type { ManagedSession, Worktree } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  findHomeSession,
  findHomeWorktree,
  normalizeHomeWorktreePath,
} from "./home-session";

const session = (id: string, worktreePath: string) =>
  ({ id, worktreePath }) as ManagedSession;
const worktree = (path: string) => ({ id: path, path }) as Worktree;

describe("home-session", () => {
  it("設定の値をパスか null に揃える", () => {
    expect(normalizeHomeWorktreePath("/note")).toBe("/note");
    expect(normalizeHomeWorktreePath("  ")).toBeNull();
    expect(normalizeHomeWorktreePath(null)).toBeNull();
    expect(normalizeHomeWorktreePath(3)).toBeNull();
  });

  it("ホームの worktree で動いているセッションを返す", () => {
    const sessions = [session("a", "/r/a"), session("h", "/note")];
    expect(findHomeSession(sessions, "/note")?.id).toBe("h");
    expect(findHomeSession(sessions, "/other")).toBeNull();
    expect(findHomeSession(sessions, null)).toBeNull();
  });

  it("ホームの worktree を返す", () => {
    const worktrees = [worktree("/r/a"), worktree("/note")];
    expect(findHomeWorktree(worktrees, "/note")?.path).toBe("/note");
    expect(findHomeWorktree(worktrees, "/x")).toBeNull();
    expect(findHomeWorktree(worktrees, null)).toBeNull();
  });
});
