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
  on(
    event: "message",
    listener: (data: Buffer | ArrayBuffer | Buffer[]) => void
  ): unknown;
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

/** ws の RawData (Buffer | ArrayBuffer | Buffer[]) を Buffer に正規化する */
function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

export class ScreenBridge {
  private readonly children = new Set<ChildProcess>();
  private readonly sockets = new Set<BridgeSocket>();
  /** closeAll から attach 内の SIGTERM→SIGKILL エスカレーションを再利用するための対応表 */
  private readonly stopFns = new Map<ChildProcess, () => void>();

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
    // child.exitCode は SIGTERM/SIGKILL で死んだ子プロセスでは null のまま
    // (signalCode 側に入る) なので、終了検知には自前のフラグを使う
    let exited = false;

    const closeSocket = (code: number, reason: string) => {
      if (ws.readyState === WS_OPEN) {
        ws.close(code, truncateReason(reason));
      }
    };

    const stopChild = () => {
      if (exited || killTimer) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    this.stopFns.set(child, stopChild);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_CAP);
    });
    // stdout → ws.send はバックプレッシャーを見ない: RFB はクライアント駆動
    // (FramebufferUpdateRequest) で応答が来るプロトコルであり、本ツールも
    // 単一ユーザ前提なので、無制限バッファリングを許容してよしとする
    child.stdout?.on("data", (chunk: Buffer) => {
      if (ws.readyState === WS_OPEN) ws.send(chunk);
    });
    child.stdout?.on("error", error => {
      console.warn(`[ScreenBridge] stdout error: ${error.message}`);
    });
    child.stderr?.on("error", error => {
      console.warn(`[ScreenBridge] stderr error: ${error.message}`);
    });
    child.on("error", error => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      this.children.delete(child);
      this.stopFns.delete(child);
      closeSocket(1011, error.message);
    });
    // exit ではなく close を見る: exit は子プロセスの終了時点で発火するが
    // stdio に未配送のデータが残りうる。stderr の最後の行 (理由) が
    // close 前に届き切らず `ssh exited (255)` に劣化することがあるため
    child.on("close", (code, signal) => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      this.children.delete(child);
      this.stopFns.delete(child);
      if (code === 0) {
        closeSocket(1000, "");
      } else {
        closeSocket(1011, lastLine(stderr) || `ssh exited (${code ?? signal})`);
      }
    });

    // ssh が終わった直後に届いた message を stdin に書くと EPIPE が非同期の
    // error で出る。リスナが無いと未捕捉例外でサーバごと落ちるので握るが、
    // EPIPE 以外は原因調査のためログに残す
    child.stdin?.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        console.warn(`[ScreenBridge] stdin error: ${error.message}`);
      }
    });
    ws.on("message", data => {
      if (!exited && child.stdin && !child.stdin.destroyed) {
        // handleUpgrade で生成した socket は既定で binaryType: "nodebuffer"
        // なので通常は Buffer だが、型上は ArrayBuffer / Buffer[] もありうる
        child.stdin.write(toBuffer(data));
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
      const stop = this.stopFns.get(child);
      if (stop) {
        stop();
      } else {
        child.kill("SIGTERM");
      }
    }
    // 終了経路なので graceful close (close frame の往復) は待たない。
    // 相手が応答しないと ws は最大 30 秒 socket を握ったままになる
    for (const ws of this.sockets) {
      ws.terminate();
    }
    this.children.clear();
    this.sockets.clear();
    this.stopFns.clear();
  }
}

export const screenBridge = new ScreenBridge();
