/**
 * Claude Code CLI の状態ファイル (`<configDir>/sessions/<pid>.json`)
 *
 * ## なぜ読むのか
 *
 * Ark の状態判定 (`bridge-collector.ts` の `detectStatus`) は tmux の画面に
 * 進行中の行 (`✻ Wibbling… (4s · 23 tokens · esc to interrupt)`) があるかだけを
 * 見ている。Claude Code が背景でサブエージェントを走らせているあいだ、本体は
 * 入力待ちに戻るのでこの行が消え、IDLE =「あなたの番」に落ちてしまう。
 *
 * CLI 自身は同じ状況で状態ファイルに `"status":"busy"` を書き続ける
 * (実測: 本体が止まり subagent だけが動く 2 分半のあいだ、15 秒刻み 9 サンプル
 * すべて busy)。そこで **busy のときだけ「作業中」に格上げする**。
 *
 * ## CLAUDE.md の「画面テキストから内容をパースしない」原則との関係
 *
 * 反しない。読むのは画面ではなくファイルで、取り出すのは会話の内容ではなく
 * 状態 (busy/waiting/idle) の 1 語だけである。会話内容は従来どおり 100% JSONL
 * transcript から取る。
 *
 * ## これは Claude Code の内部ファイルである
 *
 * 公開された契約ではないので、CLI のバージョンが上がれば形が変わりうるし、
 * 無くなることもある (実測でも古い CLI で起動したセッションにはファイルが無い)。
 * そのため **この機構は「読めたら足す」だけに徹する**:
 *
 * - パースできない / フィールドが増減した / status の語彙が変わった
 *   → そのファイルを捨てて `null` (= 既存の画面判定をそのまま使う) に倒れる
 * - ディレクトリごと無い → 空として扱う (警告も出さない)
 * - 形が変わったときの壊れ方は「格上げされなくなる」= 今までの挙動に戻るだけ。
 *   誤った状態を表示する方向には壊れない (busy 以外は一切上書きしないため)
 *
 * ## 生死の確認
 *
 * ファイルはプロセスが死んでも残るため、`/proc/<pid>` の有無と
 * `/proc/<pid>/stat` の starttime (22 番目) が `procStart` と一致するかを見て、
 * PID 使い回しの誤判定を防ぐ。`/proc` の無い環境 (macOS / Windows) では生死を
 * 確かめられないので **機構ごと無効にする** (常に null を返し、Ark は従来どおり
 * 画面だけで判定する)。
 *
 * ## プロファイル切替との関係
 *
 * 状態ファイルはセッションの `CLAUDE_CONFIG_DIR` 配下に書かれるため、
 * プロファイルを使うセッションでは `<configDir>/sessions/` を見る必要がある
 * (実測: `~/.claude-knowbe1/sessions/` に同じ形のファイルがあった)。
 * configDir が渡されなければ `~/.claude/sessions/` を見る。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeSessionStatus } from "@ark/shared";

/** CLI が状態ファイルに書く状態。実測の観測値は busy / waiting / idle の 3 つ */
export type CliSessionState = "busy" | "waiting" | "idle";

const CLI_SESSION_STATES = new Set<string>(["busy", "waiting", "idle"]);

/** 生存確認済みの 1 セッション分の記録 */
export interface CliSessionRecord {
  pid: number;
  /** `tmux` フィールドの ':' より前 (= tmux セッション名) */
  tmuxSessionName: string;
  cwd: string;
  state: CliSessionState;
  /** 同じ tmux 名の記録が複数あったときに新しい方を選ぶための時刻 */
  updatedAt: number;
}

/** fs / /proc / 時刻の差し替え口。テストはここだけ差し替える */
export interface CliSessionIo {
  platform: NodeJS.Platform;
  homeDir(): string;
  /** ディレクトリのエントリ名一覧。読めなければ throw してよい */
  readDir(dir: string): string[];
  readFile(file: string): string;
  /** `/proc/<pid>/stat` の中身。プロセスが無ければ null */
  readProcStat(pid: number): string | null;
  now(): number;
}

export const nodeCliSessionIo: CliSessionIo = {
  platform: process.platform,
  homeDir: () => os.homedir(),
  readDir: dir => fs.readdirSync(dir),
  readFile: file => fs.readFileSync(file, "utf-8"),
  readProcStat: pid => {
    try {
      return fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};

/**
 * `/proc/<pid>/stat` から starttime (22 番目のフィールド) を文字列のまま返す。
 *
 * 2 番目の comm はプロセス名がそのまま入り空白も ')' も含みうるので、
 * **最後の ')'** より後ろだけを数える。starttime は clock tick 数で
 * 桁が大きいため、数値化せず文字列比較する。
 */
export function parseProcStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // fields[0] は 3 番目 (state) なので、22 番目は index 19
  const starttime = fields[19];
  if (!starttime || !/^\d+$/.test(starttime)) return null;
  return starttime;
}

/**
 * 画面から出した状態に、CLI の状態ファイルを重ねる。
 *
 * **busy のときだけ「作業中」に格上げする。それ以外では画面の判定を一切
 * 上書きしない。**
 *
 * - AWAITING / ERR は画面を優先する。許諾プロンプトは画面にしか出ないので、
 *   subagent が動いていてもユーザーの操作が要る
 * - STOP はライフサイクル上の停止なので触らない
 * - waiting / idle / 不明 では降格させない。状態ファイルが遅れているだけの
 *   ときに、動いている画面を「あなたの番」に落とす方が害が大きい
 */
export function mergeCliSessionState(
  screen: BridgeSessionStatus,
  state: CliSessionState | null
): BridgeSessionStatus {
  if (state !== "busy") return screen;
  if (screen === "IDLE" || screen === "READY") return "TOOL";
  return screen;
}

/** 末尾スラッシュの差を無視してパスを比べる */
function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return normalize(a) === normalize(b);
}

interface DirSnapshot {
  readAt: number;
  records: Map<string, CliSessionRecord>;
}

export interface CliSessionStatusReaderOptions {
  /** 同じディレクトリを読み直す間隔 (ms)。polling は 1 秒間隔なので既定 2 秒 */
  ttlMs?: number;
  warn?: (message: string) => void;
}

export interface CliSessionLookup {
  tmuxSessionName: string;
  worktreePath: string;
  /** セッションの CLAUDE_CONFIG_DIR。無ければ `~/.claude` */
  configDir?: string | null;
}

/**
 * 状態ファイルを短い TTL で読み、tmux セッション名から状態を引く。
 *
 * 1 秒間隔の polling 経路から 1 tick につきセッション数だけ呼ばれるため、
 * ディレクトリ単位で結果をメモ化する。メモは **毎回まるごと作り直す** ので、
 * 消えたセッションの記録が残り続けることはない。
 */
export class CliSessionStatusReader {
  private readonly snapshots = new Map<string, DirSnapshot>();
  /** 壊れたファイルの警告を毎 tick 出さないための記録 (ファイルパス → 直近の文言) */
  private readonly warned = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly io: CliSessionIo = nodeCliSessionIo,
    options: CliSessionStatusReaderOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? 2_000;
    this.warn = options.warn ?? (message => console.warn(message));
  }

  /**
   * セッションの状態を返す。読めない・確かめられない場合はすべて null。
   *
   * tmux セッション名で対応づけ、`cwd` が Ark 側の worktree と一致することを
   * 確かめてから採用する (取り違え防止)。
   */
  stateFor(lookup: CliSessionLookup): CliSessionState | null {
    // /proc が無い環境では死んだプロセスの残骸を弾けないので機構ごと無効
    if (this.io.platform !== "linux") return null;
    try {
      const dir = this.sessionsDir(lookup.configDir);
      const record = this.read(dir).get(lookup.tmuxSessionName);
      if (!record) return null;
      if (!samePath(record.cwd, lookup.worktreePath)) return null;
      return record.state;
    } catch {
      // polling 経路なので、どんな失敗も「読めない」に倒す
      return null;
    }
  }

  private sessionsDir(configDir?: string | null): string {
    const base = configDir ?? path.join(this.io.homeDir(), ".claude");
    return path.join(base, "sessions");
  }

  private read(dir: string): Map<string, CliSessionRecord> {
    const now = this.io.now();
    const cached = this.snapshots.get(dir);
    if (cached && now - cached.readAt < this.ttlMs) return cached.records;
    const records = this.scan(dir);
    this.snapshots.set(dir, { readAt: now, records });
    return records;
  }

  private scan(dir: string): Map<string, CliSessionRecord> {
    const records = new Map<string, CliSessionRecord>();
    let entries: string[];
    try {
      entries = this.io.readDir(dir);
    } catch {
      // ディレクトリが無いのは古い CLI / 未使用のプロファイルでは普通のこと。
      // 警告は出さず、空として扱う
      this.forgetWarningsUnder(dir);
      return records;
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(dir, entry);
      seen.add(file);
      const record = this.readRecord(file);
      if (!record) continue;
      const previous = records.get(record.tmuxSessionName);
      // 同じ tmux セッション名の記録が複数生きていたら新しい方を採る
      if (previous && previous.updatedAt >= record.updatedAt) continue;
      records.set(record.tmuxSessionName, record);
    }
    for (const file of Array.from(this.warned.keys())) {
      if (file.startsWith(`${dir}/`) && !seen.has(file))
        this.warned.delete(file);
    }
    return records;
  }

  /** 1 ファイルを読んで、生きていると確認できた記録だけを返す */
  private readRecord(file: string): CliSessionRecord | null {
    let text: string;
    try {
      text = this.io.readFile(file);
    } catch {
      // 読んでいる最中に消えた等。次の tick で拾い直せばよい
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.reportMalformed(file, `JSON として読めません: ${String(error)}`);
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
      this.reportMalformed(file, "オブジェクトではありません");
      return null;
    }
    const json = parsed as Record<string, unknown>;
    const pid = json.pid;
    const cwd = json.cwd;
    const tmux = json.tmux;
    const status = json.status;
    const procStart = json.procStart;
    // 形が変わって必要なフィールドが無い / 型が違う → 静かに捨てる。
    // (CLI の内部ファイルなので、version 差で欠けるのは想定内。警告は
    //  「壊れている」ことが明らかな JSON パース失敗のときだけに絞る)
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
      return null;
    if (typeof cwd !== "string" || cwd === "") return null;
    if (typeof tmux !== "string" || tmux === "") return null;
    if (typeof status !== "string" || !CLI_SESSION_STATES.has(status))
      return null;
    if (typeof procStart !== "string" && typeof procStart !== "number")
      return null;
    if (!this.isAlive(pid, String(procStart))) return null;
    const tmuxSessionName = tmux.split(":")[0];
    if (!tmuxSessionName) return null;
    return {
      pid,
      tmuxSessionName,
      cwd,
      state: status as CliSessionState,
      updatedAt: numberOr(json.statusUpdatedAt, numberOr(json.updatedAt, 0)),
    };
  }

  /**
   * プロセスが生きていて、かつ起動時刻が一致するかを見る。
   *
   * 死んだセッションのファイルは残るうえ、PID は使い回されるので、
   * `/proc/<pid>/stat` の starttime を照合しないと別プロセスを掴む。
   */
  private isAlive(pid: number, procStart: string): boolean {
    const stat = this.io.readProcStat(pid);
    if (!stat) return false;
    const starttime = parseProcStartTime(stat);
    return starttime !== null && starttime === procStart;
  }

  private reportMalformed(file: string, reason: string): void {
    const message = `[CliSessionStatus] ${file}: ${reason}`;
    if (this.warned.get(file) === message) return;
    this.warned.set(file, message);
    this.warn(message);
  }

  private forgetWarningsUnder(dir: string): void {
    for (const file of Array.from(this.warned.keys())) {
      if (file.startsWith(`${dir}/`)) this.warned.delete(file);
    }
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 本番用のシングルトン (fs も os も constructor では触らない) */
export const cliSessionStatusReader = new CliSessionStatusReader();
