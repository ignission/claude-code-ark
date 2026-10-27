import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  normalizeTodoText,
  SessionDatabase,
  TODO_NOTE_MAX_LENGTH,
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

  it("上限で切った結果の末尾に空白を残さない", () => {
    const text = `${"あ".repeat(TODO_TEXT_MAX_LENGTH - 1)} い`;
    expect(normalizeTodoText(text)).toBe("あ".repeat(TODO_TEXT_MAX_LENGTH - 1));
    const note = `${"あ".repeat(TODO_NOTE_MAX_LENGTH - 1)} い`;
    const todo = db.addTodo({ worktreePath: "/w", text: "a", note });
    expect(todo.note).toBe("あ".repeat(TODO_NOTE_MAX_LENGTH - 1));
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

  it("新しい TODO は始めた先を持たない", () => {
    const t = db.addTodo({ worktreePath: "/w/a", text: "1" });
    expect(t.startedWorktreePath).toBeNull();
    expect(t.startedAt).toBeNull();
    expect(db.listTodos()[0]).toMatchObject({
      startedWorktreePath: null,
      startedAt: null,
    });
  });

  it("setTodoStarted は始めた先と時刻を記録し、更新後の行を返す", () => {
    const t = db.addTodo({ worktreePath: "/w/a", text: "1" });
    const updated = db.setTodoStarted(t.id, "/w/b", 1234);
    expect(updated).toMatchObject({
      id: t.id,
      startedWorktreePath: "/w/b",
      startedAt: 1234,
    });
    expect(db.listTodos()[0]).toMatchObject({
      startedWorktreePath: "/w/b",
      startedAt: 1234,
    });
  });

  it("始め直したら上書きする", () => {
    const t = db.addTodo({ worktreePath: "/w/a", text: "1" });
    db.setTodoStarted(t.id, "/w/b", 1);
    db.setTodoStarted(t.id, "/w/c", 2);
    expect(db.listTodos()[0]).toMatchObject({
      startedWorktreePath: "/w/c",
      startedAt: 2,
    });
  });

  it("無い id の setTodoStarted は null を返す", () => {
    expect(db.setTodoStarted("none", "/w/b")).toBeNull();
  });
});

describe("SessionDatabase: todos のマイグレーション", () => {
  it("始めた先の列が無い既存 DB に列を足し、古い行は null にする。何度開いても同じ", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-todos-mig-"));
    const file = path.join(dir, "sessions.db");
    try {
      const old = new Database(file);
      old.exec(`
        CREATE TABLE todos (
          id TEXT PRIMARY KEY,
          worktree_path TEXT NOT NULL,
          text TEXT NOT NULL,
          note TEXT,
          created_at INTEGER NOT NULL,
          done_at INTEGER
        );
        INSERT INTO todos (id, worktree_path, text, note, created_at, done_at)
        VALUES ('old1', '/w/a', '古い行', NULL, 1, NULL);
      `);
      old.close();

      const first = new SessionDatabase(file);
      expect(first.listTodos()).toEqual([
        expect.objectContaining({
          id: "old1",
          startedWorktreePath: null,
          startedAt: null,
        }),
      ]);
      first.setTodoStarted("old1", "/w/b", 5);
      first.close();

      // 2 回目の起動で列の追加を繰り返さず、記録も消さない
      const second = new SessionDatabase(file);
      expect(second.listTodos()[0]).toMatchObject({
        startedWorktreePath: "/w/b",
        startedAt: 5,
      });
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
