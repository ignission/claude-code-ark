/**
 * tmux Session Manager
 *
 * tmuxセッションでclaude-codeインスタンスを管理する。
 * 各セッションはattach/detach可能で、サーバー再起動後も維持される。
 */

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { SpecialKey } from "@ark/shared";
import { nanoid } from "nanoid";
import { errnoCode, errnoMessage } from "./errors.js";
import { resolveClaudePath, resolveTmuxPath } from "./system.js";
import {
  describeTmuxReadFailure,
  type TmuxReadFailure,
  type TmuxReadResult,
} from "./tmux-read-result.js";

// tmux 絶対パス (pm2/systemd で PATH に tmux が無くても動作させるため)。
// 解決不能なら "tmux" にフォールバック (PATH依存)。
const TMUX_BINARY_PATH = resolveTmuxPath() ?? "tmux";

/**
 * セッション作成/破棄系および読み取り系の tmux コマンドの打ち切り時間 (ms)。
 * spawnSync は同期呼び出しでハングするとイベントループごと停止し、
 * JS 側のタイムアウト (Promise.race 等) では救えない。timeout で子プロセスを
 * kill させ error → throw に変換することで、restartSession の in-flight guard
 * が finally で確実に解放される (通常の tmux コマンドは数十 ms で完了する)。
 * 読み取り系では timeout は `tmux-failed` (code=ETIMEDOUT, signal=SIGTERM) として
 * 結果に残る。
 */
const TMUX_CMD_TIMEOUT_MS = 10_000;

type TmuxCommandFailure = Extract<TmuxReadFailure, { kind: "tmux-failed" }>;

type TmuxCommandResult =
  | { ok: true; stdout: string }
  | { ok: false; failure: TmuxCommandFailure };

/**
 * 読み取り系の tmux コマンドを実行し、失敗要因を型で返す。
 *
 * spawnSync は通常 throw せず `result.error` (ENOENT / ETIMEDOUT 等) と
 * `status` / `signal` で失敗を表すため、それらをまとめて `tmux-failed` に詰める。
 * stdout は encoding 指定で string になるが、テストのモックが Buffer を返す
 * 場合もあるので String() で正規化する。
 */
function runTmux(args: string[]): TmuxCommandResult {
  const command = args[0] ?? "";
  try {
    const result = spawnSync(TMUX_BINARY_PATH, args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: TMUX_CMD_TIMEOUT_MS,
    });
    const stderr = String(result.stderr ?? "").trim();
    if (result.error || result.status !== 0) {
      return {
        ok: false,
        failure: {
          kind: "tmux-failed",
          command,
          status: result.status ?? null,
          signal: result.signal ?? null,
          stderr,
          ...(result.error
            ? {
                code: errnoCode(result.error),
                message: errnoMessage(result.error),
              }
            : {}),
        },
      };
    }
    return { ok: true, stdout: String(result.stdout ?? "") };
  } catch (e) {
    // spawnSync が throw するのは引数不正等の例外的なケース。握り潰さず残す
    return {
      ok: false,
      failure: {
        kind: "tmux-failed",
        command,
        status: null,
        signal: null,
        stderr: "",
        code: errnoCode(e),
        message: errnoMessage(e),
      },
    };
  }
}

const NO_SESSION: TmuxReadResult<never> = {
  ok: false,
  failure: { kind: "no-session" },
};
const NOT_SET: TmuxReadResult<never> = {
  ok: false,
  failure: { kind: "not-set" },
};

/**
 * `tmux show-environment -t <session>` の一覧出力から変数の値を取り出す。
 * 出力形式は 1 行 1 変数で `NAME=value` または `-NAME` (unset マーカー)。
 * 変数名を指定した `show-environment NAME` は未設定時に exit 1 となり
 * tmux 失敗と区別できないため、一覧を取って自前で探す。
 */
function findEnvValue(listing: string, name: string): string | null {
  for (const line of listing.split("\n")) {
    if (line === `-${name}`) return null;
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1);
  }
  return null;
}

/**
 * POSIX shell の single-quote 文字列にエスケープする。
 * 'foo bar' のように wrap し、入力中の `'` は `'\''` (single quote を抜けて
 * リテラル single quote を入れ再度入る) に置き換える。
 * tmux send-keys に渡す文字列は shell が解釈するため、`$VAR` / バッククォート
 * / `\n` / `"` 等のメタ文字を完全に止めるには single-quote が最も堅牢。
 */
function posixShellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * resolveClaudePath() の結果を tmux send-keys / shell 起動用に検証する。
 *
 * 戻り値は以下のいずれか:
 *   - 検証通過した絶対パス (呼び出し側で posixShellQuote() するための原文字列)
 *   - "claude" (resolver が null を返した = claude binary が見つからない正当な状態)
 *
 * 「resolver が非 null を返したが invalid」ケースは throw する:
 *   resolver が壊れた値 (相対パス / 制御文字付きパス) を返した状態で
 *   "claude" にフォールバックすると、信頼境界が PATH に広がり、PATH 汚染時に
 *   意図しない claude を起動する。fail-fast でセッション作成を拒否する方が
 *   セキュリティ + Assertive Programming として一貫している。
 *
 * 検証項目 (非 null path 入力時):
 *   - 絶対パス (path.isAbsolute) であること
 *   - 制御文字 (U+0000..U+001F, U+007F) を一切含まないこと
 *     POSIX path に formal には許される文字だが、`\n` `\r` `\0` は send-keys / shell
 *     コマンド注入になり、`ESC` (0x1B) や `BS` / `DEL` は端末側で解釈されて
 *     入力行や terminal state を壊し得る。single-quote 済みでも readline 経路で
 *     脱出される余地があるため、全 control char を一律拒否する。
 *
 */
function resolveValidatedClaudePath(): string {
  const resolved = resolveClaudePath();
  if (resolved === null) return "claude";
  if (!path.isAbsolute(resolved)) {
    throw new Error(
      `resolveClaudePath returned non-absolute path: ${JSON.stringify(resolved)}`
    );
  }
  // 全 ASCII 制御文字 (`\x00`-`\x1F` + `\x7F`) を一律拒否。
  // 個別列挙でなく範囲指定にすることで、将来も terminal / shell エスケープ
  // 経路を増やさないよう assertive に保つ。
  if (/[\x00-\x1F\x7F]/.test(resolved)) {
    throw new Error(
      "resolveClaudePath returned path containing control char (rejected for shell/terminal injection safety)"
    );
  }
  return resolved;
}

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
  // AskUserQuestion multiSelect の Submit タブ移動に使用
  "Right",
  // multiSelect 選択肢のトグルに使用
  "Space",
  // 数字キー (AskUserQuestion の選択肢直接ジャンプに使用)
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
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
  /** claude 起動時に --settings で注入する hooks 設定 JSON のパス */
  private claudeSettingsPath: string | null = null;
  /**
   * claude 起動時に --mcp-config で注入する per-session MCP config JSON のパス
   * (board_write 等)。SessionOrchestrator がセッション起動直前に設定する。
   */
  private claudeMcpConfigPath: string | null = null;

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
   * claude 起動コマンドに `--settings <path>` で注入する settings JSON を
   * 設定する (SessionStart / AskUserQuestion の hooks 等)。
   * サーバー起動時 (listen 後、port 確定後) に呼ばれる。
   */
  setClaudeSettingsPath(value: string | null): void {
    this.claudeSettingsPath = value;
  }

  /**
   * claude 起動コマンドに `--mcp-config <path>` で注入する per-session MCP
   * config JSON を設定する (board_write 等)。--strict-mcp-config は付けない
   * (ユーザーの他 MCP を無効化しないため、board MCP は既存 MCP に上乗せする)。
   * このインスタンスは全セッションで共有されるため、SessionOrchestrator は
   * 各セッション起動 (createSession 呼び出し) の直前に必ず設定し直すこと
   * (board MCP が利用不可なセッションでは null を渡して前回値を持ち越さない)。
   */
  setClaudeMcpConfigPath(value: string | null): void {
    this.claudeMcpConfigPath = value;
  }

  /**
   * tmuxサーバーのcopy-commandを設定（pbcopyでクリップボード連携）
   */
  private setCopyCommand(): void {
    try {
      spawnSync(
        TMUX_BINARY_PATH,
        ["set-option", "-s", "copy-command", "pbcopy"],
        { stdio: "pipe", timeout: TMUX_CMD_TIMEOUT_MS }
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
      const result = runTmux(["list-sessions", "-F", "#{session_name}"]);
      if (!result.ok) {
        // サーバー未起動 ("no server running on ...") は正常な初回起動だが、
        // socket の権限エラー等でも同じ分岐に入る。セッションが「全消滅した」
        // ように見えたとき事後に切り分けられるよう、理由を必ず残す
        console.log(
          `[TmuxManager] 既存セッションを検出できません: ${describeTmuxReadFailure(result.failure)}`
        );
        return;
      }
      const sessionNames = result.stdout.trim().split("\n").filter(Boolean);

      for (const name of sessionNames) {
        if (name.startsWith(this.SESSION_PREFIX)) {
          // ark-usage-* は UsageCollector が一時的に作る短命セッション。
          // サーバ crash/restart で finally の kill-session が走らずに残った
          // 場合、claude プロセスごと永遠に残留するため、起動時に kill する。
          if (name.startsWith("ark-usage-")) {
            const killResult = spawnSync(
              TMUX_BINARY_PATH,
              ["kill-session", "-t", name],
              { stdio: "pipe", timeout: TMUX_CMD_TIMEOUT_MS }
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
          if (!cwd.ok) {
            // worktreePath が空のまま復元されると orphan 判定も DB 照合も
            // 効かず黙って進むため、理由をログに残す
            console.warn(
              `[TmuxManager] ${name}: pane_current_path を取得できません (${describeTmuxReadFailure(cwd.failure)})。worktreePath を空で復元します`
            );
          }

          this.sessions.set(id, {
            id,
            tmuxSessionName: name,
            worktreePath: cwd.ok ? cwd.value : "",
            createdAt: new Date(),
            lastActivity: new Date(),
            status: "running",
          });

          // マウスモードを有効化（再起動時に設定を再適用）
          try {
            spawnSync(
              TMUX_BINARY_PATH,
              ["set-option", "-t", name, "mouse", "on"],
              { stdio: "pipe", timeout: TMUX_CMD_TIMEOUT_MS }
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
  private getTmuxSessionCwd(sessionName: string): TmuxReadResult<string> {
    const result = runTmux([
      "display-message",
      "-p",
      "-t",
      sessionName,
      "#{pane_current_path}",
    ]);
    if (!result.ok) return result;
    return { ok: true, value: result.stdout.trim() };
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
    // claude binary は resolveClaudePath() で絶対パスを取得する。これにより:
    //   - .app 配布で system PATH に claude が無い環境でも、同梱 SDK 付属の
    //     claude (`app.asar.unpacked/node_modules/@anthropic-ai/.../claude`) を起動できる
    //   - 解決できない場合は "claude" 文字列にフォールバック (PATH 解決を shell に委譲)
    //
    // 解決結果は shell に渡す文字列になるので以下を assert する:
    //   - 絶対パス (path.isAbsolute) であること
    //   - 改行 / NUL / shell metachar を含まないこと
    //     ( ' " ` $ \ \n 等が含まれていれば双方向に injection 余地が出る)
    // assertion 違反時は "claude" フォールバックして resolver 側の異常を握りつぶさず
    // ログに残す。
    // shell quoting は POSIX 互換の single-quote で wrap する: 全シェルで文字列内
    // のメタ文字解釈が止まるため、double-quote で `$` `` ` `` `\` `"` が解釈される
    // リスクを避けられる (codex P1 指摘対応)。
    const claudeBinary = resolveValidatedClaudePath();
    const claudeArg =
      claudeBinary === "claude" ? "claude" : posixShellQuote(claudeBinary);
    // AskUserQuestion hook 等を注入する claude 用 settings (--settings)。
    // サーバー起動時に setClaudeSettingsPath で設定される。
    const settingsArg = this.claudeSettingsPath
      ? ` --settings ${posixShellQuote(this.claudeSettingsPath)}`
      : "";
    // board_write 等の per-session MCP server を注入する --mcp-config。
    // SessionOrchestrator が起動直前に setClaudeMcpConfigPath で設定する。
    // --strict-mcp-config は付けない。strict を付けるとユーザーの project
    // .mcp.json / global 設定の他 MCP が全て無効化されるため、board MCP は
    // 既存 MCP に上乗せする（strict なしなら追加マージされる）。
    const mcpConfigArg = this.claudeMcpConfigPath
      ? ` --mcp-config ${posixShellQuote(this.claudeMcpConfigPath)}`
      : "";
    // プロファイル未指定のセッションが、Ark サーバープロセス (やその親、
    // tmux サーバー) の CLAUDE_CONFIG_DIR を意図せず継承すると、transcript が
    // 想定外の config dir 配下に書かれ、JSONL tail (チャットビュー) が
    // 参照する <profileConfigDir ?? ~/.claude>/projects と不整合になる。
    // tmux の -e は空文字設定しかできず、claude は空文字 CLAUDE_CONFIG_DIR を
    // 「cwd を config dir に使う」と解釈して worktree 内に projects/ 等を
    // 作ってしまう (実機確認済み) ため、シェル変数ごと unset してから起動する。
    const hasProfileEnv =
      options?.env != null && "CLAUDE_CONFIG_DIR" in options.env;
    const envPrefix = hasProfileEnv ? "" : "unset CLAUDE_CONFIG_DIR; ";
    const skipFlag = this.skipPermissions
      ? " --dangerously-skip-permissions"
      : "";
    const claudeCmd =
      options?.commandLine ??
      `${envPrefix}${claudeArg}${skipFlag}${settingsArg}${mcpConfigArg}`;

    let tmuxCreated = false;

    try {
      // tmuxセッションを作成（detached mode）- シェルだけを起動
      // -e で環境変数をシェルに直接渡す（set-environmentと異なり即座に反映）
      // CLAUDECODE を空にしてネストされたセッション検出を回避
      // CLAUDE_CODE_NO_FLICKER=1 でttydフリッカー抑制
      // NODE_ENV を空文字でリセットして、Ark を PM2 で起動した際の
      // NODE_ENV=production が子セッション (claude → shell → pnpm 等) に
      // 継承されるのを防ぐ。Storybook dev mode 等が development 前提で
      // 動作するため、production が継承されると DefinePlugin の NODE_ENV
      // conflict 等で React Refresh が壊れる ($RefreshSig$ is not defined)
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
          "-e",
          "NODE_ENV=",
          ...extraEnvArgs,
        ],
        { stdio: "pipe", timeout: TMUX_CMD_TIMEOUT_MS }
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
        { stdio: "pipe", timeout: TMUX_CMD_TIMEOUT_MS }
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
        { stdio: "pipe", timeout: TMUX_CMD_TIMEOUT_MS }
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
          timeout: TMUX_CMD_TIMEOUT_MS,
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

    // Esc 後に Claude 側の入力欄へ直前メッセージが復元されているケース等、
    // tmux pane の入力バッファに既存テキストが残っていると Ark から送る
    // テキストと連結されて重複送信になる。事前に C-u (kill line) を送って
    // 入力をクリアしてからリテラル送信する。入力が空なら C-u は no-op。
    const clearResult = spawnSync(
      TMUX_BINARY_PATH,
      ["send-keys", "-t", session.tmuxSessionName, "C-u"],
      { stdio: "pipe" }
    );
    if (clearResult.error) throw clearResult.error;
    if (clearResult.status !== 0)
      throw new Error(
        `tmux send-keys C-u exited with status ${clearResult.status}`
      );

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
   * tmux に literal テキストのみ送信する (Enter を付けない)
   * AskUserQuestion の Type something モードで「1 文字ずつタイプ」したいときに使う。
   */
  sendLiteral(sessionId: string, input: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    const result = spawnSync(
      TMUX_BINARY_PATH,
      ["send-keys", "-t", session.tmuxSessionName, "-l", input],
      { stdio: "pipe" }
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`tmux send-keys -l exited with status ${result.status}`);
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
      { stdio: "pipe", timeout: TMUX_CMD_TIMEOUT_MS }
    );
    if (result.status === 0) {
      console.log(`[TmuxManager] Killed session: ${session.tmuxSessionName}`);
    }

    session.status = "stopped";
    this.sessions.delete(sessionId);
    this.emit("session:stopped", sessionId);
  }

  /**
   * 指定セッションの tmux 環境変数を取得する。
   *
   * `tmux show-environment -t <session>` で session env の一覧を取り、自前で
   * 変数を探す (findEnvValue 参照)。失敗要因は型で区別する:
   *   - no-session: TmuxManager が管理していない ID
   *   - tmux-failed: tmux が失敗 (セッション不在 / サーバー停止 / 起動失敗 / timeout)
   *   - not-set: tmux は成功したが変数が無い (または `-NAME` で unset)
   */
  getEnv(sessionId: string, name: string): TmuxReadResult<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return NO_SESSION;
    const result = runTmux(["show-environment", "-t", session.tmuxSessionName]);
    if (!result.ok) return result;
    const value = findEnvValue(result.stdout, name);
    return value === null ? NOT_SET : { ok: true, value };
  }

  /**
   * pane のシェルプロセスの環境変数を /proc/<pane_pid>/environ から読む。
   * Linux 限定 (/proc が無い環境では `unsupported-platform`)。
   *
   * tmux session env (`show-environment`) に変数が無くても、tmux サーバー
   * プロセスの env を継承してシェル/claude に変数が渡っているケースがある
   * (旧コードで起動されたセッションの CLAUDE_CONFIG_DIR 継承等)。
   * 「claude が実際にどの env で動いているか」の事実はプロセス environ が
   * 唯一の情報源なので、復元時のプロファイル補完フォールバックに使う。
   *
   * 失敗要因: no-session / unsupported-platform / tmux-failed (list-panes) /
   * invalid-pane-pid / proc-error (/proc 読み取り失敗) / not-set
   */
  getPaneEnv(sessionId: string, name: string): TmuxReadResult<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return NO_SESSION;
    if (process.platform !== "linux") {
      return {
        ok: false,
        failure: { kind: "unsupported-platform", platform: process.platform },
      };
    }
    const result = runTmux([
      "list-panes",
      "-t",
      session.tmuxSessionName,
      "-F",
      "#{pane_pid}",
    ]);
    if (!result.ok) return result;
    const raw = result.stdout.trim().split("\n")[0] ?? "";
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, failure: { kind: "invalid-pane-pid", raw } };
    }
    let environ: string;
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`, "utf-8");
    } catch (e) {
      return {
        ok: false,
        failure: {
          kind: "proc-error",
          code: errnoCode(e),
          message: errnoMessage(e),
        },
      };
    }
    for (const entry of environ.split("\0")) {
      if (entry.startsWith(`${name}=`)) {
        return { ok: true, value: entry.slice(name.length + 1) };
      }
    }
    return NOT_SET;
  }

  /**
   * tmuxのペーストバッファの内容を取得
   *
   * `show-buffer` はバッファが無いときも exit 1 ("no buffers") になり tmux 失敗と
   * 区別できないため、先に `list-buffers` (空でも exit 0) で有無を確認する。
   * 失敗要因: no-session / tmux-failed / no-buffer
   */
  getBuffer(sessionId: string): TmuxReadResult<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return NO_SESSION;
    const list = runTmux(["list-buffers", "-F", "#{buffer_name}"]);
    if (!list.ok) return list;
    if (list.stdout.trim() === "") {
      return { ok: false, failure: { kind: "no-buffer" } };
    }
    const shown = runTmux(["show-buffer"]);
    if (!shown.ok) return shown;
    return { ok: true, value: shown.stdout.trimEnd() };
  }

  /**
   * tmux capture-paneでターミナルの現在の表示内容を取得する
   * @param sessionId セッションID
   * @param lines 取得する行数（デフォルト: 100）
   *
   * 失敗要因: no-session / tmux-failed。空画面は失敗ではなく `value: ""`
   */
  capturePane(sessionId: string, lines = 100): TmuxReadResult<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return NO_SESSION;
    // -p: stdoutに出力、-S: 開始行（負数で過去の行）
    const result = runTmux([
      "capture-pane",
      "-t",
      session.tmuxSessionName,
      "-p",
      "-S",
      `-${lines}`,
    ]);
    if (!result.ok) return result;
    return { ok: true, value: result.stdout.trimEnd() };
  }

  /**
   * tmux capture-pane で「現在画面に表示されている範囲のみ」を取得する。
   *
   * `capturePane` は -S -N で scrollback を含むが、こちらは引数なしで visible 範囲のみ。
   * 用途: /clear 後に「現状の見え方」を取りたい場合、scrollback を含まないことが必要。
   *
   * 失敗要因: no-session / tmux-failed。空画面は失敗ではなく `value: ""`
   */
  capturePaneVisible(sessionId: string): TmuxReadResult<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return NO_SESSION;
    const result = runTmux([
      "capture-pane",
      "-t",
      session.tmuxSessionName,
      "-p",
    ]);
    if (!result.ok) return result;
    return { ok: true, value: result.stdout.trimEnd() };
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
