/**
 * UsageCollector ユニットテスト
 *
 * tmuxコマンドの実行は `UsageCollectorDeps.tmuxExec` をモックして検証する。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "../../shared/types.js";
import {
  hasUsageResult,
  isOnboardingScreen,
  isReadyScreen,
  isTrustDialog,
  parseUsage,
  UsageCollector,
} from "./usage-collector.js";

// ---------------------------------------------------------------------------
// 実機調査済みサンプル（2026-04-27 取得・Maxプラン認証済み）
// ---------------------------------------------------------------------------

const REAL_USAGE_OUTPUT = `    Status   Config   Usage   Stats

   Session
   Total cost:            $0.0000
   Total duration (API):  0s
   Total duration (wall): 7s
   Total code changes:    0 lines added, 0 lines removed
   Usage:                 0 input, 0 output, 0 cache read, 0 cache write

   Current session
   ██                                                 4% used
   Resets 8:20pm (Asia/Tokyo)

   Current week (all models)
   ███████████████▌                                   31% used
   Resets 3am (Asia/Tokyo)

   Current week (Sonnet only)
                                                      0% used
   Resets 3am (Asia/Tokyo)
`;

const ONBOARDING_OUTPUT = `Welcome to Claude Code

  Let's get started

  Choose the text style that looks best with your terminal:
`;

const ANSI_USAGE_OUTPUT = `\x1b[2J\x1b[H\x1b[1m   Current session\x1b[0m
   \x1b[36m██\x1b[0m                                                 4% used
   Resets 8:20pm (Asia/Tokyo)

   \x1b[1mCurrent week (all models)\x1b[0m
   \x1b[33m███\x1b[0m                                                31% used
   Resets 3am (Asia/Tokyo)

   \x1b[1mCurrent week (Sonnet only)\x1b[0m
                                                      0% used
   Resets 3am (Asia/Tokyo)
`;

// ---------------------------------------------------------------------------
// パーサのテスト
// ---------------------------------------------------------------------------

describe("parseUsage", () => {
  it("実機サンプル（Maxプラン）から3つのセクションを抽出する", () => {
    const parsed = parseUsage(REAL_USAGE_OUTPUT);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionPercent).toBe(4);
    expect(parsed?.weeklyAllPercent).toBe(31);
    expect(parsed?.weeklySonnetPercent).toBe(0);
    expect(parsed?.sessionResets).toBe("8:20pm (Asia/Tokyo)");
    expect(parsed?.weeklyAllResets).toBe("3am (Asia/Tokyo)");
    expect(parsed?.weeklySonnetResets).toBe("3am (Asia/Tokyo)");
  });

  it("totalCost / wallDuration を抽出する", () => {
    const parsed = parseUsage(REAL_USAGE_OUTPUT);
    expect(parsed?.totalCost).toBe("$0.0000");
    expect(parsed?.wallDuration).toBe("7s");
  });

  it("ANSIエスケープ混入版もパースできる", () => {
    const parsed = parseUsage(ANSI_USAGE_OUTPUT);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionPercent).toBe(4);
    expect(parsed?.weeklyAllPercent).toBe(31);
    expect(parsed?.weeklySonnetPercent).toBe(0);
  });

  it("セクション欠落時は null を返す", () => {
    const incomplete = `Current session
    4% used
    Resets 8:20pm (Asia/Tokyo)
`;
    expect(parseUsage(incomplete)).toBeNull();
  });

  it("オンボーディング画面では null を返す", () => {
    expect(parseUsage(ONBOARDING_OUTPUT)).toBeNull();
  });

  it("Team プラン (Sonnet 0% で Resets行欠落) も Sonnet resets を空文字でパース成功", () => {
    const teamPlanOutput = `    Status   Config   Usage   Stats

   Session
   Total cost:            $0.0000
   Total duration (wall): 8s
   Usage:                 0 input, 0 output, 0 cache read, 0 cache write

   Current session
   ██████████████████████████████████████▌            77% used
   Resets 8:40pm (Asia/Tokyo)

   Current week (all models)
   ███████                                            14% used
   Resets May 4, 1pm (Asia/Tokyo)

   Current week (Sonnet only)
                                                      0% used

`;
    const parsed = parseUsage(teamPlanOutput);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionPercent).toBe(77);
    expect(parsed?.weeklyAllPercent).toBe(14);
    expect(parsed?.weeklySonnetPercent).toBe(0);
    expect(parsed?.sessionResets).toBe("8:40pm (Asia/Tokyo)");
    expect(parsed?.weeklyAllResets).toBe("May 4, 1pm (Asia/Tokyo)");
    expect(parsed?.weeklySonnetResets).toBe("");
  });
});

describe("isOnboardingScreen", () => {
  it("Welcome to Claude Code を含む場合 true", () => {
    expect(isOnboardingScreen(ONBOARDING_OUTPUT)).toBe(true);
  });

  it("通常の/usage出力では false", () => {
    expect(isOnboardingScreen(REAL_USAGE_OUTPUT)).toBe(false);
  });

  it("Choose the text style 単独でも検出する", () => {
    expect(isOnboardingScreen("Choose the text style that looks best")).toBe(
      true
    );
  });
});

describe("isReadyScreen", () => {
  it("? for shortcuts のヘルプ表記で true", () => {
    expect(isReadyScreen("? for shortcuts")).toBe(true);
  });

  it("プロンプト記号 ❯ 単独では false (trust dialog の誤検出を避けるため)", () => {
    expect(isReadyScreen("❯ ")).toBe(false);
    // trust dialog のサンプル
    expect(isReadyScreen("❯ 1. Yes, I trust this folder")).toBe(false);
  });

  it("起動中の空画面では false", () => {
    expect(isReadyScreen("")).toBe(false);
  });
});

describe("isTrustDialog", () => {
  it("trust this folder のテキストで true", () => {
    expect(
      isTrustDialog(
        "Quick safety check: Is this a project you created or one you trust?"
      )
    ).toBe(true);
    expect(isTrustDialog("Yes, I trust this folder")).toBe(true);
  });

  it("通常画面では false", () => {
    expect(isTrustDialog(REAL_USAGE_OUTPUT)).toBe(false);
    expect(isTrustDialog("? for shortcuts")).toBe(false);
  });
});

describe("hasUsageResult", () => {
  it("'% used' 3つ + Resets 3つ + Sonnet only 見出し → true", () => {
    expect(hasUsageResult(REAL_USAGE_OUTPUT)).toBe(true);
  });

  it("'% used' が2回以下なら false", () => {
    const partial = "Current session\n4% used\nResets later\n";
    expect(hasUsageResult(partial)).toBe(false);
  });

  it("Team プラン Sonnet 0% (Resets行欠落) でも true", () => {
    const teamPlanOutput = `Current session
77% used
Resets 8:40pm (Asia/Tokyo)

Current week (all models)
14% used
Resets May 4, 1pm (Asia/Tokyo)

Current week (Sonnet only)
0% used
`;
    expect(hasUsageResult(teamPlanOutput)).toBe(true);
  });

  it("Sonnet only 見出しがない描画途中の画面では false", () => {
    const midRender = `Current session
4% used
Resets 8:00pm
Current week (all models)
31% used
Resets 3am
`;
    expect(hasUsageResult(midRender)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UsageCollector のテスト
// ---------------------------------------------------------------------------

interface FakeTmuxState {
  sessions: Map<string, string>;
  killCount: number;
}

/**
 * tmuxの状態を模倣するfake。
 * `scenario` で各セッションが返す出力を制御する。
 */
function createFakeTmux(scenario: {
  /** セッションごとに返す capture-pane 出力（複数回呼ばれることがある） */
  outputs: Map<string, string[]>;
  /** new-session を失敗させる場合 true */
  failNewSession?: boolean;
}): {
  tmuxExec: (args: string[]) => {
    status: number;
    stdout: string;
    stderr: string;
  };
  state: FakeTmuxState;
} {
  const state: FakeTmuxState = {
    sessions: new Map(),
    killCount: 0,
  };
  const callCounts: Map<string, number> = new Map();

  const tmuxExec = (
    args: string[]
  ): { status: number; stdout: string; stderr: string } => {
    const subcmd = args[0];
    if (subcmd === "new-session") {
      if (scenario.failNewSession) return { status: 1, stdout: "", stderr: "" };
      // -s <name> を取り出す
      const sIdx = args.indexOf("-s");
      const name = args[sIdx + 1];
      state.sessions.set(name, name);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (subcmd === "send-keys") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (subcmd === "capture-pane") {
      const tIdx = args.indexOf("-t");
      const name = args[tIdx + 1];
      const outputs = scenario.outputs.get(name) ?? [""];
      const count = callCounts.get(name) ?? 0;
      const stdout = outputs[Math.min(count, outputs.length - 1)];
      callCounts.set(name, count + 1);
      return { status: 0, stdout, stderr: "" };
    }
    if (subcmd === "kill-session") {
      const tIdx = args.indexOf("-t");
      const name = args[tIdx + 1];
      state.sessions.delete(name);
      state.killCount += 1;
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };

  return { tmuxExec, state };
}

const profileA: Profile = {
  id: "profA",
  name: "personal",
  configDir: "/home/user/.claude-personal",
  createdAt: 1,
  updatedAt: 1,
};
const profileB: Profile = {
  id: "profB",
  name: "work",
  configDir: "/home/user/.claude-work",
  createdAt: 2,
  updatedAt: 2,
};

describe("UsageCollector.collectOne", () => {
  let nowValue: number;
  beforeEach(() => {
    nowValue = 1000;
  });

  it("認証済みプロファイルから ok を返す", async () => {
    const sessionPattern = "ark-usage-profA-1000";
    const { tmuxExec, state } = createFakeTmux({
      outputs: new Map([
        [
          sessionPattern,
          [
            "", // 起動中
            "❯ for shortcuts", // ready
            REAL_USAGE_OUTPUT, // /usage 結果
          ],
        ],
      ]),
    });

    const collector = new UsageCollector({
      tmuxExec,
      now: () => nowValue,
      sleep: async () => {
        nowValue += 200;
      },
    });

    const entry = await collector.collectOne(profileA);

    expect(entry.status).toBe("ok");
    expect(entry.profileId).toBe("profA");
    expect(entry.parsed?.sessionPercent).toBe(4);
    expect(entry.parsed?.weeklyAllPercent).toBe(31);
    // セッションがkillされている
    expect(state.killCount).toBe(1);
    expect(state.sessions.size).toBe(0);
  });

  it("オンボーディング画面なら unauthenticated を返す", async () => {
    const sessionName = "ark-usage-profA-1000";
    const { tmuxExec, state } = createFakeTmux({
      outputs: new Map([[sessionName, ["", ONBOARDING_OUTPUT]]]),
    });

    const collector = new UsageCollector({
      tmuxExec,
      now: () => nowValue,
      sleep: async () => {
        nowValue += 200;
      },
    });

    const entry = await collector.collectOne(profileA);
    expect(entry.status).toBe("unauthenticated");
    expect(state.killCount).toBe(1);
  });

  it("readyにならない場合 timeout", async () => {
    const sessionName = "ark-usage-profA-1000";
    const { tmuxExec, state } = createFakeTmux({
      outputs: new Map([[sessionName, [""]]]),
    });

    const collector = new UsageCollector({
      tmuxExec,
      now: () => nowValue,
      sleep: async () => {
        nowValue += 500;
      },
    });

    const entry = await collector.collectOne(profileA);
    expect(entry.status).toBe("timeout");
    expect(state.killCount).toBe(1);
  });

  it("trust dialog が出たら自動承諾し、最終的にokになる", async () => {
    const sentKeys: string[][] = [];
    let captureCount = 0;

    const tmuxExec = (
      args: string[]
    ): { status: number; stdout: string; stderr: string } => {
      const subcmd = args[0];
      if (subcmd === "new-session")
        return { status: 0, stdout: "", stderr: "" };
      if (subcmd === "send-keys") {
        sentKeys.push(args);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (subcmd === "capture-pane") {
        captureCount += 1;
        // 1回目: 起動中, 2回目: trust dialog, 3回目以降: ready
        if (captureCount === 1) return { status: 0, stdout: "", stderr: "" };
        if (captureCount === 2)
          return {
            status: 0,
            stdout: "Quick safety check: Is this a project you trust?",
            stderr: "",
          };
        if (captureCount === 3)
          return { status: 0, stdout: "? for shortcuts", stderr: "" };
        return { status: 0, stdout: REAL_USAGE_OUTPUT, stderr: "" };
      }
      if (subcmd === "kill-session")
        return { status: 0, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };

    const collector = new UsageCollector({
      tmuxExec,
      now: () => nowValue,
      sleep: async () => {
        nowValue += 200;
      },
    });

    const entry = await collector.collectOne(profileA);
    expect(entry.status).toBe("ok");
    // trust dialog で 1 + Enter が送られていること
    const trustAccept = sentKeys.find(
      args => args.includes("1") && args.includes("Enter")
    );
    expect(trustAccept).toBeDefined();
    expect(trustAccept?.[3]).toBe("1");
    // 同じ trust dialog 検出で連打しないこと（trustAcceptは1回のみ）
    const trustAccepts = sentKeys.filter(
      args => args[3] === "1" && args.includes("Enter")
    );
    expect(trustAccepts).toHaveLength(1);
  });

  it("new-session失敗時は error", async () => {
    const { tmuxExec, state } = createFakeTmux({
      outputs: new Map(),
      failNewSession: true,
    });

    const collector = new UsageCollector({
      tmuxExec,
      now: () => nowValue,
      sleep: async () => {
        nowValue += 200;
      },
    });

    const entry = await collector.collectOne(profileA);
    expect(entry.status).toBe("error");
    // new-sessionが失敗してもkillSessionはfinallyで呼ばれる
    expect(state.killCount).toBe(1);
  });
});

describe("UsageCollector.collect", () => {
  let nowValue: number;
  beforeEach(() => {
    nowValue = 1000;
  });

  it("空配列なら空のreport", async () => {
    const { tmuxExec } = createFakeTmux({ outputs: new Map() });
    const collector = new UsageCollector({
      tmuxExec,
      now: () => nowValue,
      sleep: async () => {},
    });

    const report = await collector.collect([]);
    expect(report.entries).toEqual([]);
    expect(report.collectedAt).toBe(nowValue);
  });

  it("1件目がtimeoutでも2件目を実行する（直列実行・継続）", async () => {
    const sessionA = "ark-usage-profA-1000";
    // 2件目のセッション名は1件目処理中にnowが進むので動的に決まる
    // テストでは sleep で 500ms 進むので、1件目のreadyタイムアウト = 5000ms
    // 起動～timeout処理～killまでの過程でnowが進む
    const outputs = new Map<string, string[]>();
    outputs.set(sessionA, [""]); // 全部空 → timeout
    // 2件目: 仮にnowが xxx になっていても、必ず最終的にOK出力を返すように
    // ワイルドカードで全セッションに同じ出力を返す方式に変更
    const callCounts: Map<string, number> = new Map();
    let killCount = 0;
    const sessions: Set<string> = new Set();

    const tmuxExec = (
      args: string[]
    ): { status: number; stdout: string; stderr: string } => {
      const subcmd = args[0];
      if (subcmd === "new-session") {
        const sIdx = args.indexOf("-s");
        const name = args[sIdx + 1];
        sessions.add(name);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (subcmd === "send-keys") return { status: 0, stdout: "", stderr: "" };
      if (subcmd === "capture-pane") {
        const tIdx = args.indexOf("-t");
        const name = args[tIdx + 1];
        const count = callCounts.get(name) ?? 0;
        callCounts.set(name, count + 1);
        // profA のセッション名は固定で空応答
        if (name.startsWith("ark-usage-profA-")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        // profB は ready → /usage結果 の順
        if (count === 0) return { status: 0, stdout: "", stderr: "" };
        if (count === 1)
          return { status: 0, stdout: "❯ for shortcuts", stderr: "" };
        return { status: 0, stdout: REAL_USAGE_OUTPUT, stderr: "" };
      }
      if (subcmd === "kill-session") {
        const tIdx = args.indexOf("-t");
        sessions.delete(args[tIdx + 1]);
        killCount += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    const collector = new UsageCollector({
      tmuxExec,
      now: () => nowValue,
      sleep: async () => {
        nowValue += 500;
      },
    });

    const report = await collector.collect([profileA, profileB]);
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0].status).toBe("timeout");
    expect(report.entries[1].status).toBe("ok");
    // 両方killされている
    expect(killCount).toBe(2);
    expect(sessions.size).toBe(0);
  });

  it("usage:progress イベントを各プロファイルで発火する", async () => {
    const { tmuxExec } = createFakeTmux({
      outputs: new Map([["dummy", ["❯ for shortcuts", REAL_USAGE_OUTPUT]]]),
    });
    const collector = new UsageCollector({
      tmuxExec,
      now: () => nowValue,
      sleep: async () => {
        nowValue += 500;
      },
    });

    const progressEvents: Array<{ name: string; completed: number }> = [];
    collector.on("usage:progress", p => {
      progressEvents.push({
        name: p.currentProfileName,
        completed: p.completed,
      });
    });

    await collector.collect([profileA, profileB]);

    // 各プロファイルで「開始時 (completed=i)」のみ emit。
    // 「completed=total」の完了通知は usage:complete に集約 (UI の先取り
    // 表示問題を避けるため AFTER emit は廃止)。
    expect(progressEvents).toEqual([
      { name: "personal", completed: 0 },
      { name: "work", completed: 1 },
    ]);
  });
});
