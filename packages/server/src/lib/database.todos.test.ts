import { beforeEach, describe, expect, it } from "vitest";
import {
  normalizeTodoText,
  SessionDatabase,
  TODO_TEXT_MAX_LENGTH,
} from "./database.js";

describe("normalizeTodoText", () => {
  it("改行とタブを空白 1 つに畳み、前後を落とす", () => {
    expect(normalizeTodoText("  ログの\n\n形式\tを見直す  ")).toBe(
      "ログの 形式 を見直す"
    );
  });

  it("上限で切る", () => {
    expect(normalizeTodoText("あ".repeat(300))).toHaveLength(
      TODO_TEXT_MAX_LENGTH
    );
  });
});

describe("SessionDatabase: todos", () => {
  let db: SessionDatabase;

  beforeEach(() => {
    db = new SessionDatabase(":memory:");
  });

  it("足した TODO を worktree ごとに返す", () => {
    const a = db.addTodo({ worktreePath: "/w/a", text: "ログの形式" });
    db.addTodo({ worktreePath: "/w/b", text: "別件", note: "メモ" });
    expect(a).toMatchObject({
      worktreePath: "/w/a",
      text: "ログの形式",
      note: null,
      doneAt: null,
    });
    expect(db.listTodos({ worktreePath: "/w/a" }).map(t => t.text)).toEqual([
      "ログの形式",
    ]);
    expect(db.listTodos()).toHaveLength(2);
  });

  it("本文が空なら投げる", () => {
    expect(() => db.addTodo({ worktreePath: "/w/a", text: " \n " })).toThrow(
      "TODO の本文が空です"
    );
  });

  it("完了を付け外しでき、未完了が先に並ぶ", () => {
    const first = db.addTodo({ worktreePath: "/w/a", text: "1" });
    db.addTodo({ worktreePath: "/w/a", text: "2" });
    expect(db.setTodoDone(first.id, true)).toBe(true);
    expect(db.listTodos().map(t => t.text)).toEqual(["2", "1"]);
    expect(db.listTodos({ includeDone: false }).map(t => t.text)).toEqual([
      "2",
    ]);
    expect(db.setTodoDone(first.id, false)).toBe(true);
    expect(db.listTodos({ includeDone: false })).toHaveLength(2);
  });

  it("無い id の完了と削除は false を返す", () => {
    expect(db.setTodoDone("none", true)).toBe(false);
    expect(db.deleteTodo("none")).toBe(false);
  });

  it("削除する", () => {
    const t = db.addTodo({ worktreePath: "/w/a", text: "1" });
    expect(db.deleteTodo(t.id)).toBe(true);
    expect(db.listTodos()).toEqual([]);
  });
});
