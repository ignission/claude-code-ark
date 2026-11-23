import type { ManagedSession } from "@ark/shared";
import { describe, expect, it, vi } from "vitest";
import { SessionDatabase } from "./database.js";
import {
  handleSessionRest,
  mayHaveMovedSince,
  type SessionRestDeps,
  wakeRestedSessions,
} from "./session-rest.js";

function make(now = 1_000, conversationMoved = true) {
  const db = new SessionDatabase(":memory:");
  db.upsertSession({
    id: "s1",
    worktreeId: "w1",
    worktreePath: "/repo/w1",
    status: "active",
  });
  const emitUpdated = vi.fn();
  const deps: SessionRestDeps = {
    getRestedSessions: () => db.getRestedSessions(),
    clearRestedAtIfMatches: (id, at) =>
      db.clearSessionRestedAtIfMatches(id, at),
    updateRestedAt: (id, at) => db.updateSessionRestedAt(id, at),
    // 配る中身はここでは問わないので、DB の値だけを載せる
    getSession: id =>
      ({ id, restedAt: db.getSession(id)?.restedAt ?? null }) as ManagedSession,
    hasConversationSince: () => conversationMoved,
    emitUpdated,
    now: () => now,
  };
  return { db, deps, emitUpdated };
}

describe("mayHaveMovedSince", () => {
  it("mtime が休止にした時刻より後なら読みに行く", () => {
    expect(mayHaveMovedSince(1_000, 1_001)).toBe(true);
  });
  it("同じ時刻や前なら読まない", () => {
    expect(mayHaveMovedSince(1_000, 1_000)).toBe(false);
    expect(mayHaveMovedSince(1_000, 999)).toBe(false);
  });
  it("mtime が読めなければ読まない", () => {
    expect(mayHaveMovedSince(1_000, null)).toBe(false);
  });
});

describe("handleSessionRest", () => {
  it("休止にすると時刻を保存して配る", () => {
    const { db, deps, emitUpdated } = make(1_234);
    handleSessionRest({ sessionId: "s1", rested: true }, deps);
    expect(db.getSession("s1")?.restedAt).toBe(1_234);
    expect(emitUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", restedAt: 1_234 })
    );
  });

  it("休止から戻すと時刻を消す", () => {
    const { db, deps } = make();
    handleSessionRest({ sessionId: "s1", rested: true }, deps);
    handleSessionRest({ sessionId: "s1", rested: false }, deps);
    expect(db.getSession("s1")?.restedAt).toBeNull();
  });

  it("形の違う payload と無いセッションは無視する", () => {
    const { deps, emitUpdated } = make();
    handleSessionRest(undefined, deps);
    handleSessionRest({ sessionId: "s1", rested: "yes" }, deps);
    handleSessionRest({ sessionId: "nope", rested: true }, deps);
    expect(emitUpdated).not.toHaveBeenCalled();
  });
});

describe("wakeRestedSessions", () => {
  it("会話が動いたら休止から外して1回だけ配る", () => {
    const { db, deps, emitUpdated } = make(1_000);
    handleSessionRest({ sessionId: "s1", rested: true }, deps);
    emitUpdated.mockClear();
    const previews = [{ sessionId: "s1", lastUpdatedAt: 2_000 }];
    wakeRestedSessions(previews, deps);
    // 別のクライアントの周回でもう一度呼ばれても配らない
    wakeRestedSessions(previews, deps);
    expect(db.getSession("s1")?.restedAt).toBeNull();
    expect(emitUpdated).toHaveBeenCalledTimes(1);
  });

  it("会話が動いていなければ休止のまま", () => {
    const { db, deps, emitUpdated } = make(1_000);
    handleSessionRest({ sessionId: "s1", rested: true }, deps);
    emitUpdated.mockClear();
    wakeRestedSessions([{ sessionId: "s1", lastUpdatedAt: 900 }], deps);
    wakeRestedSessions([{ sessionId: "s1", lastUpdatedAt: null }], deps);
    expect(db.getSession("s1")?.restedAt).toBe(1_000);
    expect(emitUpdated).not.toHaveBeenCalled();
  });

  it("mtime が動いても、会話のレコードが増えていなければ休止のまま", () => {
    const { db, deps, emitUpdated } = make(1_000, false);
    handleSessionRest({ sessionId: "s1", rested: true }, deps);
    emitUpdated.mockClear();
    wakeRestedSessions([{ sessionId: "s1", lastUpdatedAt: 2_000 }], deps);
    expect(db.getSession("s1")?.restedAt).toBe(1_000);
    expect(emitUpdated).not.toHaveBeenCalled();
  });

  it("読んだあとに休止にし直された値は消さない", () => {
    const { db, deps } = make(1_000);
    handleSessionRest({ sessionId: "s1", rested: true }, deps);
    const staleRead = db.getRestedSessions();
    db.updateSessionRestedAt("s1", 5_000);
    wakeRestedSessions([{ sessionId: "s1", lastUpdatedAt: 2_000 }], {
      ...deps,
      getRestedSessions: () => staleRead,
    });
    expect(db.getSession("s1")?.restedAt).toBe(5_000);
  });
});

describe("upsertSession", () => {
  it("セッションを起動し直すと休止を消す", () => {
    const { db, deps } = make();
    handleSessionRest({ sessionId: "s1", rested: true }, deps);
    db.upsertSession({
      id: "s2",
      worktreeId: "w1",
      worktreePath: "/repo/w1",
      status: "active",
    });
    expect(db.getSession("s2")?.restedAt).toBeNull();
  });
});
