/**
 * tmux Session Manager
 *
 * tmuxセッションでclaude-codeインスタンスを管理する。
 * 各セッションはattach/detach可能で、サーバー再起動後も維持される。
 */

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { SpecialKey } from "../../shared/types.js";
import { resolveTmuxPath } from "./system.js";

// tmux 絶対パス (pm2/systemd で PATH に tmux が無くても動作させるため)。
// 解決不能なら "tmux" にフォールバック (PATH依存)。
const TMUX_BINARY_PATH = resolveTmuxPath() ?? "tmux";

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

/**
 * createSessionの拡張オプション。
 * 全フィールド省略時は既存挙動（互換維持）。
 */
export interface CreateSessionOptions {
  /** 追加で注入する環境変数。tmux new-sessionの -e KEY=VALUE として展開される */
  env?: Record<string, string>;
  /** 起動コマンド。デフォルト: "claude" (skipPermissions有効時は "claude --dangerously-skip-permissions") */
  commandLine?: string;
  /** セッション名のプレフィックス。デフォルト: SESSION_PREFIX ("ark-") */
  namePrefix?: string;
  /**
   * trueの場合、this.sessionsに登録し session:created を emit する（既存挙動、デフォルト）。
   * falseの場合、登録もemitもしない（ログイン用など、SessionOrchestratorの管理外で使うケース）。
   */
  autoDiscover?: boolean;
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
      spawnSync(
        TMUX_BINARY_PATH,
        ["set-option", "-s", "copy-command", "pbcopy"],
        { stdio: "pipe" }
      );
    } catch {
      // tmuxサーバーが起動していない場合は設定不要
    }
  }

  /**
   * tmuxがインストールされているか確認 (起動時にログ出すだけ)
   * 実際の解決パスは TMUX_BINARY_PATH (resolveTmuxPath) で取得済み。
   */
  private checkTmuxInstalled(): void {
    if (TMUX_BINARY_PATH === "tmux") {
      // resolveTmuxPath が解決できなかった (= 多くの環境で見つからない)
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
      const result = spawnSync(
        TMUX_BINARY_PATH,
        ["list-sessions", "-F", "#{session_name}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      if (result.status !== 0) return;
      const output = result.stdout ?? "";
      const sessionNames = output.trim().split("\n").filter(Boolean);

      for (const name of sessionNames) {
        if (name.startsWith(this.SESSION_PREFIX)) {
          // ark-usage-* は UsageCollector が一時的に作る短命セッション。
          // サーバ crash/restart で finally の kill-session が走らずに残った
          // 場合、claude プロセスごと永遠に残留するため、起動時に kill する。
          if (name.startsWith("ark-usage-")) {
            const killResult = spawnSync(
              TMUX_BINARY_PATH,
              ["kill-session", "-t", name],
              { stdio: "pipe" }
            );
            if (killResult.status === 0) {
              console.log(
                `[TmuxManager] Cleaned up orphan usage session: ${name}`
              );
            }
            continue;
          }
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
            spawnSync(
              TMUX_BINARY_PATH,
              ["set-option", "-t", name, "mouse", "on"],
              { stdio: "pipe" }
            );
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
      const result = spawnSync(
        TMUX_BINARY_PATH,
        ["display-message", "-p", "-t", sessionName, "#{pane_current_path}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      if (result.status !== 0) return null;
      return (result.stdout ?? "").trim();
    } catch {
      return null;
    }
  }

  /**
   * 新しいtmuxセッションを作成してclaude-codeを起動
   *
   * @param worktreePath 作業ディレクトリ
   * @param options 互換維持の拡張オプション。省略時は従来挙動。
   */
  async createSession(
    worktreePath: string,
    options?: CreateSessionOptions
  ): Promise<TmuxSession> {
    const id = nanoid(8);
    const namePrefix = options?.namePrefix ?? this.SESSION_PREFIX;
    const tmuxSessionName = `${namePrefix}${id}`;
    const autoDiscover = options?.autoDiscover ?? true;

    // 追加の環境変数を -e KEY=VALUE 形式で展開（既存の -e の後ろに付与）
    const extraEnvArgs: string[] = options?.env
      ? Object.entries(options.env).flatMap(([k, v]) => ["-e", `${k}=${v}`])
      : [];

    // 起動コマンド（commandLine が指定されていればそれを優先）
    const claudeCmd =
      options?.commandLine ??
      (this.skipPermissions
        ? "claude --dangerously-skip-permissions"
        : "claude");

    let tmuxCreated = false;

    try {
      // tmuxセッションを作成（detached mode）- シェルだけを起動
      // -e で環境変数をシェルに直接渡す（set-environmentと異なり即座に反映）
      // CLAUDECODE を空にしてネストされたセッション検出を回避
      // CLAUDE_CODE_NO_FLICKER=1 でttydフリッカー抑制
      const newSessionResult = spawnSync(
        TMUX_BINARY_PATH,
        [
          "new-session",
          "-d",
          "-s",
          tmuxSessionName,
          "-c",
          worktreePath,
          "-e",
          "CLAUDECODE=",
          "-e",
          "CLAUDE_CODE_NO_FLICKER=1",
          ...extraEnvArgs,
        ],
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
        TMUX_BINARY_PATH,
        ["set-option", "-t", tmuxSessionName, "mouse", "on"],
        { stdio: "pipe" }
      );
      if (setOptionResult.error) throw setOptionResult.error;
      if (setOptionResult.status !== 0)
        throw new Error(
          `tmux set-option exited with status ${setOptionResult.status}`
        );

      // claudeコマンド（または options.commandLine）を送信
      // 終了後もシェルが残るのでvimなども使える
      const sendKeysResult = spawnSync(
        TMUX_BINARY_PATH,
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
        spawnSync(TMUX_BINARY_PATH, ["kill-session", "-t", tmuxSessionName], {
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

    // autoDiscover=falseの場合は管理対象に含めない（ログイン用セッションなど）
    if (autoDiscover) {
      this.sessions.set(id, session);
      this.emit("session:created", session);
    }

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
      TMUX_BINARY_PATH,
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
      TMUX_BINARY_PATH,
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
      TMUX_BINARY_PATH,
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

    const result = spawnSync(
      TMUX_BINARY_PATH,
      ["has-session", "-t", session.tmuxSessionName],
      { stdio: "pipe" }
    );
    return result.status === 0;
  }

  /**
   * tmuxセッションを終了
   */
  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const result = spawnSync(
      TMUX_BINARY_PATH,
      ["kill-session", "-t", session.tmuxSessionName],
      { stdio: "pipe" }
    );
    if (result.status === 0) {
      console.log(`[TmuxManager] Killed session: ${session.tmuxSessionName}`);
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
    const result = spawnSync(TMUX_BINARY_PATH, ["show-buffer"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trimEnd();
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
        TMUX_BINARY_PATH,
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
   * tmux capture-pane で「現在画面に表示されている範囲のみ」を取得する。
   *
   * `capturePane` は -S -N で scrollback を含むが、こちらは引数なしで visible 範囲のみ。
   * 用途: /clear 後に「現状の見え方」を取りたい場合、scrollback を含まないことが必要。
   */
  capturePaneVisible(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    try {
      const result = spawnSync(
        TMUX_BINARY_PATH,
        ["capture-pane", "-t", session.tmuxSessionName, "-p"],
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
