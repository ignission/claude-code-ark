import type { Todo } from "@ark/shared";
import { describe, expect, it } from "vitest";
import { buildTodoDraft, todoBranchCandidate } from "./todo-draft";

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: "abcdef123456",
  worktreePath: "/wt/a",
  text: "認証まわりを見直す",
  note: null,
  createdAt: 1,
  doneAt: null,
  startedWorktreePath: null,
  startedAt: null,
  ...over,
});

describe("buildTodoDraft", () => {
  it("noteが無ければ本文だけ", () => {
    expect(buildTodoDraft(todo())).toBe("認証まわりを見直す");
  });

  it("noteがあれば空行を挟んで足す", () => {
    expect(buildTodoDraft(todo({ note: "補足" }))).toBe(
      "認証まわりを見直す\n\n補足"
    );
  });

  it("元のブランチがあれば末尾に注記を足す", () => {
    expect(buildTodoDraft(todo({ note: "補足" }), "feat/x")).toBe(
      "認証まわりを見直す\n\n補足\n\n(分岐TODO。元のブランチ: feat/x)"
    );
    expect(buildTodoDraft(todo(), "feat/x")).toBe(
      "認証まわりを見直す\n\n(分岐TODO。元のブランチ: feat/x)"
    );
  });
});

describe("todoBranchCandidate", () => {
  it("idの先頭6文字から作る", () => {
    expect(todoBranchCandidate(todo())).toBe("todo-abcdef");
  });
});
