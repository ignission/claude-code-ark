/**
 * screen-bridge のテスト。ssh は spawn をモックして、
 * stdin をそのまま stdout に返す偽プロセスで代用する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  type BridgeSocket,
  buildSshArgs,
  ScreenBridge,
} from "./screen-bridge.js";

const mockedSpawn = vi.mocked(spawn);

const target = {
  sshHost: "build.example.internal",
  sshPort: 2222,
  sshUser: "user",
  vncHost: "127.0.0.1",
  vncPort: 5900,
};

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
    signalCode: string | null;
    /** Node の実際の挙動を模す: シグナル死は exitCode=null / signalCode=シグナル名 */
    exit(code: number | null, signal: string | null): void;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.exit = (code, signal) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("close", code, signal);
  };
  return child;
}

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter &
    BridgeSocket & {
      sent: Buffer[];
      closed: Array<{ code?: number; reason?: string }>;
    };
  socket.sent = [];
  socket.closed = [];
  socket.readyState = 1;
  socket.send = vi.fn((data: Buffer) => {
    socket.sent.push(Buffer.from(data));
  });
  socket.close = vi.fn((code?: number, reason?: string) => {
    socket.readyState = 3;
    socket.closed.push({ code, reason });
  });
  socket.terminate = vi.fn();
  return socket;
}

describe("buildSshArgs", () => {
  it("BatchMode と -W で VNC ポートへ繋ぐ引数を組み立てる", () => {
    expect(buildSshArgs(target)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "2222",
      "-W",
      "127.0.0.1:5900",
      "user@build.example.internal",
    ]);
  });
});

describe("ScreenBridge", () => {
  let bridge: ScreenBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new ScreenBridge();
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("WebSocket の受信を ssh の stdin へ、stdout を WebSocket へ流す", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    expect(mockedSpawn).toHaveBeenCalledWith("ssh", buildSshArgs(target), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(bridge.activeCount).toBe(1);

    const received: Buffer[] = [];
    child.stdin.on("data", chunk => received.push(chunk));
    socket.emit("message", Buffer.from("RFB 003.008\n"));
    expect(Buffer.concat(received).toString()).toBe("RFB 003.008\n");

    child.stdout.write(Buffer.from("RFB 003.889\n"));
    expect(Buffer.concat(socket.sent).toString()).toBe("RFB 003.889\n");
  });

  it("message が Buffer[] のときは連結して stdin に書く", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    const received: Buffer[] = [];
    child.stdin.on("data", chunk => received.push(chunk));
    socket.emit("message", [Buffer.from("RFB "), Buffer.from("003.008\n")]);
    expect(Buffer.concat(received).toString()).toBe("RFB 003.008\n");
  });

  it("WebSocket が閉じたら ssh を SIGTERM し、猶予後に SIGKILL する", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    socket.emit("close");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("SIGTERM でシグナル死したら SIGKILL へエスカレーションしない", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    socket.emit("close");
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // 自分で送った SIGTERM によって子プロセスがシグナル死した状態を模す
    child.exit(null, "SIGTERM");

    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(bridge.activeCount).toBe(0);
  });

  it("WebSocket の error は ssh を SIGTERM で止める", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    socket.emit("error", new Error("boom"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("ssh が非 0 で終わったら stderr の最後の行を理由に載せて閉じる", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    child.stderr.write("Warning: something\n");
    child.stderr.write(
      "user@build.example.internal: Permission denied (publickey).\n"
    );
    child.exit(255, null);

    expect(socket.closed).toEqual([
      {
        code: 1011,
        reason: "user@build.example.internal: Permission denied (publickey).",
      },
    ]);
    expect(bridge.activeCount).toBe(0);
  });

  it("ssh が 0 で終わったら通常終了で閉じる", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    child.exit(0, null);
    expect(socket.closed).toEqual([{ code: 1000, reason: "" }]);
  });

  it("理由は 123 バイトに切り詰める", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    const originalLine = "あ".repeat(100);
    child.stderr.write(`${originalLine}\n`);
    child.exit(1, null);

    const reason = socket.closed[0].reason ?? "";
    expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
    expect(reason.length).toBeGreaterThan(0);
    expect(originalLine.startsWith(reason)).toBe(true);
  });

  it("spawn の error は 1011 で閉じる", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    child.emit("error", new Error("spawn ssh ENOENT"));
    expect(socket.closed).toEqual([{ code: 1011, reason: "spawn ssh ENOENT" }]);
  });

  it("ssh 終了後に届いた message は書かず、例外も出さない", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    child.exit(1, null);
    const received: Buffer[] = [];
    child.stdin.on("data", chunk => received.push(chunk));
    expect(() => socket.emit("message", Buffer.from("late"))).not.toThrow();
    expect(received).toEqual([]);
  });

  it("closeAll は残っている接続をすべて閉じる", () => {
    const children = [fakeChild(), fakeChild()];
    mockedSpawn
      .mockReturnValueOnce(children[0] as never)
      .mockReturnValueOnce(children[1] as never);
    const sockets = [fakeSocket(), fakeSocket()];
    bridge.attach(sockets[0], target);
    bridge.attach(sockets[1], target);

    bridge.closeAll();
    // 終了経路では close frame の往復を待たずに切る
    expect(sockets[0].terminate).toHaveBeenCalled();
    expect(sockets[1].terminate).toHaveBeenCalled();
    expect(sockets[0].close).not.toHaveBeenCalled();
    expect(sockets[1].close).not.toHaveBeenCalled();
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("closeAll は activeCount を 0 にし、猶予後に SIGKILL へエスカレーションする", () => {
    const children = [fakeChild(), fakeChild()];
    mockedSpawn
      .mockReturnValueOnce(children[0] as never)
      .mockReturnValueOnce(children[1] as never);
    const sockets = [fakeSocket(), fakeSocket()];
    bridge.attach(sockets[0], target);
    bridge.attach(sockets[1], target);

    bridge.closeAll();
    expect(bridge.activeCount).toBe(0);

    // ssh がまだ生きている (close が来ていない) 想定で猶予を進める
    vi.advanceTimersByTime(3000);
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(children[1].kill).toHaveBeenCalledWith("SIGKILL");
  });
});
