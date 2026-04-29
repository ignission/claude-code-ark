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
import path from "node:path";
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
const X11VNC_TIMEOUT = 5000;
const WEBSOCKIFY_TIMEOUT = 5000;

/**
 * Chromiumバイナリを検索する
 * snap版はpm2/systemd環境でX11にアクセスできないため、
 * Playwright版のバイナリパス（chromium-* および chromium_headless_shell-*）を優先的に探す。
 *
 * BrowserManager（noVNC、可視GUI）と HtmlScreenshotter（headless shell）の両方から呼ばれる。
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
      // false の場合は通常の chromium-* を優先（noVNC等の可視GUI用途）
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
const KILL_GRACE_PERIOD = 3000;

/** 孤立プロセス掃除時のSIGTERM→SIGKILL待機時間（ミリ秒） */
const ORPHAN_TERM_TIMEOUT_MS = 1500;

/**
 * 起動後の孤立プロセス再掃除までの遅延（ミリ秒）。
 *
 * pm2 reload 等で旧サーバーが新サーバー起動と一定期間共存するケースに対応する。
 * 初回 cleanup では旧 serverPid が「生存中」として skip されるが、reload 完了
 * (旧プロセス終了) 後に再 cleanup を走らせることで、旧サーバーの管理対象だった
 * 孤立子プロセスを次回restartを待たずに回収する。
 */
const ORPHAN_RECLEAN_DELAY_MS = 10000;

/**
 * Ark識別マーカー: Xvfbのフレームバッファ保存ディレクトリ
 * cleanupOrphanedProcesses() でこの文字列を含むXvfbのみをArk由来と判定する
 */
const XVFB_FB_DIR = "/tmp/.ark-xvfb-fb";

/**
 * Ark識別マーカー: x11vncのデスクトップ名
 * cleanupOrphanedProcesses() でこの値を `-desktop` 引数に持つx11vncのみを
 * Ark由来と判定する
 */
const ARK_DESKTOP = "ark-browser";

/**
 * Arkが起動したブラウザ関連子プロセスのpidを記録するディレクトリ。
 * 各Arkサーバーインスタンスは自身のpidをファイル名にしたファイル
 * (`<dir>/<serverPid>`) に子pidを書き込む。cleanupOrphanedProcesses()
 * は「ファイル名のserverPidが現存していない」ファイルだけを孤立扱いし、
 * 別の生存中サーバー（pm2 reload等での旧インスタンス）の子は触らない。
 *
 * ファイル形式: 1行1エントリ。`<pid>` または `<pid>:<display>`。
 * Xvfbのみdisplay情報を併記してプロセス死亡後もソケット残骸を回収できる。
 */
const BROWSER_PIDFILE_DIR = path.join(process.cwd(), "data", "browser-pids");

interface PidEntry {
  pid: number;
  display?: number;
}

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
    if (this.available) {
      try {
        fs.mkdirSync(XVFB_FB_DIR, { recursive: true, mode: 0o700 });
      } catch (err) {
        console.warn(
          `[BrowserManager] ${XVFB_FB_DIR} 作成失敗: ${getErrorMessage(err)}`
        );
      }
      this.cleanupOrphanedProcesses();
      // pm2 reload等で旧サーバーが起動直後にはまだ生存中の場合、初回cleanup
      // ではそのpidfileがskipされる。一定遅延後に再実行して旧サーバー死亡後の
      // 孤立を回収する。unref()でevent loopをブロックしないようにする。
      setTimeout(() => {
        this.cleanupOrphanedProcesses();
      }, ORPHAN_RECLEAN_DELAY_MS).unref();
    }
  }

  /**
   * 過去のArkプロセスが残した孤立Xvfb/x11vnc/websockify/Chromiumを掃除する。
   *
   * pm2 restart 等でサーバーが再起動するとシングルトンは消えるが、
   * Xvfb等の子プロセスは生存し続ける。次回起動時 findAvailableDisplay() が
   * 残存ディスプレイを避けて :100 等に逃げる一方、Chromium readiness 判定は
   * 固定CDPポート(9222)を fetch するため、既存 :99 Chromiumのレスポンスを
   * 自プロセスのreadinessと誤認 → Chromiumのいない空ディスプレイが量産される。
   * 起動時にArk由来プロセスを一掃して再発を防ぐ。
   *
   * 識別方針（誤kill防止のため pidfile + cmd検証 + サーバーownership の三段階）:
   * - 各Arkサーバーは自身のpidをファイル名にしたpidfileに子pidを記録する
   *   (`<BROWSER_PIDFILE_DIR>/<serverPid>`)
   * - 起動時にディレクトリをスキャンし、ファイル名のserverPidが現存しない
   *   （=死亡サーバー）ファイルだけを孤立扱いする。生存中の他サーバー
   *   インスタンス（pm2 reload等）の子は触らない
   * - 候補pidは ps -p で cmd を取得し、Ark由来cmd（マーカー付きXvfb/x11vnc、
   *   Ark固定CDPポートのChromium、websockify）にマッチしたものだけkill対象
   * - pid再利用で別cmdになったプロセスは無視される
   *
   * 終了確認:
   * - SIGTERM後、最大 ORPHAN_TERM_TIMEOUT_MS まで `kill -0` で終了をポーリング
   * - 残存プロセスは SIGKILL で強制終了
   * - 全プロセスが消えたことを確認した後で X11 ソケットを削除する
   * - 残存pidが残った場合: 最初のorphanFileに残存pidを書き戻し、ソケット削除は
   *   スキップする（findAvailableDisplay() の誤判定防止 + 次回起動時の再試行）
   */
  private cleanupOrphanedProcesses(): void {
    try {
      let entries: string[];
      try {
        entries = fs.readdirSync(BROWSER_PIDFILE_DIR);
      } catch {
        return; // ディレクトリ未作成 = 過去にArkが起動していない
      }

      // 死亡サーバー(=自分以外でArkサーバーとして生存していないserverPid)の
      // ファイルだけ集める。pid再利用で別プロセスがそのpidを取っているケース
      // を `isArkServerAlive` で識別する（kill -0 だけだと永久に skip される）
      const orphanFiles: string[] = [];
      for (const entry of entries) {
        const serverPid = Number.parseInt(entry, 10);
        if (!Number.isFinite(serverPid) || serverPid <= 0) continue;
        if (serverPid === process.pid) continue; // 自分のファイルは触らない
        if (!this.isArkServerAlive(serverPid)) {
          orphanFiles.push(entry);
        }
      }

      if (orphanFiles.length === 0) return;

      // 候補エントリを集める。pid重複時はdisplay情報のあるエントリを優先
      const entryByPid = new Map<number, PidEntry>();
      for (const file of orphanFiles) {
        try {
          const content = fs.readFileSync(
            path.join(BROWSER_PIDFILE_DIR, file),
            "utf-8"
          );
          for (const e of this.parsePidEntries(content)) {
            const existing = entryByPid.get(e.pid);
            if (
              !existing ||
              (existing.display === undefined && e.display !== undefined)
            ) {
              entryByPid.set(e.pid, e);
            }
          }
        } catch {
          // ファイル読めない場合は無視
        }
      }
      const candidates = Array.from(entryByPid.values());
      const minDisplay = DISPLAY_START;
      const maxDisplay = DISPLAY_START + 100;

      if (candidates.length === 0) {
        this.deleteOrphanFiles(orphanFiles);
        return;
      }

      // ps で対象pidのcmdを取得（pid再利用検知）
      const pidToCmd = new Map<number, string>();
      try {
        const psOutput = execFileSync(
          "ps",
          [
            "-ww",
            "-o",
            "pid=,cmd=",
            "-p",
            candidates.map(c => c.pid).join(","),
          ],
          { encoding: "utf-8" }
        );
        for (const line of psOutput.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(.*)$/);
          if (!m) continue;
          pidToCmd.set(Number.parseInt(m[1], 10), m[2]);
        }
      } catch {
        // 全pidが既に死んでいる → orphanFiles削除のみ。
        // ソケット残骸の削除は行わない（pid死亡後にdisplay番号を別の
        // X11サーバーが再利用している場合に live socket を破壊する恐れ）
        this.deleteOrphanFiles(orphanFiles);
        return;
      }

      const orphanPids: number[] = [];
      // pid → display のマップ。kill成功確認後にXvfbソケットを削除するため
      const pidToOrphanDisplay = new Map<number, number>();

      for (const c of candidates) {
        const cmd = pidToCmd.get(c.pid);
        // pid既に終了済みの場合はskip（display単独でのソケット削除はlive socket
        // 破壊リスクがあるため触らない。crashed Xvfbのソケット残骸は
        // findAvailableDisplay()側が「使用中」とみなして100displays中1つ
        // 使えなくなるが、誤動作よりは安全側を優先）
        if (!cmd) continue;

        // Xvfb: pidfile経由でArk由来と確認済み。cmd binary名と
        // displayレンジでpid再利用を検知する（マーカー -fbdir は信頼度を
        // 上げるが、旧版でマーカー無しに起動された残留プロセスも回収できる
        // よう必須にはしない）
        const xvfbMatch = cmd.match(/^Xvfb\s+:(\d+)\b/);
        if (xvfbMatch) {
          const display = Number.parseInt(xvfbMatch[1], 10);
          if (display >= minDisplay && display <= maxDisplay) {
            orphanPids.push(c.pid);
            pidToOrphanDisplay.set(c.pid, display);
          }
          continue;
        }

        // x11vnc: pidfile経由でArk由来と確認済み。cmd binary名と
        // displayレンジでpid再利用を検知する（マーカー -desktop ARK_DESKTOP
        // は任意で旧版互換を保つ）
        const x11vncMatch = cmd.match(/\bx11vnc\b.*?-display\s+:(\d+)\b/);
        if (x11vncMatch) {
          const display = Number.parseInt(x11vncMatch[1], 10);
          if (display >= minDisplay && display <= maxDisplay) {
            orphanPids.push(c.pid);
          }
          continue;
        }

        // websockify: pidfile経由でArk由来と確認できているのでcmd形状のみ確認
        if (
          /\bwebsockify\b/.test(cmd) &&
          /127\.0\.0\.1:\d+\s+127\.0\.0\.1:\d+/.test(cmd)
        ) {
          orphanPids.push(c.pid);
          continue;
        }

        // Chromium: pidfile経由 + Ark固定CDPポートの両方でArk由来と確認
        if (
          /\b(chrome|chromium)\b/.test(cmd) &&
          cmd.includes(`--remote-debugging-port=${CDP_PORT}`)
        ) {
          orphanPids.push(c.pid);
        }
      }

      if (orphanPids.length === 0) {
        this.deleteOrphanFiles(orphanFiles);
        return;
      }

      console.log(
        `[BrowserManager] 孤立プロセスを掃除: pids=${orphanPids.join(",")}`
      );
      for (const pid of orphanPids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // 既に終了済み
        }
      }

      // SIGTERM後、終了をポーリング待機（最大ORPHAN_TERM_TIMEOUT_MS）
      const remainingPids = new Set(orphanPids);
      const deadline = Date.now() + ORPHAN_TERM_TIMEOUT_MS;
      while (remainingPids.size > 0 && Date.now() < deadline) {
        for (const pid of Array.from(remainingPids)) {
          try {
            process.kill(pid, 0); // 存在確認のみ
          } catch {
            remainingPids.delete(pid); // ESRCH → 既に終了
          }
        }
        if (remainingPids.size > 0) {
          try {
            execFileSync("sleep", ["0.1"]);
          } catch {
            break;
          }
        }
      }

      // 残ったプロセスはSIGKILLで強制終了し、消えるまで再待機
      if (remainingPids.size > 0) {
        for (const pid of remainingPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // 既に終了済み
          }
        }
        const killDeadline = Date.now() + ORPHAN_TERM_TIMEOUT_MS;
        while (remainingPids.size > 0 && Date.now() < killDeadline) {
          for (const pid of Array.from(remainingPids)) {
            try {
              process.kill(pid, 0);
            } catch {
              remainingPids.delete(pid);
            }
          }
          if (remainingPids.size > 0) {
            try {
              execFileSync("sleep", ["0.1"]);
            } catch {
              break;
            }
          }
        }
      }

      const survivors = Array.from(remainingPids);
      // kill成功(=remainingPidsに無い)pidのdisplayのみソケット削除する。
      // remainingに残るpid（SIGKILLでも消えなかった）のソケットは
      // 触らない（live socket破壊で次のセッションが衝突するのを避ける）
      for (const pid of orphanPids) {
        if (remainingPids.has(pid)) continue;
        const display = pidToOrphanDisplay.get(pid);
        if (display === undefined) continue;
        try {
          fs.unlinkSync(`/tmp/.X11-unix/X${display}`);
        } catch {
          // 残存しない/権限なしは無視
        }
      }

      if (survivors.length === 0) {
        // 全プロセス終了 → orphan files削除
        this.deleteOrphanFiles(orphanFiles);
      } else {
        // SIGKILL後も生存pidあり → 最初のorphan fileに残存pidを書き戻し、
        // 他は削除。ソケット削除は生存Xvfb所有の可能性があるためスキップ
        // （findAvailableDisplay()の誤判定防止）。次回起動時に再試行される。
        // display情報は元のorphan fileから引き継いで再起動時のソケット回収に活用。
        console.warn(
          `[BrowserManager] 一部の孤立プロセスが終了しませんでした: pids=${survivors.join(",")} ` +
            "（次回起動時に再試行します）"
        );
        const survivorEntries: PidEntry[] = survivors.map(pid => ({
          pid,
          display: entryByPid.get(pid)?.display,
        }));
        try {
          fs.writeFileSync(
            path.join(BROWSER_PIDFILE_DIR, orphanFiles[0]),
            this.serializePidEntries(survivorEntries)
          );
        } catch (err) {
          console.warn(
            `[BrowserManager] survivors書き込み失敗: ${getErrorMessage(err)}`
          );
        }
        for (let i = 1; i < orphanFiles.length; i++) {
          try {
            fs.unlinkSync(path.join(BROWSER_PIDFILE_DIR, orphanFiles[i]));
          } catch {
            // 既に削除されているなどは無視
          }
        }
      }
    } catch (err) {
      console.warn(
        `[BrowserManager] 孤立プロセス掃除に失敗: ${getErrorMessage(err)}`
      );
    }
  }

  /**
   * 指定pidが「Arkサーバープロセスとして生存しているか」を判定する。
   * 単なる kill -0 だけだとpid再利用された別プロセスを「生存」と誤判定して
   * 旧サーバーのpidfileがcleanup対象から永久に漏れる。ps cmd でArkサーバー
   * のentry point パターンを確認する。
   *
   * 対応する起動モード:
   * - 本番 (pm2 fork): `node /path/to/dist/index.js [args]`
   * - 開発 (pnpm dev:server / dev:remote 等): `tsx /path/to/server/index.ts`
   */
  private isArkServerAlive(serverPid: number): boolean {
    try {
      const cmd = execFileSync(
        "ps",
        ["-ww", "-o", "cmd=", "-p", String(serverPid)],
        { encoding: "utf-8" }
      ).trim();
      if (!cmd) return false;
      const hasEntry = /\b(dist\/index\.js|server\/index\.ts)\b/.test(cmd);
      const hasRuntime = /\b(node|tsx)\b/.test(cmd);
      return hasEntry && hasRuntime;
    } catch {
      // ps失敗（pid死亡またはpermission denied）
      return false;
    }
  }

  /**
   * cmd行が Ark由来のブラウザヘルパープロセスのパターンにマッチするかを判定する。
   * pidfileに記録されたpidをsurvivorとして保持/kill対象にする前に、pid再利用で
   * 別プロセスにすり替わっていないかを確認するために使う。
   */
  private isArkBrowserCmd(cmd: string): boolean {
    if (/^Xvfb\s+:\d+\b/.test(cmd)) return true;
    if (/\bx11vnc\b/.test(cmd) && /-display\s+:\d+/.test(cmd)) return true;
    if (
      /\bwebsockify\b/.test(cmd) &&
      /127\.0\.0\.1:\d+\s+127\.0\.0\.1:\d+/.test(cmd)
    ) {
      return true;
    }
    if (
      /\b(chrome|chromium)\b/.test(cmd) &&
      cmd.includes(`--remote-debugging-port=${CDP_PORT}`)
    ) {
      return true;
    }
    return false;
  }

  /** orphan扱いのpidfileを一括削除する */
  private deleteOrphanFiles(orphanFiles: string[]): void {
    for (const file of orphanFiles) {
      try {
        fs.unlinkSync(path.join(BROWSER_PIDFILE_DIR, file));
      } catch {
        // 既に削除されているなどは無視
      }
    }
  }

  /** 自身のpidfileのパス */
  private ownPidFile(): string {
    return path.join(BROWSER_PIDFILE_DIR, String(process.pid));
  }

  /**
   * pidfile内容をPidEntry配列にパースする。
   * 1行 = `<pid>` または `<pid>:<display>`
   */
  private parsePidEntries(content: string): PidEntry[] {
    const entries: PidEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [pidStr, displayStr] = trimmed.split(":");
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const display =
        displayStr !== undefined ? Number.parseInt(displayStr, 10) : Number.NaN;
      entries.push({
        pid,
        display: Number.isFinite(display) ? display : undefined,
      });
    }
    return entries;
  }

  /** PidEntry配列をpidfileテキスト形式にシリアライズする */
  private serializePidEntries(entries: PidEntry[]): string {
    if (entries.length === 0) return "";
    return `${entries
      .map(e =>
        e.display !== undefined ? `${e.pid}:${e.display}` : String(e.pid)
      )
      .join("\n")}\n`;
  }

  /**
   * 現在アクティブなセッションのpidを自身のpidfileに書き戻す。
   *
   * sessions Map が「現在管理中のArkプロセス」の単一の真実だが、
   * 次の点も考慮する必要がある:
   * - 過去のstop()/start失敗で `survivors` として記録されたpidが、新しい
   *   session start/stop で素朴な書き戻しによって失われると、自分が死亡時に
   *   次回起動が孤立を発見できない。既存pidfileから「sessions管理外で
   *   生存中のpid」を読み込んで保持する。
   * - Xvfbのdisplay情報を `pid:display` 形式で記録し、プロセス死亡後の
   *   ソケット残骸回収に活用する。
   */
  private syncPidFile(survivors: number[] = []): void {
    const entries: PidEntry[] = [];
    const activePids = new Set<number>();

    // sessions Mapから現在のpidを集める。Xvfbのみdisplay情報を併記
    for (const session of this.sessions.values()) {
      if (session.xvfb.pid !== undefined) {
        entries.push({ pid: session.xvfb.pid, display: session.displayNum });
        activePids.add(session.xvfb.pid);
      }
      for (const child of [
        session.chromium,
        session.x11vnc,
        session.websockify,
      ]) {
        if (child.pid !== undefined) {
          entries.push({ pid: child.pid });
          activePids.add(child.pid);
        }
      }
    }

    // 既存pidfileから「sessions管理外で生存中のpid（過去のsurvivors）」を保持。
    // pid再利用で別プロセスが同じpidを取っているケースを排除するため、
    // ps cmd を取得してArk由来binary形状にマッチするものだけを残す。
    let priorEntries: PidEntry[] = [];
    try {
      const content = fs.readFileSync(this.ownPidFile(), "utf-8");
      priorEntries = this.parsePidEntries(content);
    } catch {
      // ファイル未作成は無視
    }
    const candidatePriors = priorEntries.filter(e => !activePids.has(e.pid));
    if (candidatePriors.length > 0) {
      const priorPidToCmd = new Map<number, string>();
      try {
        const psOutput = execFileSync(
          "ps",
          [
            "-ww",
            "-o",
            "pid=,cmd=",
            "-p",
            candidatePriors.map(e => e.pid).join(","),
          ],
          { encoding: "utf-8" }
        );
        for (const line of psOutput.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(.*)$/);
          if (!m) continue;
          priorPidToCmd.set(Number.parseInt(m[1], 10), m[2]);
        }
      } catch {
        // 全pid死亡 → priorPidToCmd空のまま、誰も保持されない
      }
      for (const e of candidatePriors) {
        const cmd = priorPidToCmd.get(e.pid);
        if (!cmd) continue; // pid既に死亡
        if (!this.isArkBrowserCmd(cmd)) continue; // pid再利用で別プロセス
        entries.push(e); // 生存中のArk由来survivor → display情報も含めて保持
        activePids.add(e.pid);
      }
    }

    // 今回新たに発生した survivors（display情報なし）
    for (const pid of survivors) {
      if (!activePids.has(pid)) {
        entries.push({ pid });
        activePids.add(pid);
      }
    }

    try {
      fs.mkdirSync(BROWSER_PIDFILE_DIR, { recursive: true });
      fs.writeFileSync(this.ownPidFile(), this.serializePidEntries(entries));
    } catch (err) {
      console.warn(
        `[BrowserManager] pidfile書き込み失敗: ${getErrorMessage(err)}`
      );
    }
  }

  /**
   * 自身のpidfileに記録された pid のうち、現在の sessions Map で管理されて
   * いない（過去の killProcess timeout/start失敗で残った）pid を再 kill する。
   *
   * cleanupOrphanedProcesses は自身の serverPid を skip するため、同一プロセス
   * 内の leak はここで処理する必要がある。start() の各回前に呼び出すことで、
   * 次セッションが leaked DISPLAY/CDPポートと衝突するのを防ぐ。
   */
  private reapOwnSurvivors(): void {
    let entries: PidEntry[] = [];
    try {
      const content = fs.readFileSync(this.ownPidFile(), "utf-8");
      entries = this.parsePidEntries(content);
    } catch {
      return; // ファイル未作成
    }
    if (entries.length === 0) return;

    // 現在の sessions Map のpid（=管理中で触ってはいけない）を集める
    const activePids = new Set<number>();
    for (const session of this.sessions.values()) {
      for (const child of [
        session.xvfb,
        session.chromium,
        session.x11vnc,
        session.websockify,
      ]) {
        if (child.pid !== undefined) activePids.add(child.pid);
      }
    }
    const survivorEntries = entries.filter(e => !activePids.has(e.pid));
    if (survivorEntries.length === 0) return;

    const minDisplay = DISPLAY_START;
    const maxDisplay = DISPLAY_START + 100;

    // ps で対象pidのcmdを取得
    const candidatePids = survivorEntries.map(e => e.pid);
    const pidToCmd = new Map<number, string>();
    try {
      const psOutput = execFileSync(
        "ps",
        ["-ww", "-o", "pid=,cmd=", "-p", candidatePids.join(",")],
        { encoding: "utf-8" }
      );
      for (const line of psOutput.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        pidToCmd.set(Number.parseInt(m[1], 10), m[2]);
      }
    } catch {
      // 全pid死亡 → pidfile再syncのみ（ソケット削除はlive socket破壊リスクが
      // あるためスキップ。crashed Xvfbのソケット残骸は findAvailableDisplay
      // 側が「使用中」扱いするため、安全側の挙動を優先する）
      this.syncPidFile();
      return;
    }

    const reapPids: number[] = [];
    // pid → display のマップ。kill成功確認後にソケット削除するため
    const pidToReapDisplay = new Map<number, number>();

    for (const e of survivorEntries) {
      const cmd = pidToCmd.get(e.pid);
      // 死亡pidのソケットは触らない（display単独でのソケット削除は別X11
      // サーバーの live socket を破壊するリスクがあるため）
      if (!cmd) continue;

      // Xvfb/x11vnc: pidfile経由でArk由来と確認済み。cmd binary名と
      // displayレンジでpid再利用を検知（マーカー -fbdir/-desktop は任意）
      const xvfbMatch = cmd.match(/^Xvfb\s+:(\d+)\b/);
      if (xvfbMatch) {
        const display = Number.parseInt(xvfbMatch[1], 10);
        if (display >= minDisplay && display <= maxDisplay) {
          reapPids.push(e.pid);
          pidToReapDisplay.set(e.pid, display);
        }
        continue;
      }

      const x11vncMatch = cmd.match(/\bx11vnc\b.*?-display\s+:(\d+)\b/);
      if (x11vncMatch) {
        const display = Number.parseInt(x11vncMatch[1], 10);
        if (display >= minDisplay && display <= maxDisplay) {
          reapPids.push(e.pid);
        }
        continue;
      }

      if (
        /\bwebsockify\b/.test(cmd) &&
        /127\.0\.0\.1:\d+\s+127\.0\.0\.1:\d+/.test(cmd)
      ) {
        reapPids.push(e.pid);
        continue;
      }

      if (
        /\b(chrome|chromium)\b/.test(cmd) &&
        cmd.includes(`--remote-debugging-port=${CDP_PORT}`)
      ) {
        reapPids.push(e.pid);
      }
    }

    if (reapPids.length > 0) {
      console.log(
        `[BrowserManager] 自プロセスsurvivorを掃除: pids=${reapPids.join(",")}`
      );
      for (const pid of reapPids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // 既に終了済み
        }
      }
      const remaining = new Set(reapPids);
      const deadline = Date.now() + ORPHAN_TERM_TIMEOUT_MS;
      while (remaining.size > 0 && Date.now() < deadline) {
        for (const pid of Array.from(remaining)) {
          try {
            process.kill(pid, 0);
          } catch {
            remaining.delete(pid);
          }
        }
        if (remaining.size > 0) {
          try {
            execFileSync("sleep", ["0.1"]);
          } catch {
            break;
          }
        }
      }
      if (remaining.size > 0) {
        for (const pid of remaining) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // 既に終了済み
          }
        }
        const killDeadline = Date.now() + ORPHAN_TERM_TIMEOUT_MS;
        while (remaining.size > 0 && Date.now() < killDeadline) {
          for (const pid of Array.from(remaining)) {
            try {
              process.kill(pid, 0);
            } catch {
              remaining.delete(pid);
            }
          }
          if (remaining.size > 0) {
            try {
              execFileSync("sleep", ["0.1"]);
            } catch {
              break;
            }
          }
        }
      }

      // kill成功(=remainingにいない)pidのXvfbソケットのみ削除する。
      // remainingに残るpid（SIGKILLでも消えなかった）のソケットは
      // 触らない（live socket破壊で次のセッションが衝突するのを避ける）
      for (const pid of reapPids) {
        if (remaining.has(pid)) continue;
        const display = pidToReapDisplay.get(pid);
        if (display === undefined) continue;
        try {
          fs.unlinkSync(`/tmp/.X11-unix/X${display}`);
        } catch {
          // 残存しない/権限なしは無視
        }
      }
    }

    // pidfileを再sync。生存中pidがあれば pidfile に survivor として残る
    this.syncPidFile();
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
    const chromiumFound = findChromiumExecutable();
    if (chromiumFound) {
      this.chromiumCmd = chromiumFound;
      console.log(`[BrowserManager] Chromium検出: ${chromiumFound}`);
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

    // 過去のkillProcess timeoutで残った自プロセス内のleakを掃除する。
    // 自身のpidfile由来のsurvivorsは cleanupOrphanedProcesses が
    // 自serverPidをskipするため、別経路で再killしないとDISPLAY/CDP衝突が残る。
    this.reapOwnSurvivors();

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
      // -fbdir はArk由来プロセス識別マーカーを兼ねる（cleanupOrphanedProcesses 参照）
      const xvfb = spawn(
        "Xvfb",
        [
          `:${displayNum}`,
          "-screen",
          "0",
          DISPLAY_RESOLUTION,
          "-fbdir",
          XVFB_FB_DIR,
        ],
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
      // -desktop はArk由来プロセス識別マーカーを兼ねる（cleanupOrphanedProcesses 参照）
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
          "-desktop",
          ARK_DESKTOP,
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
      // pidfileを最新のアクティブセッション一覧で更新
      // （次回起動時のcleanupOrphanedProcesses()がこれを参照する）
      this.syncPidFile();

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
      // killProcessが殺しきれず生き残った子pidを survivors として pidfile に
      // 残し、次回起動時のcleanup候補とする（startup失敗で孤立が永続化するのを防ぐ）
      const partialSurvivors: number[] = [];
      for (const child of startedProcesses) {
        if (child.pid === undefined) continue;
        try {
          process.kill(child.pid, 0);
          partialSurvivors.push(child.pid);
        } catch {
          // 死亡 → 含めない
        }
      }
      if (partialSurvivors.length > 0) {
        this.syncPidFile(partialSurvivors);
      }
      throw error;
    }
  }

  /**
   * プロセスを安全に停止（SIGTERM→待機→SIGKILL→再待機）
   */
  private async killProcess(proc: ChildProcess, name: string): Promise<void> {
    // proc.killed はsignal送信済み(=killメソッド呼出済み)を示すだけで、
    // 実プロセス終了とは無関係なので exitCode のみで判定する。
    if (proc.exitCode !== null) {
      // 既に終了している
      return;
    }

    try {
      proc.kill("SIGTERM");
    } catch {
      // killに失敗（既に死んでいる等）は無視
      return;
    }

    // SIGTERM後の猶予時間を待つ（実プロセス終了まで）
    const exited = await new Promise<boolean>(resolve => {
      if (proc.exitCode !== null) {
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
        if (proc.exitCode !== null) {
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

    // killProcess() がtimeout等で殺しきれず残ったpidを集めて pidfile に残す。
    // これらは自分が死亡した際に次回起動時のcleanup候補となる。
    const survivors: number[] = [];
    for (const child of [
      processSet.websockify,
      processSet.x11vnc,
      processSet.chromium,
      processSet.xvfb,
    ]) {
      if (child.pid === undefined) continue;
      try {
        process.kill(child.pid, 0);
        survivors.push(child.pid); // まだ生きている
      } catch {
        // ESRCH → 死亡 → pidfileに残さない
      }
    }
    this.syncPidFile(survivors);

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
