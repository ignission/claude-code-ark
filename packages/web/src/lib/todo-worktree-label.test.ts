import { describe, expect, it } from "vitest";
import { todoWorktreeLabel } from "./todo-worktree-label";

const worktrees = [{ path: "/w/a", branch: "feat/a" }];

describe("todoWorktreeLabel", () => {
  it("セッションが無くても worktree が残っていればブランチ名を返す", () => {
    expect(todoWorktreeLabel("/w/a", worktrees, new Map())).toBe("feat/a");
  });

  it("自分で付けた表示名を優先する", () => {
    expect(
      todoWorktreeLabel("/w/a", worktrees, new Map([["/w/a", " 名前 "]]))
    ).toBe("名前");
  });

  it("worktree が無ければ null", () => {
    expect(todoWorktreeLabel("/w/x", worktrees, new Map())).toBeNull();
  });
});
