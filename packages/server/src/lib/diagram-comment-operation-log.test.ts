import { describe, expect, it } from "vitest";
import {
  DiagramCommentOperationLog,
  diagramCommentOperationKey,
} from "./diagram-comment-operation-log.js";

describe("DiagramCommentOperationLog", () => {
  it("記録した key だけを適用済みと判定する", () => {
    const log = new DiagramCommentOperationLog();

    expect(log.has("a")).toBe(false);
    log.record("a");
    expect(log.has("a")).toBe(true);
    expect(log.has("b")).toBe(false);
  });

  it("上限を超えると最も古いエントリから捨てる", () => {
    const log = new DiagramCommentOperationLog(2);

    log.record("a");
    log.record("b");
    log.record("c");

    expect(log.size).toBe(2);
    expect(log.has("a")).toBe(false);
    expect(log.has("b")).toBe(true);
    expect(log.has("c")).toBe(true);
  });

  it("参照されたエントリは延命され、未参照のものが先に捨てられる", () => {
    const log = new DiagramCommentOperationLog(2);

    log.record("a");
    log.record("b");
    expect(log.has("a")).toBe(true);
    log.record("c");

    expect(log.has("b")).toBe(false);
    expect(log.has("a")).toBe(true);
    expect(log.has("c")).toBe(true);
  });

  it("同じ key の再記録は重複エントリを作らない", () => {
    const log = new DiagramCommentOperationLog(2);

    log.record("a");
    log.record("a");
    log.record("b");

    expect(log.size).toBe(2);
    expect(log.has("a")).toBe(true);
  });

  it("clear で全エントリを捨てる", () => {
    const log = new DiagramCommentOperationLog();
    log.record("a");
    log.clear();
    expect(log.has("a")).toBe(false);
    expect(log.size).toBe(0);
  });

  it("不正な上限は拒否する", () => {
    expect(() => new DiagramCommentOperationLog(0)).toThrow(RangeError);
    expect(() => new DiagramCommentOperationLog(1.5)).toThrow(RangeError);
  });
});

describe("diagramCommentOperationKey", () => {
  it("種別・対象・操作 ID のいずれかが違えば別 key になる", () => {
    const base = diagramCommentOperationKey("create", "/a.comments.json", "op");
    expect(
      diagramCommentOperationKey("delete", "/a.comments.json", "op")
    ).not.toBe(base);
    expect(
      diagramCommentOperationKey("create", "/b.comments.json", "op")
    ).not.toBe(base);
    expect(
      diagramCommentOperationKey("create", "/a.comments.json", "op2")
    ).not.toBe(base);
    expect(diagramCommentOperationKey("create", "/a.comments.json", "op")).toBe(
      base
    );
  });

  it("区切り文字を含む入力でも文字列連結による衝突を起こさない", () => {
    expect(diagramCommentOperationKey("create", "/a", "b\0c")).not.toBe(
      diagramCommentOperationKey("create", "/a\0b", "c")
    );
    expect(diagramCommentOperationKey("create", "/a", 'b","c')).not.toBe(
      diagramCommentOperationKey("create", '/a","b', "c")
    );
  });
});
