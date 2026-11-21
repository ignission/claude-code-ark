import type { ManagedSession } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { isCrossRepoChild } from "./child-task-repos";

const session = (over: Partial<ManagedSession>) =>
  ({ id: "s", worktreePath: "/r/app-fix", ...over }) as ManagedSession;

describe("isCrossRepoChild", () => {
  it("親と別のリポジトリへ切り出した子は true", () => {
    expect(
      isCrossRepoChild(
        session({ repoPath: "/r/app", parentWorktreePath: "/note" })
      )
    ).toBe(true);
  });

  it("同じリポジトリの中で分けた子は false (本体、中の worktree、兄弟ディレクトリ)", () => {
    for (const parent of ["/r/app", "/r/app/.worktrees/a", "/r/app-a"]) {
      expect(
        isCrossRepoChild(
          session({ repoPath: "/r/app", parentWorktreePath: parent })
        )
      ).toBe(false);
    }
  });

  it("親が無い、またはリポジトリが分からないセッションは false", () => {
    expect(isCrossRepoChild(session({ repoPath: "/r/app" }))).toBe(false);
    expect(isCrossRepoChild(session({ parentWorktreePath: "/note" }))).toBe(
      false
    );
  });
});
