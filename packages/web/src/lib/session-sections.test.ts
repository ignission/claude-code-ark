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
    const entries = buildSessionEntries(groups, statuses, new Map([["s1", 5]]));
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

  it("最終更新はセッションのものを引き当て、無ければ不明 (null) にする", () => {
    const groups = new Map<string, RepoGroup>([
      [
        "/r/app",
        group("app", [
          {
            worktree: worktree("w1", "/r/app"),
            session: session("s1", "w1", "/r/app"),
          },
          // 未起動の worktree は会話そのものが無いので不明
          { worktree: worktree("w2", "/r/app-x"), session: null },
        ]),
      ],
    ]);
    const entries = buildSessionEntries(
      groups,
      new Map<string, BridgeSessionStatus>([["s1", "IDLE"]]),
      new Map([["s1", 1_700_000_000_000]])
    );
    expect(entries.map(e => [e.key, e.lastUpdatedAt])).toEqual([
      ["wt:w1", 1_700_000_000_000],
      ["wt:w2", null],
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

  const allIdle = new Map<string, BridgeSessionStatus>([
    ["sz1", "IDLE"],
    ["sa1", "IDLE"],
    ["sa2", "IDLE"],
    ["sa9", "IDLE"],
  ]);

  function sortWith(
    statuses: Map<string, BridgeSessionStatus>,
    lastUpdatedAt: Map<string, number>
  ) {
    return sortSessionEntries(
      buildSessionEntries(groups, statuses, lastUpdatedAt)
    ).map(e => e.key);
  }

  it("セクションの中は最終更新の新しい順に並べる", () => {
    // 上から見ていけばよいように、最後に動いた会話を先頭に置く
    expect(
      sortWith(
        allIdle,
        new Map([
          ["sa1", 100],
          ["sz1", 200],
          ["sa2", 300],
          ["sa9", 50],
        ])
      )
    ).toEqual(["wt:a2", "wt:z1", "wt:a1", "s:sa9"]);
  });

  it("最終更新の不明な行は、そのセクションの最後に既存のキーの順で並べる", () => {
    // 未起動や会話の無い行。並べる根拠が無いので下げる
    expect(sortWith(allIdle, new Map([["sz1", 200]]))).toEqual([
      "wt:z1",
      "wt:a1", // 以下は不明どうし: 状態の優先度 → リポジトリ名 → パス
      "wt:a2",
      "s:sa9", // worktreeの無いセッションは後ろ
    ]);
  });

  it("最終更新が同着なら、既存のキーの順に落ちる (並びが毎秒揺れない)", () => {
    // 状態の優先度 → リポジトリ名 → リポジトリの絶対パス → worktreeのパス
    const sameMoment = new Map([
      ["sz1", 1000],
      ["sa1", 1000],
      ["sa2", 1000],
      ["sa9", 1000],
    ]);
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sz1", "AWAITING"],
      ["sa1", "IDLE"],
      ["sa2", "IDLE"],
      ["sa9", "IDLE"],
    ]);
    expect(sortWith(statuses, sameMoment)).toEqual([
      "wt:z1", // 確認待ちが入力待ちより先
      "wt:a1",
      "wt:a2",
      "s:sa9",
    ]);
  });

  it("最終更新が新しくてもセクションはまたがない", () => {
    // 作業中の会話はいま動いているので必ず新しい。それでも「あなたの番」より前には出さない
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sz1", "TOOL"],
      ["sa1", "IDLE"],
      ["sa2", "STOP"],
      ["sa9", "IDLE"],
    ]);
    expect(
      sortWith(
        statuses,
        new Map([
          ["sz1", 900],
          ["sa1", 100],
          ["sa2", 800],
          ["sa9", 200],
        ])
      )
    ).toEqual([
      "s:sa9", // あなたの番 (新しい順)
      "wt:a1",
      "wt:z1", // 作業中
      "wt:a2", // 休止中
    ]);
  });

  it("最終更新の新しい入力待ちは、古い確認待ちより先に来る", () => {
    // 状態の優先度はセクションの中では tiebreaker に下がり、最終更新が先に効く
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sz1", "AWAITING"],
      ["sa1", "IDLE"],
      ["sa2", "IDLE"],
      ["sa9", "IDLE"],
    ]);
    expect(
      sortWith(
        statuses,
        new Map([
          ["sz1", 100],
          ["sa1", 300],
          ["sa2", 200],
          ["sa9", 50],
        ])
      )
    ).toEqual(["wt:a1", "wt:a2", "wt:z1", "s:sa9"]);
  });

  it("休止中も同じ規則で並べる (3セクションで規則は1つ)", () => {
    const statuses = new Map<string, BridgeSessionStatus>([
      ["sz1", "STOP"],
      ["sa1", "READY"],
      ["sa2", "READY"],
    ]);
    expect(
      sortWith(
        statuses,
        new Map([
          ["sz1", 300],
          ["sa1", 100],
          ["sa2", 200],
        ])
      )
    ).toEqual(["wt:z1", "wt:a2", "wt:a1", "s:sa9"]);
  });

  it("元の配列を書き換えない", () => {
    const entries = buildSessionEntries(groups, new Map(), new Map());
    const before = entries.map(e => e.key);
    sortSessionEntries(entries);
    expect(entries.map(e => e.key)).toEqual(before);
  });
});

describe("sectionize と toListRows", () => {
  it("sectionizeは空のセクションを出さず、toListRowsは空のセクションも件数0の見出しで出す", () => {
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

    // 保留中にセクションが空になっても見出しのkeyが消えないよう、3つの見出しを常に出す
    const rows = toListRows(sections);
    expect(rows.map(r => r.key)).toEqual([
      "section:your-turn",
      "wt:a2",
      "wt:a1",
      "section:working",
      "section:resting",
    ]);
    expect(rows[0]).toEqual({
      kind: "section",
      key: "section:your-turn",
      section: "your-turn",
      count: 2,
    });
    expect(rows[3]).toEqual({
      kind: "section",
      key: "section:working",
      section: "working",
      count: 0,
    });
  });
});
