import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLineSplitter,
  TunnelHealthMonitor,
  type TunnelProbeResult,
} from "./tunnel-health-monitor.js";

const healthy: TunnelProbeResult = { healthy: true, detail: "/ready 200" };
const unhealthy: TunnelProbeResult = { healthy: false, detail: "/ready 503" };

function createMonitor(probeResults: Array<TunnelProbeResult | Error>) {
  let now = 0;
  const probe = vi.fn(async () => {
    const next = probeResults.shift() ?? healthy;
    if (next instanceof Error) throw next;
    return next;
  });
  const onUnhealthy = vi.fn(async () => {});
  const monitor = new TunnelHealthMonitor({
    probe,
    onUnhealthy,
    intervalMs: 1000,
    unhealthyThresholdMs: 3000,
    now: () => now,
  });
  monitor.start();
  /** 時計を進めて 1 回確認する */
  const tickAt = async (time: number) => {
    now = time;
    await monitor.tick();
  };
  return { monitor, probe, onUnhealthy, tickAt };
}

describe("TunnelHealthMonitor", () => {
  let monitor: TunnelHealthMonitor | undefined;

  afterEach(() => {
    monitor?.stop();
    vi.restoreAllMocks();
  });

  it("不健全が閾値未満なら張り直さない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = createMonitor([unhealthy, unhealthy, unhealthy]);
    monitor = m.monitor;
    await m.tickAt(0);
    await m.tickAt(1000);
    await m.tickAt(2999);
    expect(m.onUnhealthy).not.toHaveBeenCalled();
  });

  it("不健全が閾値以上続いたら 1 回だけ張り直す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = createMonitor([unhealthy, unhealthy, unhealthy]);
    monitor = m.monitor;
    await m.tickAt(0);
    await m.tickAt(3000);
    expect(m.onUnhealthy).toHaveBeenCalledTimes(1);
    // 張り直し直後は数え直すので、すぐには再実行しない
    await m.tickAt(4000);
    expect(m.onUnhealthy).toHaveBeenCalledTimes(1);
  });

  it("途中で健全に戻ったら数え直す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const m = createMonitor([unhealthy, healthy, unhealthy, unhealthy]);
    monitor = m.monitor;
    await m.tickAt(0);
    await m.tickAt(2000);
    await m.tickAt(2500);
    await m.tickAt(5000);
    expect(m.onUnhealthy).not.toHaveBeenCalled();
  });

  it("probe の例外は不健全として扱う", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = createMonitor([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
    ]);
    monitor = m.monitor;
    await m.tickAt(0);
    await m.tickAt(3000);
    expect(m.onUnhealthy).toHaveBeenCalledTimes(1);
  });

  it("張り直しが失敗しても次は閾値ぶん待ってから再試行する", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const m = createMonitor([unhealthy, unhealthy, unhealthy, unhealthy]);
    monitor = m.monitor;
    m.onUnhealthy.mockRejectedValueOnce(new Error("timeout"));
    await m.tickAt(0);
    await m.tickAt(3000);
    expect(m.onUnhealthy).toHaveBeenCalledTimes(1);
    await m.tickAt(4000);
    expect(m.onUnhealthy).toHaveBeenCalledTimes(1);
    await m.tickAt(7000);
    expect(m.onUnhealthy).toHaveBeenCalledTimes(2);
  });

  it("stop 後は probe の結果を使わない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = createMonitor([unhealthy, unhealthy]);
    monitor = m.monitor;
    await m.tickAt(0);
    m.monitor.stop();
    await m.tickAt(3000);
    expect(m.onUnhealthy).not.toHaveBeenCalled();
    expect(m.monitor.isRunning()).toBe(false);
  });

  it("interval ごとに probe を呼ぶ", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => healthy);
      monitor = new TunnelHealthMonitor({
        probe,
        onUnhealthy: async () => {},
        intervalMs: 1000,
        unhealthyThresholdMs: 3000,
      });
      monitor.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(probe).toHaveBeenCalledTimes(3);
      monitor.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createLineSplitter", () => {
  it("チャンクをまたぐ行を 1 行にまとめ、空行は捨てる", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter(line => lines.push(line));
    splitter.push("INF Starting tun");
    splitter.push("nel\r\n\nINF Registered tunnel connection\nWRN par");
    expect(lines).toEqual([
      "INF Starting tunnel",
      "INF Registered tunnel connection",
    ]);
    splitter.flush();
    expect(lines).toEqual([
      "INF Starting tunnel",
      "INF Registered tunnel connection",
      "WRN par",
    ]);
  });

  it("改行が来なくても上限を超えたら吐き出す", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter(line => lines.push(line), 10);
    splitter.push("a".repeat(11));
    expect(lines).toEqual(["a".repeat(11)]);
  });
});
