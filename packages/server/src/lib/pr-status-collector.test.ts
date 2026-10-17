import { describe, expect, it } from "vitest";
import {
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
      async cwd => {
        calls.push(cwd);
        if (cwd === "/wt/b") return null;
        return JSON.stringify({
          number: 1,
          url: "u",
          state: "OPEN",
          isDraft: false,
          headRefOid: "h",
          statusCheckRollup: [context("FAILURE")],
        });
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
