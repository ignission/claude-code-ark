import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import { describe, expect, it } from "vitest";
import type { RepoGroup } from "@/hooks/useGroupedWorktreeItems";
import {
  buildSessionEntries,
  sectionize,
  sortSessionEntries,
  toListRows,
} from "./session-sections";

function worktree(id: string, path: string): Worktree {
  return { id, path, branch: "main", isMain: false } as Worktree;
}

function session(
  id: string,
  worktreeId: string,
  worktreePath: string
): ManagedSession {
  return { id, worktreeId, worktreePath } as ManagedSession;
}

function group(
  repoName: string,
  items: RepoGroup["items"],
  disambiguator: string | null = null
): RepoGroup {
  return { repoName, disambiguator, items };
}

describe("buildSessionEntries", () => {
  it("行ごとに key・リポジトリ・状態を持たせる", () => {
    const groups = new Map<string, RepoGroup>([
      [
        "/r/app",
        group(
          "app",
          [
            {
              worktree: worktree("w1", "/r/app"),
              session: session("s1", "w1", "/r/app"),
            },
            { worktree: worktree("w2", "/r/app-x"), session: null },
            { worktree: null, session: session("s3", "gone", "/r/app-old") },
          ],
          "r"
        ),
      ],
    ]);
    const statuses = new Map<string, BridgeSessionStatus>([["s1", "IDLE"]]);
    const entries = buildSessionEntries(groups, statuses);
    expect(
      entries.map(e => [
        e.key,
        e.repoPath,
        e.repoName,
        e.disambiguator,
        e.statusKey,
      ])
    ).toEqual([
      ["wt:w1", "/r/app", "app", "r", "IDLE"],
      ["wt:w2", "/r/app", "app", "r", "NOT_STARTED"],
      ["s:s3", "/r/app", "app", "r", "UNKNOWN"],
    ]);
  });
});

describe("sortSessionEntries", () => {
  const groups = new Map<string, RepoGroup>([
    [
      "/b/zeta",
      group("zeta", [
        {
          worktree: worktree("z1", "/b/zeta"),
          session: session("sz1", "z1", "/b/zeta"),
        },
      ]),
    ],
    [
      "/a/alpha",
      group("alpha", [
        {
          worktree: worktree("a2", "/a/alpha-2"),
          session: session("sa2", "a2", "/a/alpha-2"),
        },
        {
          worktree: worktree("a1", "/a/alpha"),
          session: session("sa1", "a1", "/a/alpha"),
        },
        { worktree: null, session: session("sa9", "x", "/a/alpha-0") },
      ]),
    ],
  ]);

  it("セクション → 状態の優先度 → リポジトリ名 → パスの順に並べる", () => {
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sz1", "AWAITING"],
      ["sa1", "IDLE"],
      ["sa2", "IDLE"],
      ["sa9", "IDLE"],
    ]);
    const sorted = sortSessionEntries(buildSessionEntries(groups, statuses));
    expect(sorted.map(e => e.key)).toEqual([
      "wt:z1", // 確認待ちが入力待ちより先 (リポジトリ名より優先度が先)
      "wt:a1", // 同じ優先度ならリポジトリ名 → worktreeのパス
      "wt:a2",
      "s:sa9", // worktreeの無いセッションは後ろ
    ]);
  });

  it("作業中と休止中は、あなたの番の後ろ", () => {
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sz1", "STOP"],
      ["sa1", "TOOL"],
      ["sa2", "ERR"],
    ]);
    const sorted = sortSessionEntries(buildSessionEntries(groups, statuses));
    expect(sorted.map(e => [e.key, e.statusKey])).toEqual([
      ["wt:a2", "ERR"],
      ["wt:a1", "TOOL"],
      ["wt:z1", "STOP"],
      ["s:sa9", "UNKNOWN"],
    ]);
  });

  it("元の配列を書き換えない", () => {
    const entries = buildSessionEntries(groups, new Map());
    const before = entries.map(e => e.key);
    sortSessionEntries(entries);
    expect(entries.map(e => e.key)).toEqual(before);
  });
});

describe("sectionize と toListRows", () => {
  it("空のセクションは出さず、見出しの行に件数を持たせる", () => {
    const groups = new Map<string, RepoGroup>([
      [
        "/a/alpha",
        group("alpha", [
          {
            worktree: worktree("a1", "/a/alpha"),
            session: session("sa1", "a1", "/a/alpha"),
          },
          {
            worktree: worktree("a2", "/a/alpha-2"),
            session: session("sa2", "a2", "/a/alpha-2"),
          },
        ]),
      ],
    ]);
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sa1", "IDLE"],
      ["sa2", "AWAITING"],
    ]);
    const sections = sectionize(
      sortSessionEntries(buildSessionEntries(groups, statuses))
    );
    expect(sections.map(s => [s.section, s.entries.length])).toEqual([
      ["your-turn", 2],
    ]);

    const rows = toListRows(sections);
    expect(rows.map(r => r.key)).toEqual([
      "section:your-turn",
      "wt:a2",
      "wt:a1",
    ]);
    expect(rows[0]).toEqual({
      kind: "section",
      key: "section:your-turn",
      section: "your-turn",
      count: 2,
    });
  });
});
