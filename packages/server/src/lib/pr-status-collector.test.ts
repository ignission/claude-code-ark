import { describe, expect, it } from "vitest";
import {
  classifyGhError,
  type GhResult,
  PrStatusCollector,
  parsePrView,
  summarizeChecks,
} from "./pr-status-collector";

const checkRun = (status: string, conclusion: string | null = null) => ({
  __typename: "CheckRun",
  status,
  conclusion,
});
const context = (state: string) => ({ __typename: "StatusContext", state });

describe("summarizeChecks", () => {
  it("チェックが無ければ none", () => {
    expect(summarizeChecks(null)).toBe("none");
    expect(summarizeChecks([])).toBe("none");
  });

  it("すべて通れば passed (SKIPPED・NEUTRALも通ったとみなす)", () => {
    expect(
      summarizeChecks([
        checkRun("COMPLETED", "SUCCESS"),
        checkRun("COMPLETED", "SKIPPED"),
        context("SUCCESS"),
      ])
    ).toBe("passed");
  });

  it("走っているCheckRunと、PENDINGのCodeRabbitは pending", () => {
    expect(
      summarizeChecks([checkRun("COMPLETED", "SUCCESS"), checkRun("QUEUED")])
    ).toBe("pending");
    expect(
      summarizeChecks([checkRun("COMPLETED", "SUCCESS"), context("PENDING")])
    ).toBe("pending");
  });

  it("1つでも落ちていれば、ほかが待ちでも failed", () => {
    expect(
      summarizeChecks([
        checkRun("IN_PROGRESS"),
        checkRun("COMPLETED", "FAILURE"),
      ])
    ).toBe("failed");
    expect(summarizeChecks([context("ERROR")])).toBe("failed");
  });
});

describe("parsePrView", () => {
  it("gh pr view の出力を読む", () => {
    expect(
      parsePrView(
        JSON.stringify({
          number: 550,
          url: "https://github.com/o/r/pull/550",
          state: "OPEN",
          isDraft: false,
          headRefOid: "abc",
          statusCheckRollup: [checkRun("COMPLETED", "SUCCESS")],
        })
      )
    ).toEqual({
      number: 550,
      url: "https://github.com/o/r/pull/550",
      state: "OPEN",
      isDraft: false,
      checks: "passed",
      headRefOid: "abc",
    });
  });

  it("形が違えば null", () => {
    expect(parsePrView("no pull requests found")).toBeNull();
    expect(parsePrView(JSON.stringify({ number: 1 }))).toBeNull();
  });
});

describe("PrStatusCollector", () => {
  it("セッションごとに読み、PRが無ければ null、消えたセッションは忘れる", async () => {
    let targets = [
      { sessionId: "a", worktreePath: "/wt/a" },
      { sessionId: "b", worktreePath: "/wt/b" },
    ];
    const calls: string[] = [];
    const collector = new PrStatusCollector(
      async (cwd, args) => {
        if (args[0] === "auth") return { kind: "error", message: "old gh" };
        calls.push(cwd);
        if (cwd === "/wt/b") return { kind: "none" };
        return {
          kind: "ok",
          stdout: JSON.stringify({
            number: 1,
            url: "u",
            state: "OPEN",
            isDraft: false,
            headRefOid: "h",
            statusCheckRollup: [context("FAILURE")],
          }),
        };
      },
      () => targets
    );
    await collector.collect();
    expect(calls).toEqual(["/wt/a", "/wt/b"]);
    expect(collector.get("a")?.checks).toBe("failed");
    expect(collector.get("b")).toBeNull();

    targets = [{ sessionId: "b", worktreePath: "/wt/b" }];
    await collector.collect();
    expect(collector.get("a")).toBeNull();
  });
});

describe("PrStatusCollector の読み取りの失敗", () => {
  it("一時的な失敗では前の値を残し、PRが無いと分かったら null にする", async () => {
    const results = [
      {
        kind: "ok" as const,
        stdout: JSON.stringify({
          number: 3,
          url: "u",
          state: "OPEN",
          isDraft: false,
          headRefOid: "h",
          statusCheckRollup: [context("PENDING")],
        }),
      },
      { kind: "error" as const, message: "timeout" },
      { kind: "none" as const },
    ];
    let call = 0;
    const collector = new PrStatusCollector(
      async (_cwd, args) =>
        args[0] === "auth"
          ? { kind: "error", message: "old gh" }
          : results[call++],
      () => [{ sessionId: "a", worktreePath: "/wt/a" }]
    );
    await collector.collect();
    expect(collector.get("a")?.checks).toBe("pending");
    await collector.collect();
    expect(collector.get("a")?.checks).toBe("pending");
    await collector.collect();
    expect(collector.get("a")).toBeNull();
  });
});

describe("classifyGhError", () => {
  it("PRが無い・ブランチが無いは none、それ以外は error", () => {
    expect(
      classifyGhError('no pull requests found for branch "x"', "")
    ).toEqual({ kind: "none" });
    expect(
      classifyGhError(
        "could not determine current branch: not on any branch",
        ""
      )
    ).toEqual({ kind: "none" });
    expect(
      classifyGhError(
        "GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)",
        ""
      )
    ).toEqual({ kind: "noaccess" });
    expect(classifyGhError("", "Command failed: timed out")).toEqual({
      kind: "error",
      message: "Command failed: timed out",
    });
  });
});

describe("PrStatusCollector の複数アカウント", () => {
  const prJson = JSON.stringify({
    number: 7,
    url: "u",
    state: "OPEN",
    isDraft: false,
    headRefOid: "h",
    statusCheckRollup: [],
  });
  /** login と見えるworktreeの組で、ghの応答を作る */
  function fakeGh(
    logins: () => Array<{ login: string; active: boolean }>,
    visible: Record<string, string[]>,
    calls: string[]
  ) {
    return async (
      cwd: string,
      args: string[],
      token?: string
    ): Promise<GhResult> => {
      if (args[1] === "status") {
        return {
          kind: "ok",
          stdout: JSON.stringify({
            hosts: {
              "github.com": logins().map(l => ({ ...l, state: "success" })),
            },
          }),
        };
      }
      if (args[1] === "token") {
        return { kind: "ok", stdout: `tok-${args.at(-1)}\n` };
      }
      calls.push(`${cwd}:${token}`);
      const login = token?.replace("tok-", "") ?? "";
      return visible[login]?.includes(cwd)
        ? { kind: "ok", stdout: prJson }
        : { kind: "noaccess" };
    };
  }

  it("有効なアカウントから試し、見えたアカウントを覚える", async () => {
    const calls: string[] = [];
    const collector = new PrStatusCollector(
      fakeGh(
        () => [
          { login: "b", active: false },
          { login: "a", active: true },
        ],
        { a: ["/wt/x"], b: ["/wt/y"] },
        calls
      ),
      () => [
        { sessionId: "x", worktreePath: "/wt/x" },
        { sessionId: "y", worktreePath: "/wt/y" },
      ]
    );
    await collector.collect();
    expect(calls).toEqual(["/wt/x:tok-a", "/wt/y:tok-a", "/wt/y:tok-b"]);
    expect(collector.get("x")?.number).toBe(7);
    expect(collector.get("y")?.number).toBe(7);

    calls.length = 0;
    await collector.collect();
    expect(calls).toEqual(["/wt/x:tok-a", "/wt/y:tok-b"]);
  });

  it("どのアカウントからも見えなければ null にして、顔ぶれが変わるまで読まない", async () => {
    const calls: string[] = [];
    let logins = [{ login: "a", active: true }];
    const collector = new PrStatusCollector(
      fakeGh(() => logins, { c: ["/wt/z"] }, calls),
      () => [{ sessionId: "z", worktreePath: "/wt/z" }]
    );
    await collector.collect();
    await collector.collect();
    expect(calls).toEqual(["/wt/z:tok-a"]);
    expect(collector.get("z")).toBeNull();

    logins = [...logins, { login: "c", active: false }];
    await collector.collect();
    expect(collector.get("z")?.number).toBe(7);
  });
});
