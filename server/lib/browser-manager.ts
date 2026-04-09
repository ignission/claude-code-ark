/**
 * Browser Manager（noVNC方式）
 *
 * Xvfb + Chromium + x11vnc + websockify を使用して
 * ブラウザをリモートから操作可能にするマネージャー。
 * TtydManagerと同じEventEmitter + シングルトンパターンで実装。
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import type { BrowserSession } from "../../shared/types.js";
import {
  DISPLAY_START,
  VNC_PORT_END,
  VNC_PORT_START,
  WS_PORT_END,
  WS_PORT_START,
} from "./constants.js";

/** ブラウザセッションの最大同時数 */
const MAX_SESSIONS = 10;

/** 各プロセスの起動タイムアウト（ミリ秒） */
const XVFB_TIMEOUT = 5000;
const CHROMIUM_DELAY = 2000;
const X11VNC_TIMEOUT = 5000;
const WEBSOCKIFY_TIMEOUT = 5000;

/** stop時のSIGTERM→SIGKILL待機時間（ミリ秒） */
const KILL_GRACE_PERIOD = 3000;

/** Xvfb仮想ディスプレイの解像度 */
const DISPLAY_RESOLUTION = "1280x900x24";

/** 許可するURLのプロトコル */
const ALLOWED_PROTOCOLS = ["http:", "https:"];
/** 許可するホスト名（SSRF対策） */
const ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1"];

/** Chromiumの起動フラグ */
const CHROMIUM_FLAGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
  "--disable-extensions",
  "--disable-sync",
  "--disable-translate",
  "--no-first-run",
  "--disable-default-apps",
  "--window-size=1280,900",
  "--window-position=0,0",
];

/** セッションに紐づく4プロセスの組 */
interface BrowserProcessSet {
  id: string;
  targetPort: number;
  targetUrl: string;
  wsPort: number;
  vncPort: number;
  displayNum: number;
  devtools: boolean;
  xvfb: ChildProcess;
  chromium: ChildProcess;
  x11vnc: ChildProcess;
  websockify: ChildProcess;
  createdAt: Date;
}

export class BrowserManager extends EventEmitter {
  private sessions: Map<string, BrowserProcessSet> = new Map();
  /** 起動中のPromiseを保持し、同じポートへの重複起動を防ぐ */
  private pendingStarts: Map<number, Promise<BrowserSession>> = new Map();
  private nextVncPort: number;
  private nextWsPort: number;
  private nextDisplay: number;
  /** 依存コマンドが全て揃っているか */
  private available = true;
  /** 検出されたChromiumコマンド名 */
  private chromiumCmd = "";
  /** noVNCの静的ファイルパス */
  private novncPath = "";

  constructor() {
    super();
    this.nextVncPort = VNC_PORT_START;
    this.nextWsPort = WS_PORT_START;
    this.nextDisplay = DISPLAY_START;
    this.checkDependencies();
  }

  /**
   * 依存コマンド・パスの存在チェック
   * 不足時はavailable=falseにしてログ警告（Ark全体の起動は妨げない）
   */
  private checkDependencies(): void {
    const missing: string[] = [];

    // Xvfb
    if (!this.commandExists("Xvfb")) {
      missing.push("Xvfb");
    }

    // x11vnc
    if (!this.commandExists("x11vnc")) {
      missing.push("x11vnc");
    }

    // websockify
    if (!this.commandExists("websockify")) {
      missing.push("websockify");
    }

    // Chromium（複数の候補から探す）
    // snap版chromium-browserはpm2/systemd環境でX11にアクセスできないため、
    // Playwright版のchromiumバイナリを優先的に使用する
    const chromiumFound = this.findChromiumBinary();
    if (chromiumFound) {
      this.chromiumCmd = chromiumFound;
    } else {
      missing.push("chromium-browser/chromium/google-chrome");
    }

    // noVNCパス
    const novncCandidates = [
      "/usr/share/novnc",
      "/usr/share/noVNC",
      "/usr/local/share/novnc",
    ];
    let novncFound = false;
    for (const p of novncCandidates) {
      if (fs.existsSync(p)) {
        this.novncPath = p;
        novncFound = true;
        break;
      }
    }
    if (!novncFound) {
      missing.push("noVNC (/usr/share/novnc)");
    }

    if (missing.length > 0) {
      this.available = false;
      console.warn(
        `[BrowserManager] 以下の依存が不足しています: ${missing.join(", ")}\n` +
          "  リモートブラウザ機能は無効化されます。\n" +
          "  Ubuntu: apt install xvfb x11vnc novnc websockify chromium-browser"
      );
    }
  }

  /**
   * Chromiumバイナリを検索する
   * snap版はpm2/systemd環境でX11にアクセスできないため、
   * Playwright版のバイナリパスを優先的に探す
   */
  private findChromiumBinary(): string | null {
    // 1. Playwright版Chromium（snap制約なし）
    const homeDir = process.env.HOME || "/root";
    const playwrightDir = `${homeDir}/.cache/ms-playwright`;
    if (fs.existsSync(playwrightDir)) {
      try {
        const dirs = fs
          .readdirSync(playwrightDir)
          .filter(d => d.startsWith("chromium-"))
          .sort()
          .reverse(); // 最新版を優先
        for (const dir of dirs) {
          const chromePath = `${playwrightDir}/${dir}/chrome-linux/chrome`;
          if (fs.existsSync(chromePath)) {
            console.log(
              `[BrowserManager] Playwright Chromium検出: ${chromePath}`
            );
            return chromePath;
          }
        }
      } catch {
        // ディレクトリ読み取り失敗は無視
      }
    }

    // 2. システムのChromium（snap版でないもの）
    for (const cmd of ["chromium-browser", "chromium", "google-chrome"]) {
      if (this.commandExists(cmd)) {
        return cmd;
      }
    }

    return null;
  }

  /**
   * コマンドの存在チェック（シェルインジェクション防止のためexecFileSync使用）
   */
  private commandExists(cmd: string): boolean {
    try {
      execFileSync("which", [cmd], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * リモートブラウザ機能が利用可能かどうか
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * 指定ポートがOSレベルで使用可能かチェック
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
   * 利用可能なVNCポートを探す（循環ポート探索パターン）
   */
  private async findAvailableVncPort(): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.sessions.values()).map(s => s.vncPort)
    );
    const totalPorts = VNC_PORT_END - VNC_PORT_START + 1;
    for (let i = 0; i < totalPorts; i++) {
      const port =
        VNC_PORT_START + ((this.nextVncPort - VNC_PORT_START + i) % totalPorts);
      if (usedPorts.has(port)) continue;
      const available = await this.checkPortAvailable(port);
      if (!available) {
        console.log(
          `[BrowserManager] VNCポート ${port} は使用中のためスキップ`
        );
        continue;
      }
      this.nextVncPort = port + 1;
      if (this.nextVncPort > VNC_PORT_END) {
        this.nextVncPort = VNC_PORT_START;
      }
      return port;
    }
    throw new Error("利用可能なVNCポートがありません");
  }

  /**
   * 利用可能なWebSocketポートを探す（循環ポート探索パターン）
   */
  private async findAvailableWsPort(): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.sessions.values()).map(s => s.wsPort)
    );
    const totalPorts = WS_PORT_END - WS_PORT_START + 1;
    for (let i = 0; i < totalPorts; i++) {
      const port =
        WS_PORT_START + ((this.nextWsPort - WS_PORT_START + i) % totalPorts);
      if (usedPorts.has(port)) continue;
      const available = await this.checkPortAvailable(port);
      if (!available) {
        console.log(`[BrowserManager] WSポート ${port} は使用中のためスキップ`);
        continue;
      }
      this.nextWsPort = port + 1;
      if (this.nextWsPort > WS_PORT_END) {
        this.nextWsPort = WS_PORT_START;
      }
      return port;
    }
    throw new Error("利用可能なWebSocketポートがありません");
  }

  /**
   * 利用可能なディスプレイ番号を探す
   */
  private findAvailableDisplay(): number {
    const usedDisplays = new Set(
      Array.from(this.sessions.values()).map(s => s.displayNum)
    );
    const maxDisplay = DISPLAY_START + 100; // 99〜198
    const totalDisplays = maxDisplay - DISPLAY_START + 1;
    for (let i = 0; i < totalDisplays; i++) {
      const display =
        DISPLAY_START +
        ((this.nextDisplay - DISPLAY_START + i) % totalDisplays);
      if (usedDisplays.has(display)) continue;
      this.nextDisplay = display + 1;
      if (this.nextDisplay > maxDisplay) {
        this.nextDisplay = DISPLAY_START;
      }
      return display;
    }
    throw new Error("利用可能なディスプレイ番号がありません");
  }

  /**
   * URLのSSRF検証
   * localhost/127.0.0.1 かつ http/https のみ許可
   */
  private validateUrl(url: string): void {
    const parsed = new URL(url);
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      throw new Error(
        `許可されていないプロトコルです: ${parsed.protocol} (http/httpsのみ許可)`
      );
    }
    if (!ALLOWED_HOSTNAMES.includes(parsed.hostname)) {
      throw new Error(
        `許可されていないホスト名です: ${parsed.hostname} (localhost/127.0.0.1のみ許可)`
      );
    }
  }

  /**
   * ブラウザセッションを開始
   * 重複起動ガード付き: 同じポートに対する並行起動を防ぐ
   */
  async start(
    port: number,
    url?: string,
    devtools?: boolean
  ): Promise<BrowserSession> {
    if (!this.available) {
      throw new Error(
        "リモートブラウザ機能の依存が不足しています。サーバーログを確認してください。"
      );
    }

    // セッション上限チェック
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `ブラウザセッションの上限（${MAX_SESSIONS}）に達しています`
      );
    }

    // URL検証（SSRF対策）
    const targetUrl = url || `http://localhost:${port}`;
    this.validateUrl(targetUrl);

    // 同じポートへの重複起動防止
    const pending = this.pendingStarts.get(port);
    if (pending) {
      return pending;
    }

    const promise = this._startInternal(port, targetUrl, devtools ?? false);
    this.pendingStarts.set(port, promise);

    try {
      return await promise;
    } finally {
      this.pendingStarts.delete(port);
    }
  }

  /**
   * ブラウザセッションの実際の起動処理（内部用）
   * 起動順: Xvfb → Chromium → x11vnc → websockify
   */
  private async _startInternal(
    targetPort: number,
    targetUrl: string,
    devtools: boolean
  ): Promise<BrowserSession> {
    const id = randomUUID();
    const displayNum = this.findAvailableDisplay();
    const vncPort = await this.findAvailableVncPort();
    const wsPort = await this.findAvailableWsPort();

    const startedProcesses: ChildProcess[] = [];

    try {
      // 1. Xvfb起動
      const xvfb = spawn(
        "Xvfb",
        [`:${displayNum}`, "-screen", "0", DISPLAY_RESOLUTION],
        { stdio: ["ignore", "pipe", "pipe"], detached: false }
      );
      startedProcesses.push(xvfb);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Xvfb起動タイムアウト"));
        }, XVFB_TIMEOUT);

        const socketPath = `/tmp/.X11-unix/X${displayNum}`;
        const checkInterval = setInterval(() => {
          if (fs.existsSync(socketPath)) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);

        xvfb.on("error", error => {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          reject(error);
        });

        xvfb.on("exit", code => {
          if (code !== 0 && code !== null) {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            reject(new Error(`Xvfbが終了しました (code: ${code})`));
          }
        });
      });

      console.log(`[BrowserManager] Xvfb起動完了: ディスプレイ :${displayNum}`);

      // 2. Chromium起動
      const chromiumFlags = [...CHROMIUM_FLAGS];
      if (devtools) {
        chromiumFlags.push("--auto-open-devtools-for-tabs");
      }
      chromiumFlags.push(targetUrl);

      const chromium = spawn(this.chromiumCmd, chromiumFlags, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: {
          ...process.env,
          DISPLAY: `:${displayNum}`,
        },
      });
      startedProcesses.push(chromium);

      // Chromiumはreadiness出力がないため固定ディレイで待機
      await new Promise<void>(resolve => setTimeout(resolve, CHROMIUM_DELAY));

      console.log(
        `[BrowserManager] Chromium起動完了: ${targetUrl} (DISPLAY=:${displayNum})`
      );

      // 3. x11vnc起動
      const x11vnc = spawn(
        "x11vnc",
        [
          "-display",
          `:${displayNum}`,
          "-rfbport",
          vncPort.toString(),
          "-listen",
          "127.0.0.1",
          "-shared",
          "-forever",
          "-nopw",
          "-noxdamage",
        ],
        { stdio: ["ignore", "pipe", "pipe"], detached: false }
      );
      startedProcesses.push(x11vnc);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("x11vnc起動タイムアウト"));
        }, X11VNC_TIMEOUT);

        let outputData = "";

        const onData = (data: Buffer) => {
          outputData += data.toString();
          // x11vncは起動時に "PORT=XXXX" を stdout に出力する
          if (outputData.includes("PORT=")) {
            clearTimeout(timeout);
            resolve();
          }
        };

        x11vnc.stdout?.on("data", onData);
        x11vnc.stderr?.on("data", onData);

        x11vnc.on("error", error => {
          clearTimeout(timeout);
          reject(error);
        });

        x11vnc.on("exit", code => {
          if (code !== 0 && code !== null) {
            clearTimeout(timeout);
            reject(
              new Error(`x11vncが終了しました (code: ${code}): ${outputData}`)
            );
          }
        });
      });

      console.log(`[BrowserManager] x11vnc起動完了: ポート ${vncPort}`);

      // 4. websockify起動
      const websockify = spawn(
        "websockify",
        [
          "--web",
          this.novncPath,
          `127.0.0.1:${wsPort}`,
          `127.0.0.1:${vncPort}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"], detached: false }
      );
      startedProcesses.push(websockify);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("websockify起動タイムアウト"));
        }, WEBSOCKIFY_TIMEOUT);

        let outputData = "";

        const onData = (data: Buffer) => {
          outputData += data.toString();
          if (
            outputData.includes("WebSocket") ||
            outputData.includes("listening")
          ) {
            clearTimeout(timeout);
            resolve();
          }
        };

        websockify.stdout?.on("data", onData);
        websockify.stderr?.on("data", onData);

        websockify.on("error", error => {
          clearTimeout(timeout);
          reject(error);
        });

        websockify.on("exit", code => {
          if (code !== 0 && code !== null) {
            clearTimeout(timeout);
            reject(
              new Error(
                `websockifyが終了しました (code: ${code}): ${outputData}`
              )
            );
          }
        });
      });

      console.log(
        `[BrowserManager] websockify起動完了: WSポート ${wsPort} → VNCポート ${vncPort}`
      );

      // セッション情報を保存
      const processSet: BrowserProcessSet = {
        id,
        targetPort,
        targetUrl,
        wsPort,
        vncPort,
        displayNum,
        devtools,
        xvfb,
        chromium,
        x11vnc,
        websockify,
        createdAt: new Date(),
      };
      this.sessions.set(id, processSet);

      // プロセスの異常終了監視: いずれかが終了したらセッション全体をstop
      const processNames = [
        "xvfb",
        "chromium",
        "x11vnc",
        "websockify",
      ] as const;
      const processes = [xvfb, chromium, x11vnc, websockify];

      for (let i = 0; i < processes.length; i++) {
        const proc = processes[i];
        const name = processNames[i];
        proc.on("exit", code => {
          // セッションがまだ存在する場合のみ（明示的なstopではない場合）
          if (this.sessions.has(id)) {
            console.warn(
              `[BrowserManager] ${name}が予期せず終了しました (code: ${code})。セッション ${id} を停止します。`
            );
            this.stop(id).catch(err => {
              console.error(
                `[BrowserManager] セッション ${id} の停止に失敗:`,
                err
              );
            });
          }
        });
      }

      const session: BrowserSession = {
        id,
        targetPort,
        targetUrl,
        wsPort,
        vncPort,
        displayNum,
        devtools,
        createdAt: processSet.createdAt,
      };

      this.emit("session:started", session);
      console.log(
        `[BrowserManager] ブラウザセッション開始: ${id} (ポート ${targetPort} → noVNC ws://${wsPort})`
      );

      return session;
    } catch (error) {
      // 起動失敗時: 既に起動したプロセスをクリーンアップ
      console.error(
        `[BrowserManager] ブラウザセッション起動失敗。プロセスをクリーンアップします。`
      );
      for (const proc of startedProcesses) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // killに失敗しても無視
        }
      }
      throw error;
    }
  }

  /**
   * プロセスを安全に停止（SIGTERM→待機→SIGKILL）
   */
  private async killProcess(proc: ChildProcess, name: string): Promise<void> {
    if (proc.exitCode !== null) {
      // 既に終了している
      return;
    }

    proc.kill("SIGTERM");

    // SIGTERM後の猶予時間を待つ
    const exited = await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => resolve(false), KILL_GRACE_PERIOD);
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });

    if (!exited) {
      console.warn(
        `[BrowserManager] ${name}がSIGTERMで停止しなかったためSIGKILLを送信`
      );
      proc.kill("SIGKILL");
    }
  }

  /**
   * ブラウザセッションを停止
   * 逆順停止: websockify → x11vnc → chromium → xvfb
   */
  async stop(browserId: string): Promise<void> {
    const processSet = this.sessions.get(browserId);
    if (!processSet) return;

    // 先にMapから削除して、異常終了監視のハンドラが再度stopを呼ばないようにする
    this.sessions.delete(browserId);

    console.log(`[BrowserManager] ブラウザセッション停止中: ${browserId}`);

    // 逆順でプロセスを停止
    await this.killProcess(processSet.websockify, "websockify");
    await this.killProcess(processSet.x11vnc, "x11vnc");
    await this.killProcess(processSet.chromium, "chromium");
    await this.killProcess(processSet.xvfb, "xvfb");

    this.emit("session:stopped", browserId);
    console.log(`[BrowserManager] ブラウザセッション停止完了: ${browserId}`);
  }

  /**
   * 全セッションを停止
   */
  async cleanup(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map(id => this.stop(id)));
    console.log(
      "[BrowserManager] 全ブラウザセッションをクリーンアップしました"
    );
  }

  /**
   * セッションIDでブラウザセッション情報を取得
   */
  getSession(browserId: string): BrowserSession | undefined {
    const processSet = this.sessions.get(browserId);
    if (!processSet) return undefined;
    return {
      id: processSet.id,
      targetPort: processSet.targetPort,
      targetUrl: processSet.targetUrl,
      wsPort: processSet.wsPort,
      vncPort: processSet.vncPort,
      displayNum: processSet.displayNum,
      devtools: processSet.devtools,
      createdAt: processSet.createdAt,
    };
  }

  /**
   * 全セッション情報を取得
   */
  getAllSessions(): BrowserSession[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      targetPort: s.targetPort,
      targetUrl: s.targetUrl,
      wsPort: s.wsPort,
      vncPort: s.vncPort,
      displayNum: s.displayNum,
      devtools: s.devtools,
      createdAt: s.createdAt,
    }));
  }
}

export const browserManager = new BrowserManager();
