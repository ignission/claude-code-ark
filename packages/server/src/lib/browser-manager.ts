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
 *
 * 起動できたとみなすのは、自分が起動した子プロセスがstderrに
 * `DevTools listening on ws://127.0.0.1:<CDP_PORT>/...` を出したときだけ。
 * ポートが応答するかどうかでは決めない。応答するのが自分のChromiumとは限らず、
 * 同じポートで別のChromium (別のArk、Playwright、利用者のChrome) が待ち受けていると、
 * 自分の子はポートを取れないのに起動できたように見え、他人のタブを視聴者へ配ってしまう。
 * その行にあるURLを持っておき、ブリッジはポートではなくそのURLへつなぐ (getCdpEndpoint)。
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserSession } from "@ark/shared";
import { BrowserCdpBridge } from "./browser-cdp-bridge.js";
import { connectCdpUrl } from "./browser-cdp-client.js";
import { validateBrowserUrl } from "./browser-url.js";
import { CDP_PORT } from "./constants.js";
import { getDataDir } from "./paths.js";

export { validateBrowserUrl };

/** ChromiumがCDPのエンドポイントをstderrに出すまで待つ上限 (ミリ秒) */
const CHROMIUM_START_TIMEOUT = 10000;
/** 停止時にSIGTERMからSIGKILLまで待つ時間 (ミリ秒) */
const KILL_GRACE_PERIOD = 3000;
/** 前のサーバーが残したChromiumを止めるときに、SIGTERMからSIGKILLまで待つ時間 (ミリ秒) */
const STALE_KILL_WAIT = 500;
/** 起動に失敗したときのエラーに付ける、stderrの末尾の長さ (文字数) */
const STDERR_TAIL_LENGTH = 2000;

/**
 * Chromiumバイナリを検索する
 * snap版はpm2/systemd環境でX11にアクセスできないため、
 * Playwright版のバイナリパス (chromium-* および chromium_headless_shell-*) を優先的に探す。
 *
 * BrowserManager (ブラウザ機能) と HtmlScreenshotter (headless shell) の両方から呼ばれる。
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
      // false の場合は通常の chromium-* を優先 (ブラウザ機能の用途)
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

  // システムの Chromium (snap版でないもの)
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
    // screencastのフレームは、ページへ伝える倍率 (setDeviceMetricsOverride) では大きくならず、
    // 起動時の倍率までしか出ない。ブリッジが受け付ける倍率の上限に合わせて2倍で起動する。
    // 等倍の視聴者には、ブリッジがフレームの上限を等倍に絞る
    "--force-device-scale-factor=2",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
  ];
}

/**
 * 前回のタブを復元させないよう、プロファイルに残ったセッションの記録を消す。
 *
 * Chromiumをシグナルで止めると、プロファイルは「異常終了」として残り、次の起動で前回の
 * タブが復元される。タブが増えると、ブリッジがつないだタブが前面でなくなり、
 * そのタブの `Page.captureScreenshot` が返らなくなる。cookieとlocalStorageは別の場所に
 * あるので、ここを消しても残る。
 */
export function clearSessionRestore(profileDir: string): void {
  fs.rmSync(path.join(profileDir, "Default", "Sessions"), {
    recursive: true,
    force: true,
  });
}

/**
 * `ps -eo pid=,args=` の出力から、同じプロファイルを使うChromiumの親プロセスを拾う。
 * 子 (`--type=renderer` など) は親を止めれば消えるので拾わない。
 *
 * 引数の並びを空白で割らずに、文字列のまま探す。プロファイルの場所が空白を含むと
 * (macOSの `~/Library/Application Support/...`)、割った時点で一致しなくなる。
 * 目印の前は空白、後ろは空白か行末であることを確かめる。前方一致だけにすると、
 * 別のArkのプロファイル (`<profileDir>-backup` のような場所) を使うChromiumまで止めてしまう。
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
    const args = m[2];
    if (!hasArgument(args, marker)) continue;
    if (args.includes(" --type=")) continue;
    if (pid === ownChildPid) continue;
    pids.push(pid);
  }
  return pids;
}

/** `args` (空白でつないだ引数の並び) に、`argument` が1つの引数として入っているか */
function hasArgument(args: string, argument: string): boolean {
  let from = 0;
  for (;;) {
    const at = args.indexOf(argument, from);
    if (at < 0) return false;
    const end = at + argument.length;
    if (args[at - 1] === " " && (end === args.length || args[end] === " ")) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Chromiumのstderrから、CDPのエンドポイント (`DevTools listening on <URL>` の行) を取り出す。
 * 受け付けるのは `ws://127.0.0.1:<port>/` で始まるURLだけで、無ければ `null`。
 * 行末まで届いていない行は読まない。チャンクの切れ目で、途中までのURLを使わないため。
 */
export function parseDevToolsEndpoint(
  stderrText: string,
  port: number
): string | null {
  const prefix = `ws://127.0.0.1:${port}/`;
  for (const m of stderrText.matchAll(
    /DevTools listening on (ws:\/\/\S+)\r?\n/g
  )) {
    if (m[1].startsWith(prefix)) return m[1];
  }
  return null;
}

/** `waitForDevToolsEndpoint` が使う、子プロセスの部分。テストで差し替えられるようにする */
interface ChromiumLike {
  stderr: Pick<EventEmitter, "on" | "off"> | null;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: (code: number | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * 子プロセスがCDPのエンドポイントをstderrに出すまで待ち、そのURLを返す。
 * 待つ間に終了したとき、起動できなかったとき、時間切れのときはrejectする。
 * エラーにはstderrの末尾を付ける (ポートを取れなかった理由や、足りないライブラリはそこに出る)。
 */
export function waitForDevToolsEndpoint(
  chromium: ChromiumLike,
  port: number,
  timeoutMs: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // 行がチャンクをまたいで届くので、ためた文字列から探す
    let received = "";

    const finish = () => {
      clearTimeout(timeout);
      chromium.stderr?.off("data", onData);
      chromium.off("exit", onEarlyExit);
      chromium.off("error", onEarlyError);
    };
    const fail = (message: string) => {
      finish();
      const tail = received.trim();
      reject(new Error(tail ? `${message}\n${tail}` : message));
    };

    const onData = (chunk: Buffer) => {
      received += chunk.toString();
      const endpoint = parseDevToolsEndpoint(received, port);
      if (endpoint) {
        finish();
        resolve(endpoint);
        return;
      }
      received = received.slice(-STDERR_TAIL_LENGTH);
    };
    const onEarlyExit = (code: number | null) => {
      fail(`Chromiumが起動の途中で終了しました (code: ${code})`);
    };
    const onEarlyError = (error: Error) => {
      fail(`Chromiumを起動できません: ${error.message}`);
    };
    const timeout = setTimeout(
      () => fail("Chromiumの起動がタイムアウトしました"),
      timeoutMs
    );

    chromium.stderr?.on("data", onData);
    chromium.once("exit", onEarlyExit);
    chromium.once("error", onEarlyError);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class BrowserManager extends EventEmitter {
  private chromium: ChildProcess | null = null;
  private session: BrowserSession | null = null;
  /** 動いているChromiumが自分でstderrに出したCDPのエンドポイント。セッションと同じ間だけ持つ */
  private cdpEndpoint: string | null = null;
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

  /**
   * CDPのエンドポイント (`ws://127.0.0.1:<CDP_PORT>/devtools/browser/<id>`)。
   * Chromiumが動いていなければ `null`。
   */
  getCdpEndpoint(): string | null {
    return this.cdpEndpoint;
  }

  /** Chromiumを起動する。動いていればそのセッションを返し、起動の途中ならそれを待つ */
  async start(initialUrl = "about:blank"): Promise<BrowserSession> {
    // 起動に使うのは、渡された文字列ではなく、確かめたあとの形
    const url = validateBrowserUrl(initialUrl);
    if (!this.available) {
      throw new Error("Chromiumが見つからないため、ブラウザ機能は使えません");
    }
    if (this.session) return this.session;
    if (this.pendingStart) return this.pendingStart;

    const promise = this.startInternal(url);
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
    // ほかの利用者に読ませない。localhostのアプリのcookieとlocalStorageが入る
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    clearSessionRestore(profileDir);

    // `--` で区切り、URLがフラグとして読まれないようにする
    const chromium = spawn(
      this.chromiumCmd,
      [...chromiumFlags(profileDir), "--", initialUrl],
      { stdio: ["ignore", "ignore", "pipe"], detached: false }
    );
    this.chromium = chromium;

    // 子プロセスが生きている間ずっと付けておく。`error` (シグナルの送信の失敗など) を
    // 受けるリスナーが無い瞬間があると、そこで出た `error` がサーバーを落とす
    chromium.on("error", error => {
      console.warn(`[BrowserManager] Chromiumのエラー: ${error.message}`);
    });
    // stderrは起動のあとも読み捨て続ける。読まないとパイプが詰まり、Chromiumが書き込みで止まる
    chromium.stderr?.on("data", () => {});

    let endpoint: string;
    try {
      endpoint = await waitForDevToolsEndpoint(
        chromium,
        CDP_PORT,
        CHROMIUM_START_TIMEOUT
      );
    } catch (error) {
      // ポートを取れなかったChromiumは、CDPを開かないまま動き続ける。残さず止める
      await this.killProcess(chromium);
      if (this.chromium === chromium) this.chromium = null;
      throw error;
    }

    const id = randomUUID();
    // セッションを消して停止を知らせるのは、このハンドラだけ。`stop` で止めたときも、
    // Chromiumが自分で落ちたときも、ここを通る
    chromium.once("exit", () => {
      if (this.chromium === chromium) this.chromium = null;
      if (this.session?.id === id) {
        this.session = null;
        this.cdpEndpoint = null;
      }
      console.log(`[BrowserManager] Chromiumが終了しました: ${id}`);
      this.emit("session:stopped", id);
    });

    const session: BrowserSession = {
      id,
      targetUrl: initialUrl,
      createdAt: new Date(),
    };
    this.session = session;
    this.cdpEndpoint = endpoint;
    console.log(`[BrowserManager] Chromiumを起動しました: ${id}`);
    this.emit("session:started", session);
    return session;
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

/**
 * ブラウザ機能のブリッジ。`browserManager` が起動したChromiumのエンドポイントへつなぐ。
 * ポート番号ではつながない。同じポートで待ち受けている別のChromiumへつながないため。
 */
export const browserBridge = new BrowserCdpBridge(async () => {
  const endpoint = browserManager.getCdpEndpoint();
  if (!endpoint) {
    throw new Error("Chromiumが動いていないため、ブラウザへ接続できません");
  }
  return connectCdpUrl(endpoint);
});
