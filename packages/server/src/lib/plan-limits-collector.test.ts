import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  dropExpired,
  PlanLimitsCollector,
  parseUsage,
  readAccessToken,
  type UsageFetcher,
} from "./plan-limits-collector.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const LATER = "2026-10-17T15:00:00Z";
const EARLIER = "2026-10-17T11:00:00Z";

function configDir(credentials: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plan-limits-"));
  if (credentials !== undefined) {
    writeFileSync(
      path.join(dir, ".credentials.json"),
      JSON.stringify(credentials)
    );
  }
  return dir;
}

const validCredentials = {
  claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 60_000 },
};

const body = {
  five_hour: { utilization: 42, resets_at: LATER },
  seven_day: { utilization: 13, resets_at: LATER },
};

describe("parseUsage", () => {
  it("5時間枠と週枠を読む", () => {
    expect(parseUsage(body)).toEqual({
      fiveHour: { percent: 42, resetsAt: LATER },
      sevenDay: { percent: 13, resetsAt: LATER },
    });
  });

  it("形が違う枠は null にする", () => {
    expect(
      parseUsage({ five_hour: null, seven_day: { utilization: "x" } })
    ).toEqual({ fiveHour: null, sevenDay: null });
    expect(parseUsage("broken")).toEqual({ fiveHour: null, sevenDay: null });
  });

  it("割合を0-100に収める", () => {
    expect(parseUsage({ five_hour: { utilization: 130 } }).fiveHour).toEqual({
      percent: 100,
      resetsAt: null,
    });
  });
});

describe("dropExpired", () => {
  it("リセット時刻を過ぎた枠を落とす", () => {
    expect(
      dropExpired(
        {
          fiveHour: { percent: 90, resetsAt: EARLIER },
          sevenDay: { percent: 13, resetsAt: LATER },
        },
        NOW
      )
    ).toEqual({ fiveHour: null, sevenDay: { percent: 13, resetsAt: LATER } });
  });

  it("両方とも無ければ null", () => {
    expect(
      dropExpired(
        { fiveHour: { percent: 1, resetsAt: EARLIER }, sevenDay: null },
        NOW
      )
    ).toBeNull();
  });
});

describe("readAccessToken", () => {
  it("有効なトークンを返す", async () => {
    expect(await readAccessToken(configDir(validCredentials), NOW)).toEqual({
      token: "tok",
    });
  });

  it("期限切れ、ファイルが無い、は読まない", async () => {
    const expired = {
      claudeAiOauth: { accessToken: "tok", expiresAt: NOW - 1 },
    };
    expect(await readAccessToken(configDir(expired), NOW)).toHaveProperty(
      "skip"
    );
    expect(await readAccessToken(configDir(undefined), NOW)).toHaveProperty(
      "skip"
    );
  });
});

describe("PlanLimitsCollector", () => {
  it("プロファイルごとに読み、設定ディレクトリで引ける", async () => {
    const dir = configDir(validCredentials);
    const fetcher = vi.fn<UsageFetcher>(async () => ({ ok: true, body }));
    const collector = new PlanLimitsCollector(
      fetcher,
      () => [dir],
      () => NOW
    );
    await collector.collect();
    expect(fetcher).toHaveBeenCalledWith("tok");
    expect(collector.get(dir)?.fiveHour?.percent).toBe(42);
  });

  it("同じプロファイルのセッションが複数あっても1回だけ読む", async () => {
    const dir = configDir(validCredentials);
    const fetcher = vi.fn<UsageFetcher>(async () => ({ ok: true, body }));
    const collector = new PlanLimitsCollector(
      fetcher,
      () => [dir, dir],
      () => NOW
    );
    await collector.collect();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("失敗したら前の値を残す", async () => {
    const dir = configDir(validCredentials);
    const fetcher = vi
      .fn<UsageFetcher>()
      .mockResolvedValueOnce({ ok: true, body })
      .mockResolvedValueOnce({ ok: false, message: "HTTP 500" });
    const collector = new PlanLimitsCollector(
      fetcher,
      () => [dir],
      () => NOW
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await collector.collect();
    await collector.collect();
    expect(collector.get(dir)?.sevenDay?.percent).toBe(13);
  });

  it("期限切れのトークンではAPIを呼ばない", async () => {
    const dir = configDir({
      claudeAiOauth: { accessToken: "tok", expiresAt: NOW - 1 },
    });
    const fetcher = vi.fn<UsageFetcher>();
    const collector = new PlanLimitsCollector(
      fetcher,
      () => [dir],
      () => NOW
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await collector.collect();
    expect(fetcher).not.toHaveBeenCalled();
    expect(collector.get(dir)).toBeNull();
  });

  it("セッションが無くなったプロファイルの値を捨てる", async () => {
    const dir = configDir(validCredentials);
    let dirs = [dir];
    const fetcher = vi.fn<UsageFetcher>(async () => ({ ok: true, body }));
    const collector = new PlanLimitsCollector(
      fetcher,
      () => dirs,
      () => NOW
    );
    await collector.collect();
    dirs = [];
    await collector.collect();
    expect(collector.get(dir)).toBeNull();
  });
});
