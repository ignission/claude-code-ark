import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import { describe, expect, it } from "vitest";
import type { RepoGroup } from "@/hooks/useGroupedWorktreeItems";
import {
  buildSessionEntries,
  groupByRepo,
  moveRepo,
  normalizeRepoOrder,
  orderRepoPaths,
  resolveDropIndex,
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
  return { repoName, disambiguator, items, mainWorktreePath: null };
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

  it("手動で休止にしたセッションは状態に関係なく札を休止にし、あなたの番から外す", () => {
    const groups = new Map<string, RepoGroup>([
      [
        "/r/app",
        group("app", [
          {
            worktree: worktree("w1", "/r/app"),
            session: { ...session("s1", "w1", "/r/app"), restedAt: 10 },
          },
          {
            worktree: worktree("w2", "/r/app-x"),
            session: session("s2", "w2", "/r/app-x"),
          },
        ]),
      ],
    ]);
    const statuses = new Map<string, BridgeSessionStatus>([
      ["s1", "AWAITING"],
      ["s2", "IDLE"],
    ]);
    const entries = buildSessionEntries(groups, statuses);
    expect(
      entries.map(e => [e.key, e.statusKey, e.yourTurn, e.manuallyRested])
    ).toEqual([
      ["wt:w1", "RESTED", false, true],
      ["wt:w2", "IDLE", true, false],
    ]);
  });
});

describe("リポジトリの並び順", () => {
  const groups = new Map<string, RepoGroup>([
    // useGroupedWorktreeItems はリポジトリ名 → パスの順で渡す
    [
      "/a/alpha",
      group("alpha", [
        {
          worktree: worktree("a1", "/a/alpha"),
          session: session("sa1", "a1", "/a/alpha"),
        },
        { worktree: null, session: session("sa9", "x", "/a/alpha-0") },
      ]),
    ],
    [
      "/b/beta",
      group("beta", [{ worktree: worktree("b1", "/b/beta"), session: null }]),
    ],
    [
      "/c/gamma",
      group("gamma", [
        {
          worktree: worktree("g1", "/c/gamma"),
          session: session("sg1", "g1", "/c/gamma"),
        },
      ]),
    ],
  ]);

  it("保存した順が無ければ、渡された順 (リポジトリ名順) のまま、状態では動かさない", () => {
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sa1", "TOOL"],
      ["sa9", "READY"],
      ["sg1", "AWAITING"],
    ]);
    const sections = groupByRepo(
      groups,
      buildSessionEntries(groups, statuses),
      [],
      []
    );
    expect(sections.map(s => [s.repoPath, s.entries.map(e => e.key)])).toEqual([
      ["/a/alpha", ["wt:a1", "s:sa9"]],
      ["/b/beta", ["wt:b1"]],
      ["/c/gamma", ["wt:g1"]],
    ]);
  });

  it("保存した順を先に置き、そこに無いリポジトリは既定の順で後ろに足す", () => {
    const sections = groupByRepo(
      groups,
      buildSessionEntries(groups, new Map()),
      [],
      [
        "/c/gamma",
        "/gone/repo", // いま見えていないパスは無視する
        "/a/alpha",
      ]
    );
    expect(sections.map(s => s.repoPath)).toEqual([
      "/c/gamma",
      "/a/alpha",
      "/b/beta",
    ]);
  });

  it("登録したリポジトリは行が無くても出し、mainのパスを見出しに渡す", () => {
    const withMain = new Map(groups);
    withMain.set("/b/beta", {
      ...group("beta", []),
      mainWorktreePath: "/b/beta",
    });
    const sections = groupByRepo(
      withMain,
      buildSessionEntries(withMain, new Map()),
      ["/a/alpha", "/b/beta", "/c/gamma"],
      []
    );
    expect(
      sections.map(s => [s.repoPath, s.entries.length, s.mainWorktreePath])
    ).toEqual([
      ["/a/alpha", 2, null],
      ["/b/beta", 0, "/b/beta"],
      ["/c/gamma", 1, null],
    ]);
  });

  it("登録していないリポジトリは、行が無くなったら出さない", () => {
    const entries = buildSessionEntries(groups, new Map()).filter(
      e => e.repoPath !== "/b/beta"
    );
    expect(
      groupByRepo(groups, entries, ["/a/alpha"], []).map(s => s.repoPath)
    ).toEqual(["/a/alpha", "/c/gamma"]);
  });

  it("orderRepoPaths は保存順に無いものの既定の順を保つ", () => {
    expect(orderRepoPaths(["/a", "/b", "/c", "/d"], ["/c", "/a"])).toEqual([
      "/c",
      "/a",
      "/b",
      "/d",
    ]);
  });

  it("moveRepo は動かした結果に、見えていない保存済みのパスを後ろへ残す", () => {
    expect(
      moveRepo(["/a", "/b", "/c"], ["/hidden", "/b", "/a"], "/c", 0)
    ).toEqual(["/c", "/a", "/b", "/hidden"]);
    // toIndex は動かすものを抜いた列での位置。範囲の外は端に寄せる
    expect(moveRepo(["/a", "/b", "/c"], [], "/a", 2)).toEqual([
      "/b",
      "/c",
      "/a",
    ]);
    expect(moveRepo(["/a", "/b", "/c"], [], "/b", 99)).toEqual([
      "/a",
      "/c",
      "/b",
    ]);
  });

  it("resolveDropIndex はポインタより上にある中心の数を挿入位置にする", () => {
    expect(resolveDropIndex(5, [10, 30])).toBe(0);
    expect(resolveDropIndex(20, [10, 30])).toBe(1);
    expect(resolveDropIndex(99, [10, 30])).toBe(2);
  });

  it("normalizeRepoOrder は壊れた値を空にし、文字列以外と重複を落とす", () => {
    expect(normalizeRepoOrder(null)).toEqual([]);
    expect(normalizeRepoOrder("/a")).toEqual([]);
    expect(normalizeRepoOrder(["/a", 1, "", "/b", "/a"])).toEqual(["/a", "/b"]);
  });
});

describe("task_start で起こした子", () => {
  it("親の直後に寄せず、worktree のパス順のまま並べる", () => {
    const child = {
      ...session("sc", "c", "/r/app-c"),
      parentWorktreePath: "/r/app-z",
    } as ManagedSession;
    const groups = new Map<string, RepoGroup>([
      [
        "/r/app",
        group("app", [
          { worktree: worktree("a", "/r/app-a"), session: null },
          { worktree: worktree("c", "/r/app-c"), session: child },
          { worktree: worktree("z", "/r/app-z"), session: null },
        ]),
      ],
    ]);
    const [app] = groupByRepo(
      groups,
      buildSessionEntries(groups, new Map()),
      ["/r/app"],
      []
    );
    expect(app?.entries.map(e => e.key)).toEqual(["wt:a", "wt:c", "wt:z"]);
  });
});
