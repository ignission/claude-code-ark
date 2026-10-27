import { describe, expect, it, vi } from "vitest";
import { SessionDatabase } from "./database.js";
import {
  createTodoHandlers,
  recordStartedForCreatedWorktree,
} from "./todo-handlers.js";

function make() {
  const db = new SessionDatabase(":memory:");
  const onChanged = vi.fn();
  const handlers = createTodoHandlers({ db, onChanged });
  return { db, onChanged, handlers };
}

function call(
  handler: (data: unknown, cb: unknown) => void,
  data: unknown
): unknown {
  const cb = vi.fn();
  handler(data, cb);
  return cb.mock.calls[0]?.[0];
}

describe("todo-handlers", () => {
  it("list は完了も含めて全件を返す", () => {
    const { db, handlers } = make();
    db.addTodo({ worktreePath: "/w", text: "a" });
    expect(call(handlers.list, {})).toMatchObject({
      ok: true,
      todos: [{ text: "a" }],
    });
  });

  it("setDone は完了を付け、変更を知らせる", () => {
    const { db, onChanged, handlers } = make();
    const t = db.addTodo({ worktreePath: "/w", text: "a" });
    expect(call(handlers.setDone, { id: t.id, done: true })).toEqual({
      ok: true,
    });
    expect(db.listTodos()[0].doneAt).not.toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("delete は消し、変更を知らせる", () => {
    const { db, onChanged, handlers } = make();
    const t = db.addTodo({ worktreePath: "/w", text: "a" });
    expect(call(handlers.delete, { id: t.id })).toEqual({ ok: true });
    expect(db.listTodos()).toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("無い id は失敗を返し、知らせない", () => {
    const { onChanged, handlers } = make();
    expect(call(handlers.delete, { id: "none" })).toEqual({
      ok: false,
      error: "TODO が見つかりません",
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("形の違う payload は黙って捨てる", () => {
    const { handlers } = make();
    expect(call(handlers.setDone, { id: 1, done: "yes" })).toBeUndefined();
    expect(call(handlers.delete, null)).toBeUndefined();
  });

  it("cb が関数でなければ何もしない", () => {
    const { handlers } = make();
    expect(() => handlers.list({}, undefined)).not.toThrow();
  });
});

describe("todo-handlers: setStarted", () => {
  it("始めた先を記録し、変更を知らせる", () => {
    const { db, onChanged, handlers } = make();
    const t = db.addTodo({ worktreePath: "/w", text: "a" });
    expect(
      call(handlers.setStarted, { id: t.id, worktreePath: "/w/b" })
    ).toEqual({ ok: true });
    expect(db.listTodos()[0].startedWorktreePath).toBe("/w/b");
    expect(db.listTodos()[0].startedAt).not.toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("無い id は失敗を返し、知らせない", () => {
    const { onChanged, handlers } = make();
    expect(
      call(handlers.setStarted, { id: "none", worktreePath: "/w/b" })
    ).toEqual({ ok: false, error: "TODO が見つかりません" });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("id かパスの型が違う payload は黙って捨てる", () => {
    const { handlers, onChanged } = make();
    expect(
      call(handlers.setStarted, { id: 1, worktreePath: "/w" })
    ).toBeUndefined();
    expect(
      call(handlers.setStarted, { id: "a", worktreePath: 1 })
    ).toBeUndefined();
    expect(call(handlers.setStarted, { id: "a" })).toBeUndefined();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("recordStartedForCreatedWorktree", () => {
  it("todoId があれば始めた先を記録して知らせる", () => {
    const { db, onChanged } = make();
    const t = db.addTodo({ worktreePath: "/w", text: "a" });
    recordStartedForCreatedWorktree({ db, onChanged }, t.id, "/w/new");
    expect(db.listTodos()[0].startedWorktreePath).toBe("/w/new");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("todoId が無ければ何もしない", () => {
    const { db, onChanged } = make();
    const t = db.addTodo({ worktreePath: "/w", text: "a" });
    recordStartedForCreatedWorktree({ db, onChanged }, undefined, "/w/new");
    expect(db.listTodos()[0].startedWorktreePath).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(t.id).toBeTruthy();
  });

  it("TODO が無くても投げず、知らせない", () => {
    const { db, onChanged } = make();
    expect(() =>
      recordStartedForCreatedWorktree({ db, onChanged }, "none", "/w/new")
    ).not.toThrow();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("DB が失敗しても投げず、ログに残す", () => {
    const onChanged = vi.fn();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      setTodoStarted: () => {
        throw new Error("boom");
      },
    };
    expect(() =>
      recordStartedForCreatedWorktree({ db, onChanged }, "x", "/w/new")
    ).not.toThrow();
    expect(onChanged).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("todoId が文字列でなければ何もしない", () => {
    const { db, onChanged } = make();
    recordStartedForCreatedWorktree(
      { db, onChanged },
      5 as unknown as string,
      "/w/new"
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});
