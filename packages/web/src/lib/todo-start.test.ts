import type { ManagedSession, Worktree } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { findSessionIdByWorktreePath, resolveTodoOrigin } from "./todo-start";

const session = (over: Partial<ManagedSession>): ManagedSession =>
  ({
    id: "s1",
    worktreeId: "w1",
    worktreePath: "/r/app-feat",
    status: "active",
    createdAt: new Date(0),
    ...over,
  }) as ManagedSession;

const worktree = (over: Partial<Worktree>): Worktree => ({
  id: "w1",
  path: "/r/app-feat",
  branch: "feat",
  commit: "0",
  isMain: false,
  isBare: false,
  ...over,
});

describe("findSessionIdByWorktreePath", () => {
  it("そのworktreeのセッションのidを返し、無ければnull", () => {
    const sessions = [
      session({ id: "s1", worktreePath: "/r/a" }),
      session({ id: "s2", worktreePath: "/r/b" }),
    ];
    expect(findSessionIdByWorktreePath(sessions, "/r/b")).toBe("s2");
    expect(findSessionIdByWorktreePath(sessions, "/r/c")).toBeNull();
  });
});

describe("resolveTodoOrigin", () => {
  it("セッションのrepoPathと、worktreeのブランチを返す", () => {
    expect(
      resolveTodoOrigin(
        "/r/app-feat",
        [session({ repoPath: "/r/app" })],
        [worktree({})],
        []
      )
    ).toEqual({ repoPath: "/r/app", branch: "feat" });
  });

  it("セッションが無ければ、repoListから兄弟ディレクトリの規則でリポジトリを探す", () => {
    expect(
      resolveTodoOrigin("/r/app-feat", [], [worktree({})], ["/x/y", "/r/app"])
    ).toEqual({ repoPath: "/r/app", branch: "feat" });
  });

  it("リポジトリの中にあるworktreeも、そのリポジトリのものとして扱う", () => {
    expect(
      resolveTodoOrigin(
        "/r/app/.worktrees/feat",
        [],
        [worktree({ path: "/r/app/.worktrees/feat" })],
        ["/r/app"]
      )
    ).toEqual({ repoPath: "/r/app", branch: "feat" });
  });

  it("worktreeの一覧に無ければブランチは分からない (セッションだけある)", () => {
    expect(
      resolveTodoOrigin(
        "/r/app-feat",
        [session({ repoPath: "/r/app" })],
        [],
        []
      )
    ).toEqual({ repoPath: "/r/app", branch: undefined });
  });

  it("セッションもworktreeも無ければnull (worktreeを消した)", () => {
    expect(resolveTodoOrigin("/r/app-feat", [], [], ["/r/app"])).toBeNull();
  });

  it("リポジトリが分からなければnull", () => {
    expect(
      resolveTodoOrigin("/r/app-feat", [], [worktree({})], ["/other"])
    ).toBeNull();
  });
});
