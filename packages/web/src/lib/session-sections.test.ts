import type {
  BridgeSessionStatus,
  ManagedSession,
  Worktree,
} from "@ark/shared";
import { describe, expect, it } from "vitest";
import type { RepoGroup } from "@/hooks/useGroupedWorktreeItems";
import {
  buildSessionEntries,
  countChildren,
  groupByRepo,
  moveRepo,
  nestChildEntries,
  normalizeRepoOrder,
  orderRepoPaths,
  resolveDropIndex,
  type SessionListEntry,
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
    const sections = groupByRepo(buildSessionEntries(groups, statuses), []);
    expect(sections.map(s => [s.repoPath, s.entries.map(e => e.key)])).toEqual([
      ["/a/alpha", ["wt:a1", "s:sa9"]],
      ["/b/beta", ["wt:b1"]],
      ["/c/gamma", ["wt:g1"]],
    ]);
  });

  it("保存した順を先に置き、そこに無いリポジトリは既定の順で後ろに足す", () => {
    const sections = groupByRepo(buildSessionEntries(groups, new Map()), [
      "/c/gamma",
      "/gone/repo", // いま見えていないパスは無視する
      "/a/alpha",
    ]);
    expect(sections.map(s => s.repoPath)).toEqual([
      "/c/gamma",
      "/a/alpha",
      "/b/beta",
    ]);
  });

  it("行の無いリポジトリは出さない", () => {
    const entries = buildSessionEntries(groups, new Map()).filter(
      e => e.repoPath !== "/b/beta"
    );
    expect(groupByRepo(entries, []).map(s => s.repoPath)).toEqual([
      "/a/alpha",
      "/c/gamma",
    ]);
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

describe("親子の並び (task_start で起こした子)", () => {
  function childSession(
    id: string,
    worktreeId: string,
    worktreePath: string,
    parentWorktreePath: string
  ): ManagedSession {
    return {
      id,
      worktreeId,
      worktreePath,
      parentWorktreePath,
    } as ManagedSession;
  }

  const groups = new Map<string, RepoGroup>([
    [
      "/r/app",
      group("app", [
        {
          worktree: worktree("p", "/r/app"),
          session: session("sp", "p", "/r/app"),
        },
        {
          worktree: worktree("a", "/r/app-a"),
          session: session("sa", "a", "/r/app-a"),
        },
        {
          worktree: worktree("c1", "/r/app-c1"),
          session: childSession("sc1", "c1", "/r/app-c1", "/r/app"),
        },
        {
          worktree: worktree("c2", "/r/app-c2"),
          session: childSession("sc2", "c2", "/r/app-c2", "/r/app"),
        },
      ]),
    ],
  ]);

  it("同じリポジトリの子は、状態に関係なく親の直後に寄せ、字下げの印を付ける", () => {
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sp", "IDLE"],
      ["sa", "IDLE"],
      ["sc1", "TOOL"],
      ["sc2", "IDLE"],
    ]);
    const [app] = groupByRepo(buildSessionEntries(groups, statuses), []);
    expect(app?.entries.map(e => [e.key, e.nested])).toEqual([
      ["wt:p", false],
      ["wt:c1", true],
      ["wt:c2", true],
      ["wt:a", false],
    ]);
  });

  it("親と別のリポジトリの子は、自分のリポジトリに字下げせずに残る", () => {
    const crossRepo = new Map<string, RepoGroup>([
      ...groups,
      [
        "/r/lib",
        group("lib", [
          {
            worktree: null,
            session: childSession("sx", "x", "/r/lib-x", "/r/app"),
          },
        ]),
      ],
    ]);
    const sections = groupByRepo(buildSessionEntries(crossRepo, new Map()), []);
    expect(sections.at(-1)?.entries.map(e => [e.key, e.nested])).toEqual([
      ["s:sx", false],
    ]);
    expect(countChildren(buildSessionEntries(crossRepo, new Map()))).toEqual(
      new Map([["/r/app", 3]])
    );
  });

  it("子の数を親の worktree のパスごとに数える", () => {
    const entries = buildSessionEntries(groups, new Map());
    expect(countChildren(entries)).toEqual(new Map([["/r/app", 2]]));
  });

  it("親子が輪になっていても行を落とさない", () => {
    const entry = (path: string, parent: string): SessionListEntry =>
      ({
        key: path,
        worktree: worktree(path, path),
        session: null,
        parentWorktreePath: parent,
        nested: false,
      }) as unknown as SessionListEntry;
    const result = nestChildEntries([entry("/x", "/y"), entry("/y", "/x")]);
    expect(result.map(e => e.key).sort()).toEqual(["/x", "/y"]);
  });
});
