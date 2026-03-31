/**
 * ttyd Instance Manager
 *
 * tmuxセッションへのWebターミナルアクセスを提供するttydプロセスを管理する。
 * 各ttydインスタンスは1つのtmuxセッションを担当する。
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import { TTYD_PORT_END, TTYD_PORT_START } from "./constants.js";

export interface TtydInstance {
  sessionId: string;
  port: number;
  process: ChildProcess;
  tmuxSessionName: string;
  startedAt: Date;
}

export class TtydManager extends EventEmitter {
  private instances: Map<string, TtydInstance> = new Map();
  /** 起動中のPromiseを保持し、同じセッションに対する重複起動を防ぐ */
  private pendingStarts: Map<string, Promise<TtydInstance>> = new Map();
  private nextPort: number;
  private readonly MIN_PORT: number;
  private readonly MAX_PORT: number;

  constructor(startPort = TTYD_PORT_START, maxPort = TTYD_PORT_END) {
    super();
    this.MIN_PORT = startPort;
    this.nextPort = startPort;
    this.MAX_PORT = maxPort;
    this.checkTtydInstalled();
  }

  /**
   * ttydがインストールされているか確認
   */
  private checkTtydInstalled(): void {
    try {
      execSync("which ttyd", { stdio: "pipe" });
    } catch {
      console.warn(
        "[TtydManager] ttyd not found. Install it:\n" +
          "  macOS: brew install ttyd\n" +
          "  Ubuntu: apt install ttyd\n" +
          "  Or from: https://github.com/tsl0922/ttyd",
      );
    }
  }

  /**
   * 指定ポートがOSレベルで使用可能かチェック
   * 127.0.0.1にbindを試みて確認する（3秒タイムアウト付き）
   */
  private checkPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
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
   * 自身の管理ポートに加え、OSレベルでのバインド可否もチェックする
   */
  private async findAvailablePort(): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.instances.values()).map((i) => i.port),
    );

    // nextPortからMAX_PORTまで探し、見つからなければMIN_PORTからnextPort-1まで探索
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
          `[TtydManager] Port ${port} is in use by another process, skipping`,
        );
        continue;
      }
      this.nextPort = port + 1;
      if (this.nextPort > this.MAX_PORT) {
        this.nextPort = this.MIN_PORT;
      }
      return port;
    }
    throw new Error("No available ports for ttyd");
  }

  /**
   * tmuxセッション用のttydインスタンスを起動
   * 重複起動ガード付き: 同じセッションIDに対する並行起動を防ぐ
   */
  async startInstance(
    sessionId: string,
    tmuxSessionName: string,
  ): Promise<TtydInstance> {
    // 既に起動済み
    const existing = this.instances.get(sessionId);
    if (existing) {
      return existing;
    }

    // 既に起動中（別の呼び出しが進行中）
    const pending = this.pendingStarts.get(sessionId);
    if (pending) {
      return pending;
    }

    // 新規起動
    const promise = this._startInstanceInternal(sessionId, tmuxSessionName);
    this.pendingStarts.set(sessionId, promise);

    try {
      return await promise;
    } finally {
      this.pendingStarts.delete(sessionId);
    }
  }

  /**
   * ttydインスタンスの実際の起動処理（内部用）
   */
  private async _startInstanceInternal(
    sessionId: string,
    tmuxSessionName: string,
  ): Promise<TtydInstance> {
    const port = await this.findAvailablePort();
    const basePath = `/ttyd/${sessionId}`;

    // ttydオプション:
    // -W: クライアント入力を許可
    // -p: ポート番号
    // --base-path: WebSocket接続のベースパス（プロキシ経由用）
    // -t: ターミナルオプション（テーマ設定）
    // -i: バインドインターフェース（lo0でローカルのみ）
    const ttydProcess = spawn(
      "ttyd",
      [
        "-W", // Writable
        "-p",
        port.toString(),
        "-i",
        // ループバックインターフェース名はOSによって異なる
        // macOS: lo0, Linux: lo
        process.platform === "darwin" ? "lo0" : "lo",
        "--base-path",
        basePath, // プロキシ経由でのWebSocket接続に必要
        "-t",
        "fontSize=14",
        "-t",
        "fontFamily=JetBrains Mono, Menlo, Monaco, monospace",
        "-t",
        'theme={"background":"#1a1b26","foreground":"#a9b1d6"}',
        "tmux",
        "attach-session",
        "-t",
        tmuxSessionName,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );

    const instance: TtydInstance = {
      sessionId,
      port,
      process: ttydProcess,
      tmuxSessionName,
      startedAt: new Date(),
    };

    // ttydの起動を待つ
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("ttyd startup timeout"));
      }, 5000);

      let stderr = "";

      ttydProcess.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        // ttydは "Listening on port XXXX" を出力する
        if (stderr.includes("Listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });

      ttydProcess.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      ttydProcess.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`ttyd exited with code ${code}: ${stderr}`));
        }
      });
    });

    this.instances.set(sessionId, instance);
    this.emit("instance:started", instance);

    console.log(
      `[TtydManager] Started ttyd for ${tmuxSessionName} on port ${port}`,
    );

    // プロセス終了時の処理
    ttydProcess.on("exit", (code) => {
      console.log(
        `[TtydManager] ttyd for session ${sessionId} exited with code ${code}`,
      );
      this.instances.delete(sessionId);
      this.emit("instance:stopped", sessionId);
    });

    return instance;
  }

  /**
   * ttydインスタンスを停止
   */
  stopInstance(sessionId: string): void {
    const instance = this.instances.get(sessionId);
    if (!instance) return;

    instance.process.kill("SIGTERM");
    this.instances.delete(sessionId);
    this.emit("instance:stopped", sessionId);

    console.log(`[TtydManager] Stopped ttyd for session ${sessionId}`);
  }

  /**
   * セッションIDでttydインスタンスを取得
   */
  getInstance(sessionId: string): TtydInstance | undefined {
    return this.instances.get(sessionId);
  }

  /**
   * 全インスタンスを取得
   */
  getAllInstances(): TtydInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * 全インスタンスを停止
   */
  cleanup(): void {
    for (const instance of Array.from(this.instances.values())) {
      instance.process.kill("SIGTERM");
    }
    this.instances.clear();
    console.log("[TtydManager] Cleaned up all ttyd instances");
  }
}

export const ttydManager = new TtydManager();
