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
import os from "node:os";
import type { BrowserSession } from "../../shared/types.js";
import {
  CDP_PORT,
  DISPLAY_START,
  VNC_PORT_END,
  VNC_PORT_START,
  WS_PORT_END,
  WS_PORT_START,
} from "./constants.js";
import { getErrorMessage } from "./errors.js";

/** 各プロセスの起動タイムアウト（ミリ秒） */
const XVFB_TIMEOUT = 5000;
const CHROMIUM_TIMEOUT = 10000;
/** CDP readinessチェックのポーリング間隔（ミリ秒） */
const CHROMIUM_POLL_INTERVAL = 200;
/** CDP readinessチェックの1回あたりのfetchタイムアウト（ミリ秒） */
const CHROMIUM_FETCH_TIMEOUT = 500;
const X11VNC_TIMEOUT = 5000;
const WEBSOCKIFY_TIMEOUT = 5000;

/** stop時のSIGTERM→SIGKILL待機時間（ミリ秒） */
const KILL_GRACE_PERIOD = 3000;

/** Xvfb仮想ディスプレイの解像度 */
const DISPLAY_RESOLUTION = "1280x900x24";

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
  `--remote-debugging-port=${CDP_PORT}`,
  "--remote-debugging-address=127.0.0.1",
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
  /** シングルトンセッション（1つだけ起動） */
  private singletonSession: BrowserSession | null = null;
  /** 起動中のPromiseを保持し、重複起動を防ぐ */
  private pendingStart: Promise<BrowserSession> | null = null;
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
    const homeDir = process.env.HOME || os.homedir();
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
   * 現在アクティブなブラウザセッションが使用中のポート一覧を返す
   * port-scannerで内部ポートのみを除外するために使用する
   */
  getUsedPorts(): number[] {
    const ports: number[] = [CDP_PORT];
    for (const session of Array.from(this.sessions.values())) {
      ports.push(session.vncPort, session.wsPort);
    }
    return ports;
  }

  /**
   * URLスキーマ検証
   * - http://またはhttps://のみ許可
   * - ホスト名はlocalhost/127.0.0.1のみ許可
   * - about:blankは特例で許可
   */
  private validateUrl(url: string): void {
    if (url === "about:blank") return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("無効なURL形式です");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("http://またはhttps://のみ許可されています");
    }
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("localhost/127.0.0.1のみ許可されています");
    }
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
   * 内部sessionsマップだけでなく、OSレベルでX11ソケットの存在も確認する
   * （他プロセスが使用中のディスプレイ番号を避ける）
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
      // OSレベルでX11ソケットの存在を確認
      if (fs.existsSync(`/tmp/.X11-unix/X${display}`)) continue;
      this.nextDisplay = display + 1;
      if (this.nextDisplay > maxDisplay) {
        this.nextDisplay = DISPLAY_START;
      }
      return display;
    }
    throw new Error("利用可能なディスプレイ番号がありません");
  }

  /**
   * ブラウザセッションを開始（シングルトン）
   * 既にセッションがあればそのまま返す。起動中なら待つ。
   */
  async start(initialUrl = "about:blank"): Promise<BrowserSession> {
    this.validateUrl(initialUrl);

    if (!this.available) {
      throw new Error(
        "ブラウザタブ機能は無効です。依存パッケージをインストールしてください。"
      );
    }

    // 既にセッションがあればそのまま返す
    if (this.singletonSession) {
      return this.singletonSession;
    }

    // 起動中なら待つ
    if (this.pendingStart) {
      return this.pendingStart;
    }

    const promise = this._startInternal(initialUrl);
    this.pendingStart = promise;

    try {
      const session = await promise;
      this.singletonSession = session;
      return session;
    } finally {
      this.pendingStart = null;
    }
  }

  /**
   * ブラウザセッションの実際の起動処理（内部用）
   * 起動順: Xvfb → Chromium → x11vnc → websockify
   */
  private async _startInternal(
    initialUrl = "about:blank"
  ): Promise<BrowserSession> {
    const targetUrl = initialUrl;
    const targetPort = 0;
    const devtools = false;
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
      // `--`（フラグ終端子）を付けることでtargetUrlが`--`で始まる場合も
      // 位置引数として安全に解釈される（引数インジェクション対策）
      chromiumFlags.push("--", targetUrl);

      const chromium = spawn(this.chromiumCmd, chromiumFlags, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: {
          ...process.env,
          DISPLAY: `:${displayNum}`,
        },
      });
      startedProcesses.push(chromium);

      // CDPエンドポイントが応答するまでポーリングしてChromium readinessを検出
      // 早期exitやerrorも検出してreject
      await new Promise<void>((resolve, reject) => {
        const overallTimeout = setTimeout(() => {
          chromium.off("exit", onEarlyExit);
          chromium.off("error", onEarlyError);
          reject(new Error("Chromium起動タイムアウト"));
        }, 10000);

        const onEarlyExit = (code: number | null) => {
          clearTimeout(overallTimeout);
          reject(new Error(`Chromiumが予期せず終了しました (code: ${code})`));
        };
        const onEarlyError = (err: Error) => {
          clearTimeout(overallTimeout);
          reject(new Error(`Chromium起動エラー: ${err.message}`));
        };
        chromium.once("exit", onEarlyExit);
        chromium.once("error", onEarlyError);

        const cleanup = () => {
          clearTimeout(overallTimeout);
          chromium.off("exit", onEarlyExit);
          chromium.off("error", onEarlyError);
        };

        const checkReady = async () => {
          try {
            const controller = new AbortController();
            const fetchTimeout = setTimeout(() => controller.abort(), 500);
            const res = await fetch(
              `http://127.0.0.1:${CDP_PORT}/json/version`,
              { signal: controller.signal }
            );
            clearTimeout(fetchTimeout);
            if (res.ok) {
              cleanup();
              resolve();
              return;
            }
          } catch {
            // まだ起動していない
          }
          setTimeout(checkReady, 200);
        };
        checkReady();
      });

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
          cleanup();
          reject(new Error("x11vnc起動タイムアウト"));
        }, X11VNC_TIMEOUT);

        let outputData = "";

        const onData = (data: Buffer) => {
          outputData += data.toString();
          // x11vncは起動時に "PORT=XXXX" を stdout に出力する
          if (outputData.includes("PORT=")) {
            clearTimeout(timeout);
            cleanup();
            resolve();
          }
        };

        const onError = (error: Error) => {
          clearTimeout(timeout);
          cleanup();
          reject(error);
        };

        const onExit = (code: number | null) => {
          if (code !== 0 && code !== null) {
            clearTimeout(timeout);
            cleanup();
            reject(
              new Error(`x11vncが終了しました (code: ${code}): ${outputData}`)
            );
          }
        };

        // resolve/reject後にリスナーを除去してメモリリークを防ぐ。
        // ただしstdout/stderrはパイプバッファが詰まらないよう
        // 軽量なドレインリスナーを残す必要がある。
        const drain = () => {};
        const cleanup = () => {
          x11vnc.stdout?.off("data", onData);
          x11vnc.stderr?.off("data", onData);
          x11vnc.off("error", onError);
          x11vnc.off("exit", onExit);
          x11vnc.stdout?.on("data", drain);
          x11vnc.stderr?.on("data", drain);
        };

        x11vnc.stdout?.on("data", onData);
        x11vnc.stderr?.on("data", onData);
        x11vnc.on("error", onError);
        x11vnc.on("exit", onExit);
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
          cleanup();
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
            cleanup();
            resolve();
          }
        };

        const onError = (error: Error) => {
          clearTimeout(timeout);
          cleanup();
          reject(error);
        };

        const onExit = (code: number | null) => {
          if (code !== 0 && code !== null) {
            clearTimeout(timeout);
            cleanup();
            reject(
              new Error(
                `websockifyが終了しました (code: ${code}): ${outputData}`
              )
            );
          }
        };

        // resolve/reject後にリスナーを除去してメモリリークを防ぐ。
        // stdout/stderrは軽量なドレインリスナーを残してパイプバッファ詰まりを防ぐ。
        const drain = () => {};
        const cleanup = () => {
          websockify.stdout?.off("data", onData);
          websockify.stderr?.off("data", onData);
          websockify.off("error", onError);
          websockify.off("exit", onExit);
          websockify.stdout?.on("data", drain);
          websockify.stderr?.on("data", drain);
        };

        websockify.stdout?.on("data", onData);
        websockify.stderr?.on("data", onData);
        websockify.on("error", onError);
        websockify.on("exit", onExit);
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
        "[BrowserManager] ブラウザセッション起動失敗。プロセスをクリーンアップします。"
      );
      // 起動順とは逆順でkillProcessを呼ぶ
      for (let i = startedProcesses.length - 1; i >= 0; i--) {
        await this.killProcess(startedProcesses[i], `process${i}`).catch(() => {
          // 失敗は無視（既に死んでいる可能性）
        });
      }
      throw error;
    }
  }

  /**
   * プロセスを安全に停止（SIGTERM→待機→SIGKILL→再待機）
   */
  private async killProcess(proc: ChildProcess, name: string): Promise<void> {
    if (proc.exitCode !== null || proc.killed) {
      // 既に終了している
      return;
    }

    try {
      proc.kill("SIGTERM");
    } catch {
      // killに失敗（既に死んでいる等）は無視
      return;
    }

    // SIGTERM後の猶予時間を待つ
    const exited = await new Promise<boolean>(resolve => {
      if (proc.exitCode !== null || proc.killed) {
        resolve(true);
        return;
      }
      const timeout = setTimeout(() => resolve(false), KILL_GRACE_PERIOD);
      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });

    if (!exited) {
      console.warn(
        `[BrowserManager] ${name}がSIGTERMで停止しなかったためSIGKILLを送信`
      );
      try {
        proc.kill("SIGKILL");
      } catch {
        // 既に死んでいる
        return;
      }
      // SIGKILL後もexitを待つ（プロセステーブルからの削除確認）
      await new Promise<void>(resolve => {
        if (proc.exitCode !== null || proc.killed) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => resolve(), 1000);
        proc.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  /**
   * ブラウザセッションを停止
   * 並列停止で速度を優先（プロセス間の依存順序は致命的ではない）
   */
  async stop(browserId: string): Promise<void> {
    const processSet = this.sessions.get(browserId);
    if (!processSet) return;

    // 先にMapから削除して、異常終了監視のハンドラが再度stopを呼ばないようにする
    this.sessions.delete(browserId);

    // シングルトンセッションをクリア
    if (this.singletonSession?.id === browserId) {
      this.singletonSession = null;
    }

    console.log(`[BrowserManager] ブラウザセッション停止中: ${browserId}`);

    // 並列停止（依存関係は致命的ではなく、停止時間の短縮を優先）
    await Promise.all([
      this.killProcess(processSet.websockify, "websockify"),
      this.killProcess(processSet.x11vnc, "x11vnc"),
      this.killProcess(processSet.chromium, "chromium"),
      this.killProcess(processSet.xvfb, "xvfb"),
    ]);

    this.emit("session:stopped", browserId);
    console.log(`[BrowserManager] ブラウザセッション停止完了: ${browserId}`);
  }

  /**
   * CDP経由でChromiumを指定URLにナビゲート
   * WebSocket DevTools Protocol の Page.navigate を使用
   */
  async navigate(url: string): Promise<BrowserSession> {
    this.validateUrl(url);

    // singletonSessionが残っているがsessionsには無い場合（stale）はクリア
    if (this.singletonSession && !this.sessions.has(this.singletonSession.id)) {
      this.singletonSession = null;
    }

    // 起動中（pendingStart）の場合、そのstart()が終わるのを待ってから
    // 改めてnavigate()を実行する。
    // これをしないと、先行のstart(about:blank)が返ってきた時点で
    // 既にsingletonSessionが存在するため、新しいURLへのCDPナビゲートが
    // 実行されず、URLが飲み込まれてしまう。
    if (this.pendingStart) {
      try {
        await this.pendingStart;
      } catch {
        // 起動失敗時は以下の通常フローでstart(url)が呼ばれる
      }
      return this.navigate(url);
    }

    // セッションがなければ初期URLとして起動
    if (!this.singletonSession) {
      return this.start(url);
    }

    // CDP: ページ型のタブを取得（タイムアウト付き）
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(fetchTimeout);
    }
    if (!res.ok) {
      throw new Error(`CDPエンドポイント応答エラー: ${res.status}`);
    }
    const tabs = (await res.json()) as Array<{
      id: string;
      type: string;
      webSocketDebuggerUrl: string;
      url: string;
    }>;
    const pageTab = tabs.find(t => t.type === "page");
    if (!pageTab) {
      throw new Error("Chromiumのページタブが見つかりません");
    }

    // webSocketDebuggerUrl が期待するCDPエンドポイント（ws://127.0.0.1:CDP_PORT/）
    // で始まることを検証（SSRF/CDP乗っ取り対策）
    const expectedPrefix = `ws://127.0.0.1:${CDP_PORT}/`;
    if (!pageTab.webSocketDebuggerUrl.startsWith(expectedPrefix)) {
      throw new Error("不正なCDPエンドポイント");
    }

    // WebSocketでPage.navigateコマンドを送信
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("CDP navigate タイムアウト"));
      }, 5000);

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Page.navigate",
            params: { url },
          })
        );
      });

      ws.addEventListener("message", event => {
        try {
          const msg = JSON.parse(event.data.toString());
          if (msg.id === 1) {
            clearTimeout(timeout);
            ws.close();
            if (msg.error) {
              reject(new Error(`CDP navigate エラー: ${msg.error.message}`));
            } else {
              resolve();
            }
          }
        } catch (e) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`CDP応答パースエラー: ${getErrorMessage(e)}`));
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error("CDP WebSocket エラー"));
      });
    });

    console.log(`[BrowserManager] ナビゲート: ${url}`);
    return this.singletonSession;
  }

  /**
   * 全セッションを停止
   * 起動中のセッションがある場合は完了を待ってからクリーンアップする
   * （起動完了後にプロセスが残留するのを防ぐ）
   */
  async cleanup(): Promise<void> {
    // 起動中のセッションがあれば完了を待つ
    if (this.pendingStart) {
      try {
        await this.pendingStart;
      } catch {
        // 起動失敗時は無視（プロセスは_startInternal側で既にクリーンアップ済み）
      }
    }
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map(id => this.stop(id)));
    this.singletonSession = null;
    this.pendingStart = null;
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
