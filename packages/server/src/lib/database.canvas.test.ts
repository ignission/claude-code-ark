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
    db.saveCanvasBoardScene("/tmp/wt-a", '{"elements":[]}');
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[]}');
    expect(board?.lastSentScene).toBeNull();
  });

  it("saveCanvasBoardScene は upsert（2回目は上書き・lastSentScene 維持）", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", '{"elements":[1]}');
    db.markCanvasBoardSent("/tmp/wt-a", '{"elements":[1]}');
    db.saveCanvasBoardScene("/tmp/wt-a", '{"elements":[1,2]}');
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[1,2]}');
    expect(board?.lastSentScene).toBe('{"elements":[1]}');
  });

  it("markCanvasBoardSent は scene と lastSentScene の両方を更新する", () => {
    db.markCanvasBoardSent("/tmp/wt-a", '{"elements":[9]}');
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[9]}');
    expect(board?.lastSentScene).toBe('{"elements":[9]}');
  });

  it("deleteCanvasBoard で削除される（未存在でもエラーにならない）", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", "{}");
    db.deleteCanvasBoard("/tmp/wt-a");
    expect(db.getCanvasBoard("/tmp/wt-a")).toBeNull();
    db.deleteCanvasBoard("/tmp/never-existed");
  });

  it("worktree ごとに独立している", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", '{"a":1}');
    db.saveCanvasBoardScene("/tmp/wt-b", '{"b":2}');
    expect(db.getCanvasBoard("/tmp/wt-a")?.scene).toBe('{"a":1}');
    expect(db.getCanvasBoard("/tmp/wt-b")?.scene).toBe('{"b":2}');
  });
});
