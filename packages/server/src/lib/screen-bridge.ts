/**
 * リモート画面ブリッジ
 *
 * WebSocket (noVNC) と `ssh -W <vncHost>:<vncPort>` の stdio を直結する。
 * websockify もローカルポートも使わないので、接続ごとの後始末は
 * 「socket が閉じたら子プロセスを止める」だけで決定的になる。
 */

import { type ChildProcess, spawn } from "node:child_process";

export interface ScreenSshTarget {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  vncHost: string;
  vncPort: number;
}

/** ws の WebSocket が満たす最小限。テストで差し替えられるようにする */
export interface BridgeSocket {
  readyState: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** SIGTERM → SIGKILL の猶予 (ミリ秒) */
const KILL_GRACE_MS = 3000;
/** stderr の保持上限 (バイト)。理由の抽出にしか使わない */
const STDERR_CAP = 4096;
/** WebSocket の close reason の上限 (RFC 6455) */
const CLOSE_REASON_MAX_BYTES = 123;
const WS_OPEN = 1;

export function buildSshArgs(target: ScreenSshTarget): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-p",
    String(target.sshPort),
    "-W",
    `${target.vncHost}:${target.vncPort}`,
    `${target.sshUser}@${target.sshHost}`,
  ];
}

/** UTF-8 の境界を壊さずに 123 バイトへ切り詰める */
function truncateReason(text: string): string {
  let out = text;
  while (Buffer.byteLength(out) > CLOSE_REASON_MAX_BYTES) {
    out = out.slice(0, -1);
  }
  return out;
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

export class ScreenBridge {
  private readonly children = new Set<ChildProcess>();
  private readonly sockets = new Set<BridgeSocket>();

  get activeCount(): number {
    return this.children.size;
  }

  attach(ws: BridgeSocket, target: ScreenSshTarget): void {
    const child = spawn("ssh", buildSshArgs(target), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    this.sockets.add(ws);

    let stderr = "";
    let killTimer: NodeJS.Timeout | null = null;

    const closeSocket = (code: number, reason: string) => {
      if (ws.readyState === WS_OPEN) {
        ws.close(code, truncateReason(reason));
      }
    };

    const stopChild = () => {
      if (child.exitCode !== null || killTimer) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_CAP);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (ws.readyState === WS_OPEN) ws.send(chunk);
    });
    child.on("error", error => {
      this.children.delete(child);
      closeSocket(1011, error.message);
    });
    child.on("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      this.children.delete(child);
      if (code === 0) {
        closeSocket(1000, "");
      } else {
        closeSocket(1011, lastLine(stderr) || `ssh exited (${code ?? signal})`);
      }
    });

    // ssh が終わった直後に届いた message を stdin に書くと EPIPE が非同期の
    // error で出る。リスナが無いと未捕捉例外でサーバごと落ちるので握る
    child.stdin?.on("error", () => {});
    ws.on("message", (data: Buffer) => {
      if (child.exitCode === null && child.stdin && !child.stdin.destroyed) {
        child.stdin.write(data);
      }
    });
    ws.on("close", () => {
      this.sockets.delete(ws);
      stopChild();
    });
    ws.on("error", stopChild);
  }

  /** サーバ停止時。残っている接続を閉じて ssh を止める */
  closeAll(): void {
    for (const child of this.children) {
      child.kill("SIGTERM");
    }
    for (const ws of this.sockets) {
      ws.close(1001, "server shutdown");
    }
    this.sockets.clear();
  }
}

export const screenBridge = new ScreenBridge();
