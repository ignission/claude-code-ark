/**
 * AskManager - コマンドパレットの「Claude に聞く」に答える、裏の Claude
 *
 * 表のセッションとは別に、サイドバーに出ない tmux セッションを 1 つだけ持ち、対話版の
 * claude を道具なし (`--tools ""`) で動かす。聞かれた文を send-keys で入れ、答えは
 * transcript (JSONL) から読む。表のセッションの会話には触れない。
 *
 * - **動かす場所は Ark 専用の空のフォルダ** (`~/.local/share/ark/ask`)。表のセッションと
 *   同じフォルダで動かすと、会話ビューが「そのフォルダで一番新しい JSONL」としてこちらの
 *   会話を拾う。リポジトリの中でも動かさない (CLAUDE.md や設定を読み込むため)
 * - **JSONL は `--session-id` で決めたファイルを読む**。「一番新しいファイル」を探さない
 * - tmux セッション名は `arkask-<session-id>`。`ark-` で始めないので、サーバー起動時の
 *   セッション復元の対象にならない。名前に session-id を持たせ、サーバーを再起動しても
 *   同じ会話を読み直せるようにする
 * - 新しいフォルダでは claude が「このフォルダを信頼するか」を聞く。答える人がいないので、
 *   その画面が出ている間だけ「はい」を選ぶ (Ark が作った空のフォルダで、道具も無い)。
 *   画面は「その確認が出ているか」「入力欄が出たか」の有無だけを見て、内容は読まない
 * - `--settings` (Ark の hook) は付けない。ボード提案の Stop hook を裏の会話に効かせない
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AskMessage, AskState } from "@ark/shared";
import { encodeProjectDir, projectsDirFor } from "./claude-projects.js";
import { getErrorMessage } from "./errors.js";

export const ASK_SESSION_PREFIX = "arkask-";

const POLL_MS = 400;
const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 45_000;
/** 答えがこれだけ来なければ、待つのをやめる (claude が落ちた、など) */
const BUSY_TIMEOUT_MS = 5 * 60_000;
/** 1 度に聞ける文の長さ */
export const ASK_MAX_LENGTH = 8_000;

export interface TmuxResult {
  status: number | null;
  stdout: string;
}

export interface AskManagerDeps {
  /** tmux を 1 回呼ぶ */
  tmux: (args: string[]) => TmuxResult;
  /** claude を起動するシェルの 1 行 (引数は AskManager が足す) */
  claudeCommand: string;
  /** 裏の claude を動かすフォルダ */
  dir: string;
  /** `<configDir>/projects` */
  projectsDir: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  newId: () => string;
}

export function defaultAskDir(): string {
  return (
    process.env.ARK_ASK_DIR ??
    path.join(os.homedir(), ".local", "share", "ark", "ask")
  );
}

export function defaultAskDeps(
  tmuxBinary: string,
  claudeCommand: string
): AskManagerDeps {
  return {
    tmux: args => {
      const result = spawnSync(tmuxBinary, args, {
        encoding: "utf8",
        timeout: 5_000,
      });
      return {
        status: result.error ? null : result.status,
        stdout: result.stdout ?? "",
      };
    },
    claudeCommand,
    dir: defaultAskDir(),
    projectsDir: projectsDirFor(undefined),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    newId: randomUUID,
  };
}

interface JsonlRow {
  type?: unknown;
  uuid?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  message?: { content?: unknown; stop_reason?: unknown };
}

/** content (文字列か block の配列) から text だけを取り出す */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block =>
      block && typeof block === "object" && block.type === "text"
        ? String(block.text ?? "")
        : ""
    )
    .join("")
    .trim();
}

/**
 * transcript の 1 行を、ウィンドウに出す発話に直す。出さない行は null。
 * `done` は「Claude がそのターンを終えた」(次を待たなくてよい)。
 */
export function parseAskLine(
  raw: string,
  index: number
): { message: AskMessage | null; done: boolean } | null {
  let row: JsonlRow;
  try {
    row = JSON.parse(raw) as JsonlRow;
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || row.isSidechain === true) return null;
  const id = typeof row.uuid === "string" ? row.uuid : `line-${index}`;
  if (row.type === "user") {
    if (row.isMeta === true) return null;
    const text = textOf(row.message?.content).trim();
    // hook やローカルコマンドの出力は `<...>` で包まれて user の行として残る
    if (text === "" || text.startsWith("<")) return null;
    return { message: { id, role: "user", text }, done: false };
  }
  if (row.type === "assistant") {
    const text = textOf(row.message?.content);
    const done =
      row.message?.stop_reason === "end_turn" || row.isApiErrorMessage === true;
    return {
      message: text === "" ? null : { id, role: "assistant", text },
      done,
    };
  }
  return null;
}

export class AskManager extends EventEmitter {
  private sessionId: string | null = null;
  private messages: AskMessage[] = [];
  /** 送ったが、まだ transcript に出ていない文 */
  private pending: AskMessage[] = [];
  private busySince: number | null = null;
  private error: string | null = null;
  private offset = 0;
  private lineCount = 0;
  private partial = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pendingSeq = 0;

  constructor(private readonly deps: AskManagerDeps) {
    super();
  }

  /** サーバーの再起動をまたいで残っている裏のセッションがあれば、その会話を読み直す */
  init(): void {
    const found = this.findSession();
    if (!found) return;
    this.sessionId = found;
    this.readTranscript();
    this.startPolling();
  }

  getState(): AskState {
    return {
      messages: [...this.messages, ...this.pending],
      busy: this.busySince !== null,
      error: this.error,
    };
  }

  /** 文を聞く。送り終えたら返る (答えは `state` で届く) */
  ask(text: string): Promise<void> {
    const run = this.queue.then(() => this.doAsk(text));
    this.queue = run.catch(() => {});
    return run;
  }

  /** 会話をまっさらにする (裏のセッションを終わらせる。次に聞いたときに作り直す) */
  reset(): Promise<void> {
    const run = this.queue.then(() => {
      this.stopPolling();
      if (this.sessionId) {
        this.deps.tmux(["kill-session", "-t", this.sessionName()]);
      }
      this.sessionId = null;
      this.messages = [];
      this.pending = [];
      this.busySince = null;
      this.error = null;
      this.offset = 0;
      this.lineCount = 0;
      this.partial = "";
      this.changed();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** タイマーだけ止める。tmux セッションは残す (再起動後に読み直す) */
  dispose(): void {
    this.stopPolling();
  }

  private sessionName(): string {
    return `${ASK_SESSION_PREFIX}${this.sessionId}`;
  }

  private transcriptPath(): string {
    return path.join(
      this.deps.projectsDir,
      encodeProjectDir(this.deps.dir),
      `${this.sessionId}.jsonl`
    );
  }

  private findSession(): string | null {
    const result = this.deps.tmux(["list-sessions", "-F", "#{session_name}"]);
    if (result.status !== 0) return null;
    const name = result.stdout
      .split("\n")
      .find(line => line.startsWith(ASK_SESSION_PREFIX));
    return name ? name.slice(ASK_SESSION_PREFIX.length) : null;
  }

  private alive(): boolean {
    return (
      this.sessionId !== null &&
      this.deps.tmux(["has-session", "-t", this.sessionName()]).status === 0
    );
  }

  private async doAsk(input: string): Promise<void> {
    // 改行は入力の確定になるので、空白にする
    const text = input.replace(/\s*\n\s*/g, " ").trim();
    if (text === "") throw new Error("聞く文が空です");
    if (text.length > ASK_MAX_LENGTH) {
      throw new Error(`聞く文が長すぎます (${ASK_MAX_LENGTH}文字まで)`);
    }
    this.error = null;
    this.pendingSeq += 1;
    const pending: AskMessage = {
      id: `pending-${this.pendingSeq}`,
      role: "user",
      text,
    };
    this.pending.push(pending);
    this.busySince = this.deps.now();
    this.changed();
    try {
      if (!this.alive()) {
        // 前のセッションへ送ったままの文は、もう答えが来ない
        this.pending = [pending];
        await this.startSession();
      }
      const target = this.sessionName();
      const typed = this.deps.tmux(["send-keys", "-t", target, "-l", text]);
      const entered =
        typed.status === 0
          ? this.deps.tmux(["send-keys", "-t", target, "Enter"])
          : typed;
      if (entered.status !== 0)
        throw new Error("裏の Claude へ送れませんでした");
      this.startPolling();
    } catch (error) {
      this.pending = this.pending.filter(message => message !== pending);
      this.busySince = null;
      this.error = getErrorMessage(error);
      this.changed();
      throw error;
    }
  }

  private async startSession(): Promise<void> {
    this.stopPolling();
    this.sessionId = this.deps.newId();
    this.messages = [];
    this.offset = 0;
    this.lineCount = 0;
    this.partial = "";
    fs.mkdirSync(this.deps.dir, { recursive: true });
    const name = this.sessionName();
    const created = this.deps.tmux([
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "160",
      "-y",
      "50",
      "-c",
      this.deps.dir,
      // TmuxManager.createSession と同じ (入れ子の検出を避ける / ちらつきを抑える /
      // pm2 の NODE_ENV=production を継がせない)
      "-e",
      "CLAUDECODE=",
      "-e",
      "CLAUDE_CODE_NO_FLICKER=1",
      "-e",
      "NODE_ENV=",
    ]);
    if (created.status !== 0) {
      this.sessionId = null;
      throw new Error("裏の Claude のセッションを作れませんでした");
    }
    const command = `unset CLAUDE_CONFIG_DIR; ${this.deps.claudeCommand} --tools '' --session-id ${this.sessionId}`;
    this.deps.tmux(["send-keys", "-t", name, command, "Enter"]);
    try {
      await this.waitReady(name);
    } catch (error) {
      this.deps.tmux(["kill-session", "-t", name]);
      this.sessionId = null;
      throw error;
    }
  }

  /** 入力欄が出るまで待つ。フォルダの信頼の確認が出ていたら「はい」を選ぶ */
  private async waitReady(name: string): Promise<void> {
    const deadline = this.deps.now() + READY_TIMEOUT_MS;
    while (this.deps.now() < deadline) {
      await this.deps.sleep(READY_POLL_MS);
      const pane = this.deps.tmux(["capture-pane", "-p", "-t", name]);
      if (pane.status !== 0) break;
      if (pane.stdout.includes("trust this folder")) {
        // 既定は「いいえ」なので、1 つ下の「はい」へ移してから確定する
        this.deps.tmux(["send-keys", "-t", name, "Down"]);
        this.deps.tmux(["send-keys", "-t", name, "Enter"]);
        continue;
      }
      if (/^\s*❯/m.test(pane.stdout)) return;
    }
    throw new Error("裏の Claude が起動しませんでした");
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    let changed = this.readTranscript();
    if (
      this.busySince !== null &&
      this.deps.now() - this.busySince > BUSY_TIMEOUT_MS
    ) {
      this.busySince = null;
      this.error = "答えが返ってきませんでした";
      changed = true;
    }
    if (changed) this.changed();
  }

  /** transcript の続きを読む。発話や状態が変わったら true */
  private readTranscript(): boolean {
    if (!this.sessionId) return false;
    let chunk: string;
    try {
      const file = this.transcriptPath();
      const size = fs.statSync(file).size;
      if (size <= this.offset) return false;
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buffer, 0, buffer.length, this.offset);
        this.offset = size;
        chunk = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // まだ書かれていない (claude は最初の発話でファイルを作る)
      return false;
    }
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) {
      if (line.trim() === "") continue;
      this.lineCount += 1;
      const parsed = parseAskLine(line, this.lineCount);
      if (!parsed) continue;
      const { message } = parsed;
      if (message) {
        if (message.role === "user") {
          const at = this.pending.findIndex(p => p.text === message.text);
          if (at >= 0) this.pending.splice(at, 1);
        }
        this.messages.push(message);
        changed = true;
      }
      // 続けて聞いた文がまだ残っていれば、その答えを待つ
      if (parsed.done && this.busySince !== null && this.pending.length === 0) {
        this.busySince = null;
        changed = true;
      }
    }
    return changed;
  }

  private changed(): void {
    this.emit("state", this.getState());
  }
}
