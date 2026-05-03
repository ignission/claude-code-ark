import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionDatabase } from "./database.js";

describe("SessionDatabase: message shortcuts", () => {
  let db: SessionDatabase;

  beforeEach(() => {
    db = new SessionDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("初期状態は空配列を返す", () => {
    expect(db.listMessageShortcuts()).toEqual([]);
  });

  it("作成すると id・label・message・sortOrder が返る", () => {
    const created = db.createMessageShortcut({
      label: "進捗確認",
      message: "現在のタスクの進捗を教えて",
    });
    expect(created.id).toBeTruthy();
    expect(created.label).toBe("進捗確認");
    expect(created.message).toBe("現在のタスクの進捗を教えて");
    expect(created.sortOrder).toBe(1);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);
  });

  it("複数作成すると sortOrder がインクリメントされる", () => {
    const a = db.createMessageShortcut({ label: "a", message: "ma" });
    const b = db.createMessageShortcut({ label: "b", message: "mb" });
    const c = db.createMessageShortcut({ label: "c", message: "mc" });
    expect(a.sortOrder).toBe(1);
    expect(b.sortOrder).toBe(2);
    expect(c.sortOrder).toBe(3);
  });

  it("listMessageShortcuts は sortOrder 昇順で返す", () => {
    db.createMessageShortcut({ label: "a", message: "ma" });
    db.createMessageShortcut({ label: "b", message: "mb" });
    const list = db.listMessageShortcuts();
    expect(list.map(s => s.label)).toEqual(["a", "b"]);
  });

  it("update は label と message を部分更新できる", () => {
    const created = db.createMessageShortcut({
      label: "old",
      message: "old-msg",
    });
    const updated = db.updateMessageShortcut(created.id, { label: "new" });
    expect(updated.label).toBe("new");
    expect(updated.message).toBe("old-msg");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("update は存在しないIDで例外を投げる", () => {
    expect(() =>
      db.updateMessageShortcut("nonexistent", { label: "x" })
    ).toThrow(/not found/);
  });

  it("delete で消える", () => {
    const a = db.createMessageShortcut({ label: "a", message: "ma" });
    db.deleteMessageShortcut(a.id);
    expect(db.getMessageShortcut(a.id)).toBeNull();
    expect(db.listMessageShortcuts()).toHaveLength(0);
  });

  it("delete は存在しないIDでも例外を投げない（冪等）", () => {
    expect(() => db.deleteMessageShortcut("nonexistent")).not.toThrow();
  });

  it("複数行メッセージを保存・取得できる", () => {
    const multi = "line1\nline2\nline3";
    const created = db.createMessageShortcut({
      label: "multi",
      message: multi,
    });
    const got = db.getMessageShortcut(created.id);
    expect(got?.message).toBe(multi);
  });
});
