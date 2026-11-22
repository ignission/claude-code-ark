import type { BridgeSessionStatus } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  collectActiveSessionIds,
  isActiveSession,
  UNLISTED_ACTIVE_WINDOW_MS,
} from "./unlisted-active-sessions";

const now = 1_000_000_000;

describe("isActiveSession", () => {
  it("動いているか確認待ちなら、最終更新が古くても不明でも true", () => {
    for (const status of ["TOOL", "THINK", "AWAITING"] as const) {
      expect(isActiveSession(status, null, now)).toBe(true);
      expect(
        isActiveSession(status, now - UNLISTED_ACTIVE_WINDOW_MS * 5, now)
      ).toBe(true);
    }
  });

  it("ターンを終えたセッションは、会話が直近に動いた間だけ true", () => {
    expect(isActiveSession("IDLE", now - 60_000, now)).toBe(true);
    expect(isActiveSession("IDLE", now - UNLISTED_ACTIVE_WINDOW_MS, now)).toBe(
      false
    );
    expect(isActiveSession("IDLE", null, now)).toBe(false);
    expect(isActiveSession(undefined, undefined, now)).toBe(false);
  });
});

describe("collectActiveSessionIds", () => {
  it("当てはまる id だけを、順序を固定して返す", () => {
    const statuses = new Map<string, BridgeSessionStatus>([
      ["b", "TOOL"],
      ["a", "IDLE"],
      ["c", "IDLE"],
    ]);
    const lastUpdatedAt = new Map([
      ["a", now - 1000],
      ["c", now - UNLISTED_ACTIVE_WINDOW_MS * 2],
    ]);
    expect(
      collectActiveSessionIds(
        ["c", "b", "a", "d"],
        statuses,
        lastUpdatedAt,
        now
      )
    ).toEqual(["a", "b"]);
  });
});
