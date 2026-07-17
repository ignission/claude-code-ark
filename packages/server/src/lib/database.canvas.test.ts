import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionDatabase } from "./database.js";

describe("SessionDatabase: canvas boards", () => {
  let db: SessionDatabase;

  beforeEach(() => {
    db = new SessionDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("未保存の worktree は null を返す", () => {
    expect(db.getCanvasBoard("/tmp/wt-a")).toBeNull();
  });

  it("saveCanvasBoardScene で保存し getCanvasBoard で取得できる", () => {
    const result = db.saveCanvasBoardScene(
      "/tmp/wt-a",
      '{"elements":[]}',
      null
    );
    expect(result.ok).toBe(true);
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[]}');
    expect(board?.lastSentScene).toBeNull();
  });

  it("saveCanvasBoardScene は upsert（2回目は上書き・lastSentScene 維持）", () => {
    const first = db.saveCanvasBoardScene(
      "/tmp/wt-a",
      '{"elements":[1]}',
      null
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const sent = db.markCanvasBoardSent(
      "/tmp/wt-a",
      '{"elements":[1]}',
      first.revision
    );
    expect(sent.ok).toBe(true);
    const afterSent = db.getCanvasBoard("/tmp/wt-a");
    const second = db.saveCanvasBoardScene(
      "/tmp/wt-a",
      '{"elements":[1,2]}',
      afterSent?.revision ?? null
    );
    expect(second.ok).toBe(true);
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[1,2]}');
    expect(board?.lastSentScene).toBe('{"elements":[1]}');
  });

  it("markCanvasBoardSent は scene と lastSentScene の両方を更新する", () => {
    const result = db.markCanvasBoardSent(
      "/tmp/wt-a",
      '{"elements":[9]}',
      null
    );
    expect(result.ok).toBe(true);
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[9]}');
    expect(board?.lastSentScene).toBe('{"elements":[9]}');
  });

  it("deleteCanvasBoard で削除される（未存在でもエラーにならない）", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", "{}", null);
    db.deleteCanvasBoard("/tmp/wt-a");
    expect(db.getCanvasBoard("/tmp/wt-a")).toBeNull();
    db.deleteCanvasBoard("/tmp/never-existed");
  });

  it("worktree ごとに独立している", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", '{"a":1}', null);
    db.saveCanvasBoardScene("/tmp/wt-b", '{"b":2}', null);
    expect(db.getCanvasBoard("/tmp/wt-a")?.scene).toBe('{"a":1}');
    expect(db.getCanvasBoard("/tmp/wt-b")?.scene).toBe('{"b":2}');
  });

  describe("revision（軽量楽観ロック）", () => {
    it("正常 save → revision が増加する", () => {
      const first = db.saveCanvasBoardScene("/tmp/wt-a", '{"v":1}', null);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("unreachable");

      const second = db.saveCanvasBoardScene(
        "/tmp/wt-a",
        '{"v":2}',
        first.revision
      );
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("unreachable");
      expect(second.revision).toBeGreaterThan(first.revision);

      const board = db.getCanvasBoard("/tmp/wt-a");
      expect(board?.revision).toBe(second.revision);
    });

    it("baseRevision が現在値と不一致なら conflict を返し、保存されない", () => {
      const first = db.saveCanvasBoardScene("/tmp/wt-a", '{"v":1}', null);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("unreachable");

      const result = db.saveCanvasBoardScene(
        "/tmp/wt-a",
        '{"v":2}',
        first.revision - 1
      );
      expect(result).toEqual({ ok: false, conflict: true });

      // 保存されていないことを確認（scene は変わらない）
      const board = db.getCanvasBoard("/tmp/wt-a");
      expect(board?.scene).toBe('{"v":1}');
    });

    it("既存行があるのに baseRevision が null なら conflict（新規と思い込みのケース）", () => {
      db.saveCanvasBoardScene("/tmp/wt-a", '{"v":1}', null);
      const result = db.saveCanvasBoardScene("/tmp/wt-a", '{"v":2}', null);
      expect(result).toEqual({ ok: false, conflict: true });
    });

    it("行がなければ baseRevision を問わず新規 insert に成功する", () => {
      const result = db.saveCanvasBoardScene(
        "/tmp/wt-new",
        '{"x":1}',
        123456789
      );
      expect(result.ok).toBe(true);
      const board = db.getCanvasBoard("/tmp/wt-new");
      expect(board?.scene).toBe('{"x":1}');
    });
  });

  describe("markCanvasBoardSent の CAS（軽量楽観ロック）", () => {
    it("行がなければ baseRevision を問わず新規 insert に成功する", () => {
      const result = db.markCanvasBoardSent(
        "/tmp/wt-new",
        '{"v":1}',
        123456789
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const board = db.getCanvasBoard("/tmp/wt-new");
      expect(board?.scene).toBe('{"v":1}');
      expect(board?.lastSentScene).toBe('{"v":1}');
      expect(board?.revision).toBe(result.revision);
    });

    it("baseRevision が現在値と一致すれば成功し、revision が増加する", () => {
      const first = db.saveCanvasBoardScene("/tmp/wt-a", '{"v":1}', null);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("unreachable");

      const sent = db.markCanvasBoardSent(
        "/tmp/wt-a",
        '{"v":1}',
        first.revision
      );
      expect(sent.ok).toBe(true);
      if (!sent.ok) throw new Error("unreachable");
      expect(sent.revision).toBeGreaterThan(first.revision);
    });

    it("baseRevision が現在値と不一致なら conflict を返し、scene を上書きしない", () => {
      const first = db.saveCanvasBoardScene("/tmp/wt-a", '{"v":1}', null);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("unreachable");

      const result = db.markCanvasBoardSent(
        "/tmp/wt-a",
        '{"v":2}',
        first.revision - 1
      );
      expect(result).toEqual({ ok: false, conflict: true });

      // 他クライアントの新しい変更が古い scene で上書きされていないことを確認
      const board = db.getCanvasBoard("/tmp/wt-a");
      expect(board?.scene).toBe('{"v":1}');
      expect(board?.lastSentScene).toBeNull();
    });

    it("既存行があるのに baseRevision が null なら conflict（新規と思い込みのケース）", () => {
      db.saveCanvasBoardScene("/tmp/wt-a", '{"v":1}', null);
      const result = db.markCanvasBoardSent("/tmp/wt-a", '{"v":2}', null);
      expect(result).toEqual({ ok: false, conflict: true });
    });
  });
});
