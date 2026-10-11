import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TunnelManager } from "./tunnel.js";

/**
 * 偽の cloudflared。
 * - 起動ごとに引数を FAKE_CLOUDFLARED_LOG へ 1 行追記する
 * - --metrics のアドレスで /ready を返す (ステータスは FAKE_CLOUDFLARED_READY)
 * - FAKE_CLOUDFLARED_EXIT_AFTER_MS が指定されていれば、その時間後に自分で終了する
 */
const FAKE_CLOUDFLARED = `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLOUDFLARED_LOG, JSON.stringify({ pid: process.pid, args }) + "\\n");
const metricsIndex = args.indexOf("--metrics");
if (metricsIndex >= 0) {
  const [host, port] = args[metricsIndex + 1].split(":");
  const status = Number(process.env.FAKE_CLOUDFLARED_READY || "200");
  http.createServer((req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status, readyConnections: status === 200 ? 4 : 0 }));
  }).listen(Number(port), host, () => {
    process.stderr.write("INF Starting tunnel\\nINF Registered tunnel connection connIndex=0\\n");
  });
}
const exitAfter = Number(process.env.FAKE_CLOUDFLARED_EXIT_AFTER_MS || "0");
if (exitAfter > 0) setTimeout(() => process.exit(1), exitAfter);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

interface SpawnRecord {
  pid: number;
  args: string[];
}

let tmpDir: string;
let fakePath: string;
let logPath: string;

function readSpawns(): SpawnRecord[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as SpawnRecord);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function createNamedTunnel(): TunnelManager {
  return new TunnelManager({
    localPort: 4001,
    mode: "named",
    namedTunnelOptions: {
      tunnelName: "test-tunnel",
      publicUrl: "https://ark.example.com",
    },
    healthCheck: { intervalMs: 50, unhealthyThresholdMs: 150 },
    cloudflaredPath: fakePath,
  });
}

describe("TunnelManager (Named Tunnel)", () => {
  let tunnel: TunnelManager | undefined;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-tunnel-test-"));
    fakePath = path.join(tmpDir, "cloudflared");
    fs.writeFileSync(fakePath, FAKE_CLOUDFLARED, { mode: 0o755 });
  });

  afterEach(() => {
    tunnel?.stop();
    tunnel = undefined;
    delete process.env.FAKE_CLOUDFLARED_READY;
    delete process.env.FAKE_CLOUDFLARED_EXIT_AFTER_MS;
    vi.restoreAllMocks();
  });

  function setup(env: Record<string, string> = {}) {
    logPath = path.join(tmpDir, `spawn-${Date.now()}-${Math.random()}.log`);
    process.env.FAKE_CLOUDFLARED_LOG = logPath;
    Object.assign(process.env, env);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tunnel = createNamedTunnel();
    return { tunnel, logs };
  }

  it("--metrics を tunnel のフラグとして渡し、出力を [cloudflared] 付きでログに流す", async () => {
    const { tunnel, logs } = setup();
    const url = await tunnel.start();

    expect(url).toBe("https://ark.example.com");
    const [spawned] = readSpawns();
    expect(spawned.args[0]).toBe("tunnel");
    expect(spawned.args[1]).toBe("--metrics");
    expect(spawned.args[2]).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(spawned.args.slice(3)).toEqual(["run", "test-tunnel"]);
    expect(logs).toContain(
      "[cloudflared] INF Registered tunnel connection connIndex=0"
    );
  });

  it("/ready が 200 のあいだは張り直さない", async () => {
    const { tunnel } = setup({ FAKE_CLOUDFLARED_READY: "200" });
    const onRestart = vi.fn();
    tunnel.on("restart", onRestart);
    await tunnel.start();

    await new Promise(resolve => setTimeout(resolve, 500));
    expect(onRestart).not.toHaveBeenCalled();
    expect(readSpawns()).toHaveLength(1);
  });

  it("/ready の 503 が続くと古いプロセスを落として張り直す", async () => {
    const { tunnel } = setup({ FAKE_CLOUDFLARED_READY: "503" });
    const onRestart = vi.fn();
    tunnel.on("restart", onRestart);
    await tunnel.start();
    const [first] = readSpawns();

    await waitFor(() => onRestart.mock.calls.length >= 1);
    expect(onRestart).toHaveBeenCalledWith("https://ark.example.com");
    const spawns = readSpawns();
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    expect(isAlive(first.pid)).toBe(false);
    // 古いプロセスの close で新しいプロセスの状態を消していない
    expect(tunnel.isRunning()).toBe(true);
    expect(tunnel.getUrl()).toBe("https://ark.example.com");
  });

  it("cloudflared が終了したら起動し直す", async () => {
    const { tunnel } = setup({
      FAKE_CLOUDFLARED_READY: "200",
      FAKE_CLOUDFLARED_EXIT_AFTER_MS: "100",
    });
    const onRestart = vi.fn();
    tunnel.on("restart", onRestart);
    await tunnel.start();
    // 張り直し後のプロセスは終了させない
    delete process.env.FAKE_CLOUDFLARED_EXIT_AFTER_MS;

    await waitFor(() => onRestart.mock.calls.length >= 1);
    expect(tunnel.isRunning()).toBe(true);
  });

  it("stop 後は張り直さない", async () => {
    const { tunnel } = setup({ FAKE_CLOUDFLARED_READY: "503" });
    const onRestart = vi.fn();
    tunnel.on("restart", onRestart);
    await tunnel.start();
    const [first] = readSpawns();

    tunnel.stop();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(onRestart).not.toHaveBeenCalled();
    expect(readSpawns()).toHaveLength(1);
    await waitFor(() => !isAlive(first.pid));
  });
});
