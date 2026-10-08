import type { GitCommit } from "@ark/shared";
import { describe, expect, it } from "vitest";
import {
  authorHue,
  authorInitials,
  countChanges,
  filterCommits,
  formatAbsoluteTime,
  formatRelativeTime,
  shortSha,
} from "./git-format";

/** ローカル時刻で組む (暦の日数はローカルで数えるため) */
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime();
const sec = (ms: number) => Math.floor(ms / 1000);

describe("formatRelativeTime", () => {
  const now = at(2026, 10, 8, 12, 0, 0);
  const rel = (ms: number) => formatRelativeTime(sec(ms), now);

  it("1 分未満は「たった今」", () => {
    expect(rel(now - 30_000)).toBe("たった今");
    expect(rel(now)).toBe("たった今");
  });

  it("1 時間未満は分、24 時間未満は時間で言う", () => {
    expect(rel(at(2026, 10, 8, 11, 57))).toBe("3分前");
    expect(rel(at(2026, 10, 8, 11, 0, 1))).toBe("59分前");
    expect(rel(at(2026, 10, 8, 9, 0))).toBe("3時間前");
    // 暦の上では前日でも、24 時間以内は時間で言う
    expect(rel(at(2026, 10, 7, 13, 0))).toBe("23時間前");
  });

  it("24 時間以上は暦の日数で言う", () => {
    expect(rel(at(2026, 10, 7, 11, 0))).toBe("昨日");
    expect(rel(at(2026, 10, 7, 0, 0))).toBe("昨日");
    expect(rel(at(2026, 10, 6, 23, 59))).toBe("2日前");
    expect(rel(at(2026, 10, 5, 8, 0))).toBe("3日前");
    expect(rel(at(2026, 10, 2, 8, 0))).toBe("6日前");
  });

  it("7 日以上前は日付", () => {
    expect(rel(at(2026, 10, 1, 8, 0))).toBe("2026/10/01");
    expect(rel(at(2026, 9, 12, 8, 0))).toBe("2026/09/12");
    expect(rel(at(2025, 1, 3, 8, 0))).toBe("2025/01/03");
  });

  it("未来の時刻 (時計のずれ) は「たった今」", () => {
    expect(rel(now + 5 * 60_000)).toBe("たった今");
  });
});

describe("formatAbsoluteTime / shortSha", () => {
  it("ローカルの日時を 0 埋めで出す", () => {
    expect(formatAbsoluteTime(sec(at(2026, 9, 2, 4, 3)))).toBe(
      "2026/09/02 04:03"
    );
  });

  it("ハッシュは先頭 7 文字", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});

describe("authorInitials / authorHue", () => {
  it("英字は 2 語の頭、1 語なら 1 文字、日本語は先頭の 1 文字", () => {
    expect(authorInitials("Shoma Nishitateno")).toBe("SN");
    expect(authorInitials("renovate[bot]")).toBe("R");
    expect(authorInitials("john ronald reuel tolkien")).toBe("JT");
    expect(authorInitials("西舘野 翔真")).toBe("西");
    expect(authorInitials("  ")).toBe("?");
  });

  it("同じ作者は同じ色相になり、0..359 に収まる", () => {
    const hue = authorHue("A@example.com", "A");
    expect(hue).toBe(authorHue("a@example.com", "別名"));
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
    expect(authorHue("", "name")).toBe(authorHue("", "NAME"));
  });
});

describe("countChanges / filterCommits", () => {
  const change = (path: string) => ({
    path,
    status: "M" as const,
    added: 1,
    removed: 0,
  });

  it("ステージ済み・変更・未追跡を足す", () => {
    expect(countChanges(null)).toBe(0);
    expect(
      countChanges({
        staged: [change("a")],
        unstaged: [change("b"), change("c")],
        untracked: [change("d")],
      })
    ).toBe(4);
  });

  const commit = (sha: string, subject: string, name: string): GitCommit => ({
    sha,
    parents: [],
    subject,
    authorName: name,
    authorEmail: `${name.toLowerCase()}@example.com`,
    authorTime: 0,
    refs: [],
  });
  const commits = [
    commit("aaa1111", "Fix the Graph", "Alice"),
    commit("bbb2222", "docs: 設計を追加", "Bob"),
  ];

  it("件名・作者・ハッシュの先頭で絞る (大文字小文字を区別しない)", () => {
    expect(filterCommits(commits, "graph").map(c => c.sha)).toEqual([
      "aaa1111",
    ]);
    expect(filterCommits(commits, "BOB").map(c => c.sha)).toEqual(["bbb2222"]);
    expect(filterCommits(commits, "bbb2").map(c => c.sha)).toEqual(["bbb2222"]);
    expect(filterCommits(commits, "設計").map(c => c.sha)).toEqual(["bbb2222"]);
    expect(filterCommits(commits, "  ")).toHaveLength(2);
    expect(filterCommits(commits, "zzz")).toEqual([]);
  });
});
