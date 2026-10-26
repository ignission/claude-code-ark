import { describe, expect, it, vi } from "vitest";
import { SessionDatabase } from "./database.js";
import { createTodoHandlers } from "./todo-handlers.js";

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
