/**
 * ttyd Login Instance Manager
 *
 * `claude /login` を tmux 内で実行する `arklogin-*` 専用セッションに対し、
 * Webターミナルアクセスを提供する ttyd プロセスを管理する。
 *
 * 既存 `TtydManager` と意図的に分離している:
 * - 独立したポート範囲（`TTYD_LOGIN_PORT_START〜_END`）を使用
 * - インスタンスマップを別管理し、通常セッションとライフサイクルが交差しない
 * - プロキシルートは `/ttyd-login/<profileId>/` にマウントされる
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import { TTYD_LOGIN_PORT_END, TTYD_LOGIN_PORT_START } from "./constants.js";

export interface TtydLoginInstance {
  sessionName: string;
  profileId: string;
  port: number;
  url: string;
}

interface TtydLoginInternal extends TtydLoginInstance {
  process: ChildProcess;
  startedAt: Date;
}

export class TtydLoginManager extends EventEmitter {
  private instances: Map<string, TtydLoginInternal> = new Map();
  /** 同一 sessionName への並行起動を防ぐための起動中 Promise マップ */
  private pendingStarts: Map<string, Promise<TtydLoginInstance>> = new Map();
  private nextPort: number;
  private readonly MIN_PORT: number;
  private readonly MAX_PORT: number;

  constructor(
    portStart: number = TTYD_LOGIN_PORT_START,
    portEnd: number = TTYD_LOGIN_PORT_END
  ) {
    super();
    this.MIN_PORT = portStart;
    this.MAX_PORT = portEnd;
    this.nextPort = portStart;
    this.checkTtydInstalled();
  }

  /** ttyd がインストールされているか確認 */
  private checkTtydInstalled(): void {
    try {
      execSync("which ttyd", { stdio: "pipe" });
    } catch {
      console.warn(
        "[TtydLoginManager] ttyd not found. Install it:\n" +
          "  macOS: brew install ttyd\n" +
          "  Ubuntu: apt install ttyd\n" +
          "  Or from: https://github.com/tsl0922/ttyd"
      );
    }
  }

  /**
   * 指定ポートが OS レベルで使用可能かチェック
   * 127.0.0.1 への bind を試行する（3秒タイムアウト）
   */
  private checkPortAvailable(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        server.close();
        resolve(false);
      }, 3000);

      const server = net.createServer();
      server.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      server.once("listening", () => {
        clearTimeout(timeout);
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
  }

  /**
   * 利用可能なポートを探す
   * 自身の管理ポートに加え、OS レベルでのバインド可否もチェックする
   */
  private async findAvailablePort(): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.instances.values()).map(i => i.port)
    );

    const totalPorts = this.MAX_PORT - this.MIN_PORT + 1;
    for (let i = 0; i < totalPorts; i++) {
      const port =
        this.MIN_PORT + ((this.nextPort - this.MIN_PORT + i) % totalPorts);
      if (usedPorts.has(port)) {
        continue;
      }
      const available = await this.checkPortAvailable(port);
      if (!available) {
        console.log(
          `[TtydLoginManager] Port ${port} is in use by another process, skipping`
        );
        continue;
      }
      this.nextPort = port + 1;
      if (this.nextPort > this.MAX_PORT) {
        this.nextPort = this.MIN_PORT;
      }
      return port;
    }
    throw new Error("Login port range exhausted");
  }

  /**
   * tmux ログインセッション用の ttyd を起動
   * 同一 sessionName に対して冪等（既存があれば既存を返す）
   */
  async startTtyd(
    sessionName: string,
    profileId: string
  ): Promise<TtydLoginInstance> {
    const existing = this.instances.get(sessionName);
    if (existing) {
      return this.toPublic(existing);
    }

    const pending = this.pendingStarts.get(sessionName);
    if (pending) {
      return pending;
    }

    const promise = this._startTtydInternal(sessionName, profileId);
    this.pendingStarts.set(sessionName, promise);

    try {
      return await promise;
    } finally {
      this.pendingStarts.delete(sessionName);
    }
  }

  /** ttyd 起動の内部処理 */
  private async _startTtydInternal(
    sessionName: string,
    profileId: string
  ): Promise<TtydLoginInstance> {
    const port = await this.findAvailablePort();
    const basePath = `/ttyd-login/${profileId}`;
    const url = `/ttyd-login/${profileId}/`;

    // 既存 TtydManager と同じ ttyd オプション体系を維持し、
    // iframe 埋め込み・プロキシ経由 WebSocket 接続が成立するようにする
    const ttydProcess = spawn(
      "ttyd",
      [
        "-W", // Writable（クライアント入力許可）
        "-p",
        port.toString(),
        "-i",
        process.platform === "darwin" ? "lo0" : "lo",
        "--base-path",
        basePath,
        "-t",
        "fontSize=14",
        "-t",
        "fontFamily=JetBrains Mono, Menlo, Monaco, monospace",
        "-t",
        'theme={"background":"#1a1b26","foreground":"#a9b1d6"}',
        "tmux",
        "attach-session",
        "-t",
        sessionName,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      }
    );

    const internal: TtydLoginInternal = {
      sessionName,
      profileId,
      port,
      url,
      process: ttydProcess,
      startedAt: new Date(),
    };

    // ttyd の起動完了を "Listening" 出力で待機
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("ttyd startup timeout"));
      }, 5000);

      let stderr = "";

      ttydProcess.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.includes("Listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });

      ttydProcess.on("error", error => {
        clearTimeout(timeout);
        reject(error);
      });

      ttydProcess.on("exit", code => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`ttyd exited with code ${code}: ${stderr}`));
        }
      });
    });

    this.instances.set(sessionName, internal);
    this.emit("instance:started", this.toPublic(internal));

    console.log(
      `[TtydLoginManager] Started ttyd for ${sessionName} (profile=${profileId}) on port ${port}`
    );

    // プロセス終了時の自動クリーンアップ
    ttydProcess.on("exit", code => {
      console.log(
        `[TtydLoginManager] ttyd for ${sessionName} exited with code ${code}`
      );
      this.instances.delete(sessionName);
      this.emit("instance:stopped", sessionName);
    });

    return this.toPublic(internal);
  }

  /**
   * sessionName に紐づく ttyd を停止
   * SIGTERM → 短いタイムアウト → 残っていれば SIGKILL
   */
  async stopTtyd(sessionName: string): Promise<void> {
    const internal = this.instances.get(sessionName);
    if (!internal) return;

    this.instances.delete(sessionName);

    const proc = internal.process;
    try {
      proc.kill("SIGTERM");
    } catch {
      // 既に終了していれば無視
    }

    // 250ms 待って残っていれば SIGKILL
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill("SIGKILL");
          }
        } catch {
          // 既に終了していれば無視
        }
        resolve();
      }, 250);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.emit("instance:stopped", sessionName);
    console.log(`[TtydLoginManager] Stopped ttyd for ${sessionName}`);
  }

  /** profileId に対応するアクティブログインのポートを取得 */
  getPort(profileId: string): number | null {
    for (const inst of this.instances.values()) {
      if (inst.profileId === profileId) return inst.port;
    }
    return null;
  }

  /** profileId に対応するインスタンスを取得（プロキシルートで使用） */
  getInstance(profileId: string): TtydLoginInstance | null {
    for (const inst of this.instances.values()) {
      if (inst.profileId === profileId) return this.toPublic(inst);
    }
    return null;
  }

  /** 全 ttyd インスタンスを停止（graceful shutdown 用） */
  async stopAll(): Promise<void> {
    const sessionNames = Array.from(this.instances.keys());
    await Promise.all(sessionNames.map(name => this.stopTtyd(name)));
    console.log("[TtydLoginManager] Stopped all ttyd login instances");
  }

  /** 内部表現から公開表現へ変換 */
  private toPublic(internal: TtydLoginInternal): TtydLoginInstance {
    return {
      sessionName: internal.sessionName,
      profileId: internal.profileId,
      port: internal.port,
      url: internal.url,
    };
  }
}

export const ttydLoginManager = new TtydLoginManager();
