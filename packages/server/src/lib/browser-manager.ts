/**
 * ブラウザ機能のChromiumを1つ起動して止める。
 *
 * headlessで動かし、画面と入力はCDPで運ぶ (browser-cdp-bridge.ts)。
 * Chromiumはサーバーに1つで、視聴者が0人でも動かし続ける。つなぎ直したときに
 * 同じページへ戻れるようにするため。
 *
 * プロファイルはデータディレクトリの下に専用のものを置く。同じ機械で2つ目のArkを
 * 動かしたときに、Chromiumがプロファイルのロックを見て先に動いている側へ合流し、
 * 起動直後に終了するのを避けるため。この場所は、前のサーバーが残したChromiumを
 * 見分ける目印にも使う (findStaleChromiumPids)。
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserSession } from "@ark/shared";
import { CDP_PORT } from "./constants.js";
import { getDataDir } from "./paths.js";

/** CDPのエンドポイントが応答するまで待つ上限 (ミリ秒) */
const CHROMIUM_START_TIMEOUT = 10000;
/** CDPのエンドポイントを確かめる間隔 (ミリ秒) */
const READY_POLL_INTERVAL = 200;
/** 停止時にSIGTERMからSIGKILLまで待つ時間 (ミリ秒) */
const KILL_GRACE_PERIOD = 3000;
/** 前のサーバーが残したChromiumを止めるときに、SIGTERMからSIGKILLまで待つ時間 (ミリ秒) */
const STALE_KILL_WAIT = 500;
/** 起動に失敗したときのエラーに付ける、stderrの末尾の長さ (文字数) */
const STDERR_TAIL_LENGTH = 2000;

/**
 * Chromiumバイナリを検索する
 * snap版はpm2/systemd環境でX11にアクセスできないため、
 * Playwright版のバイナリパス（chromium-* および chromium_headless_shell-*）を優先的に探す。
 *
 * BrowserManager（ブラウザ機能）と HtmlScreenshotter（headless shell）の両方から呼ばれる。
 */
export function findChromiumExecutable(
  options: { headlessShell?: boolean } = {}
): string | null {
  const homeDir = process.env.HOME || os.homedir();
  const playwrightDir = `${homeDir}/.cache/ms-playwright`;
  if (fs.existsSync(playwrightDir)) {
    try {
      const allDirs = fs.readdirSync(playwrightDir);
      // headlessShell=true の場合は chromium_headless_shell-* を優先
      // false の場合は通常の chromium-* を優先（ブラウザ機能の用途）
      const prefix = options.headlessShell
        ? "chromium_headless_shell-"
        : "chromium-";
      const fallbackPrefix = options.headlessShell
        ? "chromium-"
        : "chromium_headless_shell-";
      const tryFind = (p: string): string | null => {
        const dirs = allDirs
          .filter(d => d.startsWith(p))
          .sort()
          .reverse(); // 最新版を優先
        for (const dir of dirs) {
          const binName = options.headlessShell ? "headless_shell" : "chrome";
          const binPath = `${playwrightDir}/${dir}/chrome-linux/${binName}`;
          if (fs.existsSync(binPath)) {
            return binPath;
          }
          // headless_shell ディレクトリの中に chrome がある場合や逆ケースに対応
          const altPath = `${playwrightDir}/${dir}/chrome-linux/chrome`;
          if (fs.existsSync(altPath)) {
            return altPath;
          }
        }
        return null;
      };
      const found = tryFind(prefix) ?? tryFind(fallbackPrefix);
      if (found) return found;
    } catch {
      // ディレクトリ読み取り失敗は無視
    }
  }

  // システムの Chromium（snap版でないもの）
  for (const cmd of ["chromium-browser", "chromium", "google-chrome"]) {
    try {
      execFileSync("which", [cmd], { stdio: "pipe" });
      return cmd;
    } catch {
      // 見つからない
    }
  }

  return null;
}

/** stop時のSIGTERM→SIGKILL待機時間（ミリ秒） */

function getProfileDir(): string {
  return path.join(getDataDir(), "browser-profile");
}

function chromiumFlags(profileDir: string): string[] {
  return [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    "--disable-default-apps",
    "--window-size=1280,900",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
  ];
}

/**
 * `ps -eo pid=,args=` の出力から、同じプロファイルを使うChromiumの親プロセスを拾う。
 * 子 (`--type=renderer` など) は親を止めれば消えるので拾わない。
 *
 * 引数の完全一致で見分ける。前方一致にすると、別のArkのプロファイル
 * (`<profileDir>-backup` のような場所) を使うChromiumまで止めてしまう。
 */
export function findStaleChromiumPids(
  psOutput: string,
  profileDir: string,
  ownChildPid?: number
): number[] {
  const marker = `--user-data-dir=${profileDir}`;
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    const args = m[2].split(/\s+/);
    if (!args.includes(marker)) continue;
    if (args.some(a => a.startsWith("--type="))) continue;
    if (pid === ownChildPid) continue;
    pids.push(pid);
  }
  return pids;
}

/**
 * ブラウザ機能で開いてよいURLかを確かめる。だめなら例外を投げる。
 * - `about:blank` は通す
 * - それ以外は `http:` / `https:` で、ホストが `localhost` / `127.0.0.1` のものだけ
 */
export function validateBrowserUrl(url: string): void {
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class BrowserManager extends EventEmitter {
  private chromium: ChildProcess | null = null;
  private session: BrowserSession | null = null;
  /** 起動の途中のPromise。同時に呼ばれた `start` が2つ起動しないように共有する */
  private pendingStart: Promise<BrowserSession> | null = null;
  private available = true;
  private chromiumCmd = "";

  constructor() {
    super();
    const found = findChromiumExecutable();
    if (found) {
      this.chromiumCmd = found;
    } else {
      this.available = false;
      console.warn(
        "[BrowserManager] Chromiumが見つからないため、ブラウザ機能を無効にします"
      );
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  /** ポートスキャンの結果から外す、ブラウザ機能が使うポート */
  getUsedPorts(): number[] {
    return [CDP_PORT];
  }

  /** Chromiumを起動する。動いていればそのセッションを返し、起動の途中ならそれを待つ */
  async start(initialUrl = "about:blank"): Promise<BrowserSession> {
    validateBrowserUrl(initialUrl);
    if (!this.available) {
      throw new Error("Chromiumが見つからないため、ブラウザ機能は使えません");
    }
    if (this.session) return this.session;
    if (this.pendingStart) return this.pendingStart;

    const promise = this.startInternal(initialUrl);
    this.pendingStart = promise;
    try {
      return await promise;
    } finally {
      this.pendingStart = null;
    }
  }

  private async startInternal(initialUrl: string): Promise<BrowserSession> {
    await this.reapStale();

    const profileDir = getProfileDir();
    fs.mkdirSync(profileDir, { recursive: true });

    // `--` で区切り、URLがフラグとして読まれないようにする
    const chromium = spawn(
      this.chromiumCmd,
      [...chromiumFlags(profileDir), "--", initialUrl],
      { stdio: ["ignore", "ignore", "pipe"], detached: false }
    );
    this.chromium = chromium;

    // stderrは読み捨てる。読まないとパイプが詰まり、Chromiumが書き込みで止まる。
    // 末尾だけ持ち、起動に失敗したときのエラーに付ける
    let stderrTail = "";
    chromium.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LENGTH);
    });

    try {
      await this.waitUntilReady(chromium);
    } catch (error) {
      await this.killProcess(chromium);
      if (this.chromium === chromium) this.chromium = null;
      const message = error instanceof Error ? error.message : String(error);
      const tail = stderrTail.trim();
      throw new Error(tail ? `${message}\n${tail}` : message);
    }

    const id = randomUUID();
    // セッションを消して停止を知らせるのは、このハンドラだけ。`stop` で止めたときも、
    // Chromiumが自分で落ちたときも、ここを通る
    chromium.once("exit", () => {
      if (this.chromium === chromium) this.chromium = null;
      if (this.session?.id === id) this.session = null;
      console.log(`[BrowserManager] Chromiumが終了しました: ${id}`);
      this.emit("session:stopped", id);
    });
    // 起動後の `error` (シグナルの送信の失敗など) でサーバーを落とさない
    chromium.on("error", error => {
      console.warn(`[BrowserManager] Chromiumのエラー: ${error.message}`);
    });

    const session: BrowserSession = {
      id,
      targetUrl: initialUrl,
      createdAt: new Date(),
    };
    this.session = session;
    console.log(`[BrowserManager] Chromiumを起動しました: ${id}`);
    this.emit("session:started", session);
    return session;
  }

  /**
   * CDPのエンドポイントが応答するまで待つ。
   * 待つ間にChromiumが終了したとき、起動できなかったとき、時間切れのときはrejectする。
   */
  private waitUntilReady(chromium: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let pollTimer: NodeJS.Timeout | null = null;

      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimeout);
        if (pollTimer) clearTimeout(pollTimer);
        chromium.off("exit", onEarlyExit);
        chromium.off("error", onEarlyError);
        if (error) reject(error);
        else resolve();
      };

      const overallTimeout = setTimeout(
        () => settle(new Error("Chromiumの起動がタイムアウトしました")),
        CHROMIUM_START_TIMEOUT
      );
      const onEarlyExit = (code: number | null) => {
        settle(new Error(`Chromiumが起動の途中で終了しました (code: ${code})`));
      };
      const onEarlyError = (error: Error) => {
        settle(new Error(`Chromiumを起動できません: ${error.message}`));
      };
      chromium.once("exit", onEarlyExit);
      chromium.once("error", onEarlyError);

      const checkReady = async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
            signal: AbortSignal.timeout(500),
          });
          if (res.ok) {
            settle();
            return;
          }
        } catch {
          // まだ待ち受けていない
        }
        if (!settled) {
          pollTimer = setTimeout(checkReady, READY_POLL_INTERVAL);
        }
      };
      void checkReady();
    });
  }

  /**
   * 前のサーバーが残したChromiumを止める。同じプロファイルを使うものが残っていると、
   * 新しく起動したChromiumがそちらへ合流して終了する。
   * プロファイルの場所が一致するものだけを止めるので、別のArkのChromiumには触らない。
   */
  private async reapStale(): Promise<void> {
    let output: string;
    try {
      output = execFileSync("ps", ["-eo", "pid=,args=", "-ww"], {
        encoding: "utf-8",
      });
    } catch {
      return;
    }
    const pids = findStaleChromiumPids(
      output,
      getProfileDir(),
      this.chromium?.pid
    );
    if (pids.length === 0) return;

    console.log(
      `[BrowserManager] 残っていたChromiumを止めます: ${pids.join(", ")}`
    );
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // すでに終了している
      }
    }
    await sleep(STALE_KILL_WAIT);
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // SIGTERMで終了した
      }
    }
  }

  /** SIGTERMを送り、終了しなければSIGKILLを送る。終了を確かめてから返す */
  private async killProcess(proc: ChildProcess): Promise<void> {
    // `proc.killed` はシグナルを送ったかどうかで、終了したかどうかではない。
    // 終了は `exitCode` と `signalCode` で見る。pidが無いのは起動できなかったとき
    if (proc.pid === undefined || hasExited(proc)) return;

    const waitExit = (ms: number) =>
      new Promise<boolean>(resolve => {
        if (hasExited(proc)) {
          resolve(true);
          return;
        }
        const onExit = () => {
          clearTimeout(timeout);
          resolve(true);
        };
        const timeout = setTimeout(() => {
          proc.off("exit", onExit);
          resolve(false);
        }, ms);
        proc.once("exit", onExit);
      });

    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
    if (await waitExit(KILL_GRACE_PERIOD)) return;

    console.warn(
      "[BrowserManager] ChromiumがSIGTERMで終了しないため、SIGKILLを送ります"
    );
    try {
      proc.kill("SIGKILL");
    } catch {
      return;
    }
    await waitExit(1000);
  }

  /**
   * Chromiumを止める。`browserId` がいまのセッションでなければ何もしない。
   *
   * セッションを消すのも `session:stopped` を出すのも `exit` のハンドラで、ここでは行わない。
   * ここで先に消すと、ハンドラが知らせるべきidと食い違う。`exit` のハンドラは
   * `killProcess` の待ちより先に登録してあるので、返った時点でセッションは消えている。
   */
  async stop(browserId: string): Promise<void> {
    const chromium = this.chromium;
    if (!chromium || this.session?.id !== browserId) return;
    await this.killProcess(chromium);
  }

  /** サーバーの停止のとき。起動の途中ならそれを待ってから止め、Chromiumを残さない */
  async cleanup(): Promise<void> {
    if (this.pendingStart) {
      try {
        await this.pendingStart;
      } catch {
        // 起動に失敗していれば、止めるものは無い
      }
    }
    if (this.session) await this.stop(this.session.id);
  }

  getSession(browserId: string): BrowserSession | undefined {
    return this.session?.id === browserId ? this.session : undefined;
  }

  getAllSessions(): BrowserSession[] {
    return this.session ? [this.session] : [];
  }
}

/** 終了済みか。シグナルで終了したプロセスは `exitCode` がnullのままなので、両方を見る */
function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

export const browserManager = new BrowserManager();
