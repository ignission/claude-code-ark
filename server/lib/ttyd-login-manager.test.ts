/**
 * TtydLoginManager のユニットテスト
 *
 * `child_process.spawn` と `net.createServer` をモックし、実プロセスを
 * 起動せずに起動・停止・ポート割り当てロジックを検証する。
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// child_process.spawn / execSync をモック
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
    execSync: vi.fn(() => Buffer.from("/usr/bin/ttyd")),
  };
});

// net.createServer をモックし、checkPortAvailable を即座に true で解決させる
vi.mock("node:net", () => {
  return {
    default: {
      createServer: vi.fn(() => {
        const srv = new EventEmitter() as EventEmitter & {
          listen: (port: number, host: string) => void;
          close: (cb?: () => void) => void;
        };
        srv.listen = (_port: number, _host: string) => {
          // 次のtickで listening を発火させ、checkPortAvailable を成立させる
          setImmediate(() => srv.emit("listening"));
        };
        srv.close = (cb?: () => void) => {
          if (cb) setImmediate(cb);
        };
        return srv;
      }),
    },
  };
});

import { spawn } from "node:child_process";
import { TtydLoginManager } from "./ttyd-login-manager.js";

/**
 * モック ttyd プロセスを作成
 * - stderr に "Listening on port ..." を流して startup を完了させる
 * - kill() は exit イベントを発火する
 */
function createMockTtydProcess(): EventEmitter & {
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: string | null;
  };
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal?: string) => {
    proc.signalCode = signal ?? "SIGTERM";
    setImmediate(() => proc.emit("exit", 0, signal));
    return true;
  });

  // 次のtickで起動完了を通知
  setImmediate(() => {
    proc.stderr.emit("data", Buffer.from("Listening on port\n"));
  });

  return proc;
}

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

describe("TtydLoginManager", () => {
  let manager: TtydLoginManager;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockTtydProcess());
    // 小さなポート範囲で複数テストの独立性を保つ
    manager = new TtydLoginManager(7800, 7802);
  });

  afterEach(async () => {
    await manager.stopAll();
  });

  it("startTtyd で範囲内のポートを割り当て、getPort で取得できる", async () => {
    const inst = await manager.startTtyd("arklogin-p1", "p1");

    expect(inst.sessionName).toBe("arklogin-p1");
    expect(inst.profileId).toBe("p1");
    expect(inst.port).toBeGreaterThanOrEqual(7800);
    expect(inst.port).toBeLessThanOrEqual(7802);
    expect(inst.url).toBe("/ttyd-login/p1/");
    expect(manager.getPort("p1")).toBe(inst.port);

    // ttyd の base-path に profileId が含まれること
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--base-path");
    expect(args).toContain("/ttyd-login/p1");
    expect(args).toContain("attach-session");
    expect(args).toContain("arklogin-p1");
  });

  it("同一 sessionName で再呼び出ししても二重起動しない", async () => {
    const a = await manager.startTtyd("arklogin-p1", "p1");
    const b = await manager.startTtyd("arklogin-p1", "p1");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a.port).toBe(b.port);
  });

  it("並行 startTtyd 呼び出しでも一度しか spawn しない（pendingStarts）", async () => {
    const [a, b] = await Promise.all([
      manager.startTtyd("arklogin-p1", "p1"),
      manager.startTtyd("arklogin-p1", "p1"),
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a.port).toBe(b.port);
  });

  it("stopTtyd で instances から削除され、getPort が null を返す", async () => {
    const inst = await manager.startTtyd("arklogin-p1", "p1");
    expect(manager.getPort("p1")).toBe(inst.port);

    await manager.stopTtyd("arklogin-p1");

    expect(manager.getPort("p1")).toBeNull();
    expect(manager.getInstance("p1")).toBeNull();
  });

  it("ポート範囲が枯渇したら Login port range exhausted を投げる", async () => {
    // 範囲は 7800〜7802 = 3 ポート
    await manager.startTtyd("arklogin-p1", "p1");
    await manager.startTtyd("arklogin-p2", "p2");
    await manager.startTtyd("arklogin-p3", "p3");

    await expect(manager.startTtyd("arklogin-p4", "p4")).rejects.toThrow(
      /Login port range exhausted/
    );
  });

  it("stopAll で複数インスタンスをすべて停止する", async () => {
    await manager.startTtyd("arklogin-p1", "p1");
    await manager.startTtyd("arklogin-p2", "p2");

    expect(manager.getPort("p1")).not.toBeNull();
    expect(manager.getPort("p2")).not.toBeNull();

    await manager.stopAll();

    expect(manager.getPort("p1")).toBeNull();
    expect(manager.getPort("p2")).toBeNull();
  });

  it("getInstance(profileId) は profileId 一致のインスタンスを返す", async () => {
    const inst = await manager.startTtyd("arklogin-p1", "p1");

    const found = manager.getInstance("p1");
    expect(found).not.toBeNull();
    expect(found?.profileId).toBe("p1");
    expect(found?.port).toBe(inst.port);
    expect(found?.url).toBe("/ttyd-login/p1/");

    expect(manager.getInstance("nonexistent")).toBeNull();
  });
});
