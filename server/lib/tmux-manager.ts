/**
 * tmux Session Manager
 *
 * tmuxセッションでclaude-codeインスタンスを管理する。
 * 各セッションはattach/detach可能で、サーバー再起動後も維持される。
 */

import { execSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { SpecialKey } from "../../shared/types.js";

/** 送信を許可する特殊キーのホワイトリスト */
const ALLOWED_SPECIAL_KEYS = new Set<SpecialKey>([
  "Enter",
  "C-c",
  "C-d",
  "y",
  "n",
  "S-Tab",
  "Escape",
  "Up",
  "Down",
]);

export interface TmuxSession {
  id: string;
  tmuxSessionName: string;
  worktreePath: string;
  createdAt: Date;
  lastActivity: Date;
  status: "starting" | "running" | "stopped" | "error";
}

export class TmuxManager extends EventEmitter {
  private sessions: Map<string, TmuxSession> = new Map();
  private readonly SESSION_PREFIX = "ark-";
  /** パーミッションスキップフラグ（--dangerously-skip-permissions を付与するか） */
  private skipPermissions = false;

  constructor() {
    super();
    this.checkTmuxInstalled();
    this.discoverExistingSessions();
    this.setCopyCommand();
  }

  /**
   * パーミッションスキップフラグを設定
   * trueの場合、claudeコマンドに --dangerously-skip-permissions を付与する
   */
  setSkipPermissions(value: boolean): void {
    this.skipPermissions = value;
  }

  /**
   * tmuxサーバーのcopy-commandを設定（pbcopyでクリップボード連携）
   */
  private setCopyCommand(): void {
    try {
      execSync('tmux set-option -s copy-command "pbcopy"', { stdio: "pipe" });
    } catch {
      // tmuxサーバーが起動していない場合は設定不要
    }
  }

  /**
   * tmuxがインストールされているか確認
   */
  private checkTmuxInstalled(): void {
    try {
      execSync("which tmux", { stdio: "pipe" });
    } catch {
      console.error(
        "[TmuxManager] tmux not found. Install it:\n" +
          "  macOS: brew install tmux\n" +
          "  Ubuntu: apt install tmux"
      );
    }
  }

  /**
   * 既存のtmuxセッションを検出（前回の実行から残っているもの）
   */
  private discoverExistingSessions(): void {
    try {
      const output = execSync('tmux list-sessions -F "#{session_name}"', {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const sessionNames = output.trim().split("\n").filter(Boolean);

      for (const name of sessionNames) {
        if (name.startsWith(this.SESSION_PREFIX)) {
          const id = name.replace(this.SESSION_PREFIX, "");
          const cwd = this.getTmuxSessionCwd(name);

          this.sessions.set(id, {
            id,
            tmuxSessionName: name,
            worktreePath: cwd || "",
            createdAt: new Date(),
            lastActivity: new Date(),
            status: "running",
          });

          // マウスモードを有効化（再起動時に設定を再適用）
          try {
            execSync(`tmux set-option -t "${name}" mouse on`, {
              stdio: "pipe",
            });
          } catch {
            // セッションが利用不可の場合は無視
          }

          console.log(`[TmuxManager] Discovered existing session: ${name}`);
        }
      }
    } catch {
      // tmuxセッションが存在しない場合
    }
  }

  /**
   * tmuxセッションの作業ディレクトリを取得
   */
  private getTmuxSessionCwd(sessionName: string): string | null {
    try {
      return execSync(
        `tmux display-message -p -t "${sessionName}" "#{pane_current_path}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
    } catch {
      return null;
    }
  }

  /**
   * 新しいtmuxセッションを作成してclaude-codeを起動
   */
  async createSession(worktreePath: string): Promise<TmuxSession> {
    const id = nanoid(8);
    const tmuxSessionName = `${this.SESSION_PREFIX}${id}`;

    let tmuxCreated = false;

    try {
      // tmuxセッションを作成（detached mode）- シェルだけを起動
      const newSessionResult = spawnSync(
        "tmux",
        ["new-session", "-d", "-s", tmuxSessionName, "-c", worktreePath],
        { stdio: "pipe" }
      );
      if (newSessionResult.error) throw newSessionResult.error;
      if (newSessionResult.status !== 0)
        throw new Error(
          `tmux new-session exited with status ${newSessionResult.status}`
        );
      tmuxCreated = true;

      // マウスモードを有効化
      const setOptionResult = spawnSync(
        "tmux",
        ["set-option", "-t", tmuxSessionName, "mouse", "on"],
        { stdio: "pipe" }
      );
      if (setOptionResult.error) throw setOptionResult.error;
      if (setOptionResult.status !== 0)
        throw new Error(
          `tmux set-option exited with status ${setOptionResult.status}`
        );

      // claudeコマンドを送信（終了後もシェルが残るのでvimなども使える）
      // CLAUDECODE環境変数をunsetしてからclaudeを起動（ネストされたセッション検出を回避）
      const claudeCmd = this.skipPermissions
        ? "unset CLAUDECODE && claude --dangerously-skip-permissions"
        : "unset CLAUDECODE && claude";
      const sendKeysResult = spawnSync(
        "tmux",
        ["send-keys", "-t", tmuxSessionName, claudeCmd, "Enter"],
        { stdio: "pipe" }
      );
      if (sendKeysResult.error) throw sendKeysResult.error;
      if (sendKeysResult.status !== 0)
        throw new Error(
          `tmux send-keys exited with status ${sendKeysResult.status}`
        );
    } catch (error) {
      // 作成済みのtmuxセッションをクリーンアップ
      if (tmuxCreated) {
        spawnSync("tmux", ["kill-session", "-t", tmuxSessionName], {
          stdio: "pipe",
        });
      }
      throw new Error(`Failed to create tmux session: ${error}`);
    }

    const session: TmuxSession = {
      id,
      tmuxSessionName,
      worktreePath,
      createdAt: new Date(),
      lastActivity: new Date(),
      status: "running",
    };

    this.sessions.set(id, session);
    this.emit("session:created", session);

    console.log(
      `[TmuxManager] Created session: ${tmuxSessionName} at ${worktreePath}`
    );

    return session;
  }

  /**
   * tmuxセッションにキー入力を送信
   */
  sendKeys(sessionId: string, input: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    // send-keys -l でリテラル送信（spawnSyncなのでシェルエスケープ不要）
    const literalResult = spawnSync(
      "tmux",
      ["send-keys", "-t", session.tmuxSessionName, "-l", input],
      { stdio: "pipe" }
    );
    if (literalResult.error) throw literalResult.error;
    if (literalResult.status !== 0)
      throw new Error(
        `tmux send-keys -l exited with status ${literalResult.status}`
      );

    // Enterキーを別途送信
    const enterResult = spawnSync(
      "tmux",
      ["send-keys", "-t", session.tmuxSessionName, "Enter"],
      { stdio: "pipe" }
    );
    if (enterResult.error) throw enterResult.error;
    if (enterResult.status !== 0)
      throw new Error(
        `tmux send-keys Enter exited with status ${enterResult.status}`
      );

    session.lastActivity = new Date();
  }

  /**
   * 特殊キーを送信 (Enter, Ctrl+C, Ctrl+D など)
   */
  sendSpecialKey(sessionId: string, key: SpecialKey): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    // ホワイトリストに含まれないキーは拒否
    if (!ALLOWED_SPECIAL_KEYS.has(key)) {
      throw new Error(`許可されていない特殊キーです: ${key}`);
    }

    // S-Tab はtmuxでは "BTab" として送信
    const keyMap: Partial<Record<SpecialKey, string>> = {
      "S-Tab": "BTab",
      Up: "Up",
      Down: "Down",
    };
    const tmuxKey = keyMap[key] ?? key;
    const result = spawnSync(
      "tmux",
      ["send-keys", "-t", session.tmuxSessionName, tmuxKey],
      { stdio: "pipe" }
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`tmux send-keys exited with status ${result.status}`);

    session.lastActivity = new Date();
  }

  /**
   * tmuxセッションが存在するか確認
   */
  sessionExists(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    try {
      execSync(`tmux has-session -t "${session.tmuxSessionName}"`, {
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * tmuxセッションを終了
   */
  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      execSync(`tmux kill-session -t "${session.tmuxSessionName}"`, {
        stdio: "pipe",
      });
      console.log(`[TmuxManager] Killed session: ${session.tmuxSessionName}`);
    } catch {
      // セッションが既に終了している場合
    }

    session.status = "stopped";
    this.sessions.delete(sessionId);
    this.emit("session:stopped", sessionId);
  }

  /**
   * tmuxのペーストバッファの内容を取得
   */
  getBuffer(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    try {
      return execSync(`tmux show-buffer`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trimEnd();
    } catch {
      return null;
    }
  }

  /**
   * tmux capture-paneでターミナルの現在の表示内容を取得する
   * @param sessionId セッションID
   * @param lines 取得する行数（デフォルト: 100）
   */
  capturePane(sessionId: string, lines = 100): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    try {
      // -p: stdoutに出力、-S: 開始行（負数で過去の行）
      const result = spawnSync(
        "tmux",
        [
          "capture-pane",
          "-t",
          session.tmuxSessionName,
          "-p",
          "-S",
          `-${lines}`,
        ],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      if (result.status !== 0) return null;
      return (result.stdout ?? "").trimEnd();
    } catch {
      return null;
    }
  }

  /**
   * IDでセッションを取得
   */
  getSession(sessionId: string): TmuxSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * worktreeパスでセッションを取得
   */
  getSessionByWorktree(worktreePath: string): TmuxSession | undefined {
    for (const session of Array.from(this.sessions.values())) {
      if (session.worktreePath === worktreePath) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * 全セッションを取得
   */
  getAllSessions(): TmuxSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 全セッションをクリーンアップ（サーバー終了時は呼ばない - セッション永続化のため）
   */
  cleanup(): void {
    for (const session of Array.from(this.sessions.values())) {
      this.killSession(session.id);
    }
  }
}

export const tmuxManager = new TmuxManager();
