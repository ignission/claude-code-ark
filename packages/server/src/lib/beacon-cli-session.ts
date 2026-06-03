/**
 * Beacon CLI Session (tmux 対話版 claude + JSONL transcript tail)
 *
 * Beacon を `claude -p`（ヘッドレス）ではなく **tmux で対話版 claude を常駐起動**して
 * 駆動する。2026/6/15 以降 `claude -p` / Agent SDK はプラン枠ではなく別枠の
 * Agent SDK クレジット課金になるため、プラン枠で動く対話版 claude を使う。
 *
 * 応答内容は ttyd の生ターミナルではなく `~/.claude/projects/<cwd>/<session>.jsonl`
 * （対話版 claude が書き出す構造化 transcript）を tail して取得する。脆い ANSI TUI
 * パースは使わない。ターン完了は capture-pane の「`esc to interrupt` 消失 +
 * `for shortcuts` 表示」で検出する（JSONL の stop_reason は対話版では常に end_turn で
 * 信頼できないため。実機検証済み）。
 */

import { spawnSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getErrorMessage } from "./errors.js";
import { resolveTmuxPath } from "./system.js";
import { resolveValidatedClaudePath } from "./tmux-manager.js";

/** Beacon 専用 tmux セッション名 (singleton)。discoverExistingSessions で除外される */
export const BEACON_TMUX_SESSION = "ark-beacon";

/** capture-pane の取得行数 (ready/busy 判定に十分な可視範囲) */
const CAPTURE_LINES = 60;

/**
 * launch コマンドを書き出すスクリプトファイル名 (beacon-launch ディレクトリ内)。
 *
 * シェル init 中の端末は canonical モードのため、MAX_CANON (≈1KB) を超える未読入力は
 * 破棄される。長い launch コマンド (多数の --add-dir) を send-keys でそのまま送ると
 * init 中に切断され、claude が起動せず readiness タイムアウトに陥る。これを避けるため、
 * 長いコマンドはファイルに書き出し、tmux には短い `source <file>` のみを送る。
 * `source` 行は MAX_CANON 未満なので、シェルが zle (RAW モード) に入る前の canonical
 * 状態で届いても切断されない (p10k の precmd フックや mise の init 出力にも依存しない)。
 */
const LAUNCH_SCRIPT_NAME = "beacon-launch.sh";

/**
 * 再接続時、busy な claude (前ターン処理中) が ready になるのを待つ絶対上限。
 * 1 ターンの最大 (約 10 分) より少し長くして、再起動直後の長いターン完了を待てるようにする。
 */
const BUSY_RESUME_MAX_MS = 11 * 60 * 1000;

/**
 * 入力プロンプト記号 (❯) が表示されているか。
 *
 * footer の hint ("? for shortcuts" / "← for agents" 等) は数秒ごとに rotate し、
 * 起動直後の Welcome / "What's new" スプラッシュ表示中やカスタム statusline 環境では
 * "for shortcuts" が出ないことがある (実機検証で確認)。そのため hint 文字列ではなく
 * 入力プロンプト記号の有無を readiness の主シグナルにする。
 */
function hasInputPrompt(pane: string): boolean {
  return pane.includes("❯");
}

/**
 * claude 起動完了 (入力プロンプト表示) のアンカー。
 * 入力プロンプト記号 (❯) または footer hint のいずれかで検出する
 * (hint は rotate / スプラッシュで消えるため記号を主、hint を従とする)。
 * busy / onboarding 判定は呼び出し側で別途行う。
 */
export function isReady(pane: string): boolean {
  return hasInputPrompt(pane) || pane.includes("for shortcuts");
}

/**
 * claude が処理中かの判定。`esc to interrupt` は処理中のみ表示される。
 * 注意: `✻`/スピナーや `Worked for Ns` は **完了後の要約**でも出るため busy 判定に使わない
 * (実機検証で確認)。
 */
function isBusy(pane: string): boolean {
  return /esc to interrupt/i.test(pane);
}

/** Trust folder ダイアログ (初回起動時) */
function isTrustDialog(pane: string): boolean {
  return /trust this folder|Quick safety check/i.test(pane);
}

/** 未認証 (オンボーディング) 画面 */
function isOnboarding(pane: string): boolean {
  return /Welcome to Claude Code|\/login|Sign in|Choose the text style/i.test(
    pane
  );
}

/** POSIX single-quote で安全に wrap する (shell インジェクション防止) */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** cwd を Claude Code の project ディレクトリ名へエンコードする (非英数 → '-') */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 対話版 claude の起動に渡す構成 (mcp-config / system prompt file / 許可ツール / 追加 dir) */
export interface BeaconCliLaunchConfig {
  mcpConfigPath: string;
  systemPromptFile: string;
  allowedTools: string[];
  addDirs: string[];
  /**
   * Beacon 専用プロファイルの CLAUDE_CONFIG_DIR (Linux のプロファイル切替機能)。
   * 指定時はこの値を export して起動し、その認証情報で動作する。
   * 未指定 (null/undefined) なら CLAUDE_CONFIG_DIR を unset して既定プロファイルで起動する。
   */
  configDir?: string | null;
}

/** 1 ターン中のライブ通知 */
export interface BeaconTurnHandlers {
  /** assistant の text ブロックが現れるたびに呼ばれる (逐次描画用) */
  onText: (chunk: string) => void;
  /** tool_use 検出時 */
  onToolUse?: (toolUse: { toolName: string; input: string }) => void;
}

export interface BeaconTurnResult {
  /** 確定 assistant テキスト (thinking を除く text ブロックの連結) */
  text: string;
  /** 最後の tool_use (あれば) */
  toolUse?: { toolName: string; input: string };
  /** ターン完了を検出できたか (false = タイムアウト等) */
  completed: boolean;
}

/** JSONL 1 行 (必要フィールドのみ) */
interface TranscriptLine {
  type?: string;
  cwd?: string;
  message?: { content?: unknown[] };
}

/**
 * ark-beacon tmux セッション (対話版 claude) のライフサイクルと JSONL tail を担う。
 * BeaconManager が 1 インスタンス保持する。
 */
export class BeaconCliSession {
  private readonly cwd: string;
  /** 現セッションの JSONL transcript パス (起動後に特定) */
  private jsonlPath: string | null = null;
  /** 既に処理済みの JSONL 行数 (次ターンはこれ以降を読む) */
  private processedLines = 0;
  /**
   * 直近の new-session launch 時刻 (epoch ms)。fresh launch では、この時刻以降に
   * 作成/更新された jsonl のみを現セッションの transcript として採用する
   * (reset 後に残る古い transcript を誤検出しないため)。
   */
  private launchedAtMs = 0;
  /**
   * 直近の start() が new-session を作成した (= 真の新規起動) か。
   * true: 新 jsonl は launch 後に出来るので recoverPending は pin しない。
   * false: 既存セッションへの再接続 (resume / attach) なので、保存オフセットが無くても
   *   既存 transcript を EOF baseline する (過去会話全体の誤再生を防ぐ)。
   */
  private wasFreshLaunch = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** ark-beacon tmux セッションが存在するか */
  isRunning(): boolean {
    const tmux = resolveTmuxPath() ?? "tmux";
    const r = spawnSync(tmux, ["has-session", "-t", BEACON_TMUX_SESSION], {
      stdio: "pipe",
    });
    return r.status === 0;
  }

  private capture(): string {
    const tmux = resolveTmuxPath() ?? "tmux";
    const r = spawnSync(
      tmux,
      [
        "capture-pane",
        "-t",
        BEACON_TMUX_SESSION,
        "-p",
        "-S",
        `-${CAPTURE_LINES}`,
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return r.stdout ?? "";
  }

  private tmuxExec(args: string[]): void {
    const tmux = resolveTmuxPath() ?? "tmux";
    const r = spawnSync(tmux, args, { stdio: "pipe" });
    // spawn 自体の失敗 (tmux バイナリ不在 / 実行不可) は全コマンドで致命的なので投げる
    // (TmuxManager と同じ扱い)。
    if (r.error) {
      throw new Error(
        `tmux ${args[0]} の実行に失敗しました: ${r.error.message}`
      );
    }
    // kill-session は対象不在時に非 0 を返すが「冪等な破棄」なので許容する。
    // それ以外 (new-session / send-keys / load-buffer / paste-buffer) の非 0 は
    // 起動・送信の失敗であり、握りつぶすと「起動待ちタイムアウト」や「kill 済み扱いの
    // ローカル状態」へ化けて根本原因が見えなくなる。stderr を含めて即例外化する。
    if (r.status !== 0 && args[0] !== "kill-session") {
      const stderr = (r.stderr?.toString() ?? "").trim();
      throw new Error(
        `tmux ${args[0]} が異常終了しました (status=${r.status})${
          stderr ? `: ${stderr}` : ""
        }`
      );
    }
  }

  /**
   * ユーザーメッセージを claude の入力欄へ送る (Enter は呼び出し側が別途送る)。
   * 単一行: send-keys -l でリテラル送信。
   * 複数行: tmux buffer に積んで paste-buffer -p (bracketed paste) で 1 入力として送る。
   *   埋め込み \n が各行の Enter (確定) として解釈され turn がばらけるのを防ぐ。
   *   TUI が bracketed paste 非対応でも最悪 send-keys -l 相当に劣化するだけで安全。
   */
  private sendMessageInput(raw: string): void {
    // 端末制御バイト (ESC / C-c / BS / DEL 等) を除去する。対話版 TUI に生で流すと
    // チャット文字ではなく端末操作として解釈され、ターン中断 / ショートカット誤爆 /
    // セッション破壊を招く (旧 -p の stdin 経路には無かった境界)。\n (改行=複数行) と
    // \t (タブ。コード貼り付けで一般的) のみ許可する。
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 端末注入防止のため制御文字を明示除去
    const message = raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
    if (!message.includes("\n")) {
      this.tmuxExec(["send-keys", "-t", BEACON_TMUX_SESSION, "-l", message]);
      return;
    }
    const tmux = resolveTmuxPath() ?? "tmux";
    const bufName = "ark-beacon-input";
    // メッセージ本文は **stdin** で渡す (load-buffer -)。argv で渡すと巨大な貼り付け
    // (長いログ / コード) が OS の argv 上限を超えて失敗するため。
    const r = spawnSync(tmux, ["load-buffer", "-b", bufName, "-"], {
      input: message,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // load-buffer が失敗したら paste-buffer に進まず即エラーにする。進むと空/古い
    // バッファを貼り付けて「ユーザ入力と違う turn を黙って送る」ことになるため。
    if (r.error || r.status !== 0) {
      throw new Error(
        `tmux load-buffer に失敗しました (複数行メッセージ送信): ${r.error?.message ?? `status ${r.status}`}`
      );
    }
    // -p: bracketed paste, -d: 貼り付け後に buffer を削除
    this.tmuxExec([
      "paste-buffer",
      "-t",
      BEACON_TMUX_SESSION,
      "-b",
      bufName,
      "-d",
      "-p",
    ]);
  }

  /** ark-beacon セッションを kill して JSONL 追跡をリセットする */
  kill(): void {
    this.tmuxExec(["kill-session", "-t", BEACON_TMUX_SESSION]);
    this.jsonlPath = null;
    this.processedLines = 0;
  }

  /**
   * launch コマンドを beacon-launch ディレクトリ (mcpConfigPath と同階層) のスクリプトに
   * 書き出し、その絶対パスを返す。tmux には長い launch ではなく短い `source <path>` を
   * 送ることで、シェル init 中 (canonical モード) の MAX_CANON 行長上限による切断を避ける
   * (LAUNCH_SCRIPT_NAME 参照)。
   *
   * symlink 追従による任意ファイル上書きを防ぐ: 既存エントリ (symlink 含む) を rm で
   * 除去 (リンク自体を消す。リンク先は消さない) してから、`wx` (O_CREAT|O_EXCL) で
   * 排他新規作成する。rm と作成の間に攻撃者が symlink を再配置しても O_EXCL が EEXIST で
   * 失敗するため、既存ファイルを追従して上書きすることはない。mode 0600 + 毎回上書き
   * (mcp-config.json 等と同じ扱い)。
   *
   * 固定名 (LAUNCH_SCRIPT_NAME) を使うが、Beacon は singleton (BEACON_TMUX_SESSION は
   * 単一の固定セッション。BeaconManager が直列に起動する) なので、同一ディレクトリで
   * 並行 start() が競合することはない。この前提が崩れた場合はセッション単位の一意名が必要。
   *
   * rm→wx は「書き込み時の上書き」を防ぐが、source は path で後から参照するため、書き込み〜
   * 実行の間にファイルを差し替えられる TOCTOU が残る。これを塞ぐため、書き込み先ディレクトリが
   * **owner 専用 (group/other に権限ビット無し) かつ自分の所有**であることを assert する。
   * 第三者が書き込めないディレクトリなら差し替え経路自体が存在しない。
   */
  private writeLaunchScript(launch: string, mcpConfigPath: string): string {
    const dir = dirname(mcpConfigPath);
    this.assertPrivateDir(dir);
    const scriptPath = join(dir, LAUNCH_SCRIPT_NAME);
    try {
      rmSync(scriptPath, { force: true });
      writeFileSync(scriptPath, `${launch}\n`, { mode: 0o600, flag: "wx" });
    } catch (e) {
      // 権限 / 既存ファイル衝突 (symlink 再配置等) の切り分けができるよう path を含めて包む。
      throw new Error(
        `Beacon launch script の書き込みに失敗しました (${scriptPath}): ${getErrorMessage(e)}`
      );
    }
    return scriptPath;
  }

  /**
   * ディレクトリが owner 専用 (group/other に権限ビット無し) かつ現ユーザーの所有で
   * あることを検証する。第三者書き込みによる launch script 差し替え (TOCTOU) を防ぐ前提。
   */
  private assertPrivateDir(dir: string): void {
    const st = statSync(dir);
    const uid = process.getuid?.();
    if ((st.mode & 0o077) !== 0) {
      throw new Error(
        `Beacon launch ディレクトリが owner 専用ではありません (group/other 権限あり): ${dir}`
      );
    }
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(
        `Beacon launch ディレクトリが現ユーザーの所有ではありません: ${dir}`
      );
    }
  }

  /**
   * 対話版 claude を tmux で起動する (既存セッションがあれば --continue で文脈を引き継ぐ)。
   * 起動完了 (プロンプト表示) まで待ち、未認証なら例外を投げる。
   */
  async start(
    cfg: BeaconCliLaunchConfig,
    readyTimeoutMs: number,
    isAborted?: () => boolean
  ): Promise<void> {
    // tmux-manager と同じ検証付き resolver を使う (相対パス / 制御文字を fail-fast 拒否)。
    const claudeBin = resolveValidatedClaudePath();
    // この時刻以降に作られた jsonl のみを現セッションの transcript とみなす
    // (fresh launch 時に reset 前の古い transcript を誤検出しないため)。
    this.launchedAtMs = Date.now();
    let resuming = this.isRunning();
    // tmux セッションは在るが claude が crash/exit して shell に戻っている (stale) 場合、
    // resuming のまま launch を送らないと readiness ループが無限 timeout する。pane に
    // claude の UI (ready/busy/trust/onboarding) が一切無ければ stale と判断し、破棄して
    // 作り直す (claude は既に文脈を失っているため新規起動で問題ない)。
    if (resuming) {
      const pane = this.capture();
      const claudeAlive =
        isReady(pane) ||
        isBusy(pane) ||
        isTrustDialog(pane) ||
        isOnboarding(pane);
      if (!claudeAlive) {
        this.kill();
        resuming = false;
      }
    }
    // 新規 new-session を作るか (= 真の新規起動)。recoverPending の baseline 判定に使う。
    this.wasFreshLaunch = !resuming;
    if (!resuming) {
      // detached セッション作成。CLAUDECODE= で nested 検出回避、NODE_ENV= で
      // production 継承防止 (tmux-manager と同パターン)。
      this.tmuxExec([
        "new-session",
        "-d",
        "-s",
        BEACON_TMUX_SESSION,
        "-c",
        this.cwd,
        "-e",
        "CLAUDECODE=",
        "-e",
        "NODE_ENV=",
        "-e",
        "CLAUDE_CODE_NO_FLICKER=1",
      ]);

      const flags = [
        "--mcp-config",
        shellQuote(cfg.mcpConfigPath),
        "--strict-mcp-config",
        "--permission-mode",
        "default",
        // 組込ツールを Read/Grep/Glob に限定 (Bash/Write/Edit/Task/Skill 排除)
        "--tools",
        "Read",
        "Grep",
        "Glob",
        "--disable-slash-commands",
        // 巨大な system prompt は file で渡す (send-keys のコマンド長/エスケープ回避)
        "--append-system-prompt-file",
        shellQuote(cfg.systemPromptFile),
      ];
      for (const dir of cfg.addDirs) {
        flags.push("--add-dir", shellQuote(dir));
      }
      // 対話版なので -p / stream-json 系は付けない (= プラン枠課金)。
      // --allowedTools は最後 (variadic) に置く。
      flags.push("--allowedTools", ...cfg.allowedTools.map(shellQuote));

      // プロファイル指定があればその CLAUDE_CONFIG_DIR を export、無ければ unset して
      // 既定プロファイルで起動する (Linux のプロファイル切替機能。C-1: 起動時に固定)。
      const configDirPrefix = cfg.configDir
        ? `export CLAUDE_CONFIG_DIR=${shellQuote(cfg.configDir)}; `
        : "unset CLAUDE_CONFIG_DIR; ";
      const launch = `${configDirPrefix}${shellQuote(claudeBin)} ${flags.join(" ")}`;
      // 長い launch はファイルに書き、tmux には短い `source <path>` のみ送る。
      // シェル init 中 (canonical モード) の MAX_CANON 切断を回避する (LAUNCH_SCRIPT_NAME 参照)。
      const scriptPath = this.writeLaunchScript(launch, cfg.mcpConfigPath);
      this.tmuxExec([
        "send-keys",
        "-t",
        BEACON_TMUX_SESSION,
        `source ${shellQuote(scriptPath)}`,
        "Enter",
      ]);
    }

    // 起動完了待ち (trust ダイアログは自動承認、未認証は例外)。
    // 既存セッションへの再接続で claude が **busy** (前ターンを処理中) の場合、readyTimeoutMs
    // (= 起動用 60s) では足りない (ターンは最大 10 分動く)。busy を観測している間は
    // 「claude は生きて処理中」なので deadline を延長し、ターン完了 (= ready) を待つ。
    // 絶対上限 (BUSY_RESUME_MAX_MS) で無限待機は防ぐ。busy でもなく ready でもない
    // 状態 (起動失敗 / 真の hang) は readyTimeoutMs で fail-fast する。
    const absoluteDeadline = Date.now() + BUSY_RESUME_MAX_MS;
    let deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    while (Date.now() < deadline && Date.now() < absoluteDeadline) {
      // reset/clear で中断要求があれば起動待ちを即打ち切る (呼び出し側が discard する)。
      // ready=false のまま戻るが、呼び出し側 (ensureCliStarted) が isAborted を再確認して
      // throw せず静かに終えるため、ここでは return で抜ける。
      if (isAborted?.()) return;
      const pane = this.capture();
      // busy / trust / onboarding を ready 判定より先に評価する。
      // isReady は入力プロンプト記号 (❯) でも成立するため、これらの画面が ❯ を
      // 含んでいても誤って ready と判定しないよう順序で保証する。
      if (isBusy(pane)) {
        // 処理中。次の 60s window へ deadline を延長して完了を待つ (絶対上限内)。
        deadline = Date.now() + readyTimeoutMs;
      } else if (isTrustDialog(pane)) {
        this.tmuxExec(["send-keys", "-t", BEACON_TMUX_SESSION, "1", "Enter"]);
      } else if (isOnboarding(pane)) {
        throw new Error(
          "Beacon 用 claude が未認証です。tmux セッション ark-beacon で `claude /login` を実行してください"
        );
      } else if (isReady(pane)) {
        ready = true;
        break;
      }
      await sleep(800);
    }

    // 準備プロンプト未検出のまま deadline に達した場合は throw する。
    // 黙って続行すると、未準備の pane に send-keys して user message が失われたり、
    // 起動失敗が beacon:error に現れず loading のまま hang する。
    if (!ready) {
      throw new Error(
        "Beacon 用 claude が起動完了しませんでした (準備プロンプト未検出 / タイムアウト)"
      );
    }

    // 注: JSONL transcript の特定 / baseline / 取りこぼし回収は呼び出し側 (BeaconManager)
    // が recoverPending() で行う。start() でここを EOF baseline すると、サーバー停止中に
    // claude が裏で完走した応答 (resume パス) を回収する前に捨ててしまうため行わない。
  }

  /**
   * tmux セッションが**生存かつ入力プロンプト準備完了**なら true を返し、そのまま
   * 再接続できることを示す。サーバー再起動後など start() を経ずに既存の常駐 claude
   * へ再接続する用途。JSONL の baseline / 取りこぼし回収は recoverPending() が行う
   * (このメソッドは状態を変えない)。
   *
   * 準備未完了 (login/onboarding 画面のまま / 起動途中で wedge / 前ターン残留 busy)
   * の場合は false を返す。呼び出し側はこの後 start() を呼び、resuming パスの
   * readiness 検証で復旧待ち or onboarding/timeout を surface させる
   * (未準備の pane に send-keys してメッセージを失わないため)。
   */
  attachIfRunning(): boolean {
    if (!this.isRunning()) return false;
    const pane = this.capture();
    // isReady は ❯ でも成立するため、onboarding/trust 画面を ready と誤認しないよう除外する。
    if (isOnboarding(pane) || isTrustDialog(pane)) return false;
    if (!isReady(pane) || isBusy(pane)) return false;
    return true;
  }

  /** JSONL transcript を既に特定済みか (false = この process でまだ未 attach) */
  hasTranscript(): boolean {
    return this.jsonlPath !== null;
  }

  /**
   * 直近の start() が **新規 new-session を作成した** (= 起動時 env / configDir を
   * 適用した) か。resume / attach 時は false。launchedConfigDir の永続判定に使う。
   */
  didFreshLaunch(): boolean {
    return this.wasFreshLaunch;
  }

  /** 現在の JSONL パスと処理済み行数。永続化して再起動跨ぎの取りこぼし回収に使う。 */
  getTranscriptOffset(): { path: string | null; lines: number } {
    return { path: this.jsonlPath, lines: this.processedLines };
  }

  /**
   * 再接続時の取りこぼし回収 (サーバー再起動後の初回 attach 用)。
   * 永続化済みオフセット saved が現在の JSONL と一致するなら、saved.lines から現在
   * までの未処理 assistant をまとめて返し processedLines を現在へ進める。これにより
   * サーバー停止中に claude が裏で完走した応答を DB へ取り込める (UI=claude 文脈の維持)。
   * 別会話 (path 不一致) / 未起動 / jsonl 無しなら baseline のみ行い null を返す
   * (過去会話全体を誤って再記録しない)。
   */
  recoverPending(
    saved: { path: string | null; lines: number } | null,
    handlers: BeaconTurnHandlers
  ): BeaconTurnResult | null {
    if (!this.isRunning()) return null;
    // 真の新規起動 (reset / clear / markMcpConfigStale / degraded・port 貼り直し 等) では
    // 保存オフセットは前会話のものなので **必ず無視** する。古い jsonl が残っていても
    // 再利用すると stale な応答を再生 / 新会話の transcript を取り逃すため、ここで先に弾く。
    // 新 jsonl は launch 後に作られる → pin せず、最初の sendTurn が launchedAtMs 以降の
    // ファイルを特定する。
    if (this.wasFreshLaunch) {
      this.jsonlPath = null;
      this.processedLines = 0;
      return null;
    }
    // resume / attach: 保存パスが実在して読めるならそれを**直接**使う。locateJsonl の
    // 「最新 *.jsonl」ヒューリスティックに任せると、別ファイルが mtime で勝って誤検出する
    // ことがあるため、保存パスを優先する。
    if (saved?.path) {
      const lines = this.readLines(saved.path);
      if (lines) {
        this.jsonlPath = saved.path;
        const total = lines.length;
        if (saved.lines <= total) {
          this.processedLines = saved.lines;
          const r = this.drainNewLines(handlers);
          return r.text || r.toolUse
            ? { text: r.text, toolUse: r.toolUse, completed: true }
            : null;
        }
        this.processedLines = total; // saved が EOF を超える異常時は baseline
        return null;
      }
      // saved.path が消えている (削除済み) → 下のフォールバックへ
    }
    // 既存セッションへの再接続 (resume / attach) で保存オフセットが無い/古い:
    // 既存 transcript を EOF baseline する。pin しないと次の sendTurn が過去会話全体を
    // 新規行として誤再生してしまう (rollout 直後 / settings 消失時など)。
    this.locateJsonl(false);
    if (this.jsonlPath) {
      const lines = this.readLines(this.jsonlPath);
      this.processedLines = lines ? lines.length : 0;
    } else {
      this.processedLines = 0;
    }
    return null;
  }

  /**
   * 現セッションの *.jsonl を特定する。
   * @param freshOnly true (真の新規起動時): launch 後 (launchedAtMs 以降) に作成/更新
   *   されたファイルのみ採用し、reset 後に残る古い transcript を誤検出しない。新ファイル
   *   未作成なら null のまま (drainNewLines が次ポーリングで再試行)。
   *   false (resume / attach の baseline 時): mtime で絞らず既存の最新 transcript を採用する。
   */
  private locateJsonl(freshOnly: boolean): void {
    const projDir = join(
      homedir(),
      ".claude",
      "projects",
      encodeProjectDir(this.cwd)
    );
    try {
      const candidates = readdirSync(projDir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => join(projDir, f))
        .filter(f => {
          if (!freshOnly) return true;
          try {
            return statSync(f).mtimeMs >= this.launchedAtMs;
          } catch {
            return false;
          }
        })
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      // cwd 一致する最新ファイルを採用 (encode 衝突の保険)
      for (const f of candidates) {
        const lines = this.readLines(f);
        const first = lines?.find(l => l.cwd);
        if (!first || first.cwd === this.cwd) {
          this.jsonlPath = f;
          return;
        }
      }
      // 該当なし: freshOnly で新ファイル未作成なら null (次回 retry)、それ以外は newest
      this.jsonlPath = candidates[0] ?? null;
    } catch {
      this.jsonlPath = null;
    }
  }

  /** 任意パスを全読み + 全パースする (recoverPending / locateJsonl 等の低頻度呼び出し用)。 */
  private readLines(path: string): TranscriptLine[] {
    try {
      return readFileSync(path, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map(l => {
          try {
            return JSON.parse(l) as TranscriptLine;
          } catch {
            return null;
          }
        })
        .filter((o): o is TranscriptLine => o !== null);
    } catch {
      return null as unknown as TranscriptLine[];
    }
  }

  // --- hot path 用の size-guard + 増分パースキャッシュ ---
  // drainNewLines は 500ms 毎に呼ばれる。毎回 transcript 全体を read+JSON.parse すると
  // 会話が伸びるほど O(履歴) になり event loop をブロックする。size 不変なら read を skip し、
  // 伸びた時だけ新規行を増分パースする (パース済み行は再利用)。
  private cachedPath: string | null = null;
  private cachedSize = -1;
  /** これまでに split で処理した raw 行数 (パース失敗行も含む = 増分インデックス基準) */
  private cachedRawCount = 0;
  private parsedCache: TranscriptLine[] = [];

  /** this.jsonlPath の transcript をキャッシュ付きで読む (パース済み行配列を返す)。 */
  private readTranscriptCached(): TranscriptLine[] {
    const path = this.jsonlPath;
    if (!path) return [];
    if (path !== this.cachedPath) {
      // tail 対象が変わった → キャッシュをリセット
      this.cachedPath = path;
      this.cachedSize = -1;
      this.cachedRawCount = 0;
      this.parsedCache = [];
    }
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return this.parsedCache;
    }
    if (size === this.cachedSize) return this.parsedCache; // 変化なし → read しない
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return this.parsedCache;
    }
    // **完全な行のみ** を確定として扱う。trailing newline が無い末尾要素は claude が
    // 書き込み途中 (不完全な JSON) なので確定しない。これを消費 (cachedRawCount 前進)
    // すると、次ポーリングで行が完成しても allRaw 上の位置が変わらず再パースされず、
    // assistant 応答を恒久的に取り逃す。完成 (= 改行が付与) されるまで保留する。
    const parts = raw.split("\n");
    const complete = (raw.endsWith("\n") ? parts : parts.slice(0, -1)).filter(
      Boolean
    );
    if (complete.length < this.cachedRawCount) {
      // 切り詰め / 書き換え → 全再パース
      this.cachedRawCount = 0;
      this.parsedCache = [];
    }
    for (let i = this.cachedRawCount; i < complete.length; i++) {
      try {
        this.parsedCache.push(JSON.parse(complete[i]) as TranscriptLine);
      } catch {
        // 完全な行 (改行付き) なのに parse 失敗 = 真の malformed。スキップして前進する。
      }
    }
    this.cachedRawCount = complete.length;
    this.cachedSize = size;
    return this.parsedCache;
  }

  /** processedLines 以降の新規行から assistant の text/tool_use を抽出する */
  private drainNewLines(handlers: BeaconTurnHandlers): {
    text: string;
    toolUse?: { toolName: string; input: string };
  } {
    let appended = {
      text: "",
      toolUse: undefined as { toolName: string; input: string } | undefined,
    };
    if (!this.jsonlPath) {
      // jsonlPath が null なのは fresh launch 後 (recoverPending が pin しなかった)。
      // launch 後に作られた新 jsonl のみ採用する。
      this.locateJsonl(this.wasFreshLaunch);
      if (!this.jsonlPath) return appended;
      // 初回特定時、既存行は前ターン分なので processedLines は据え置き
    }
    const lines = this.readTranscriptCached();
    if (lines.length <= this.processedLines) return appended;
    const fresh = lines.slice(this.processedLines);
    this.processedLines = lines.length;
    for (const line of fresh) {
      if (line.type !== "assistant" || !line.message?.content) continue;
      for (const block of line.message.content) {
        const b = block as {
          type?: string;
          text?: string;
          name?: string;
          input?: unknown;
        };
        if (b.type === "text" && typeof b.text === "string" && b.text) {
          appended = appendText(appended, b.text);
          handlers.onText(b.text);
        } else if (b.type === "tool_use") {
          const tu = {
            toolName: String(b.name ?? ""),
            input:
              typeof b.input === "string" ? b.input : JSON.stringify(b.input),
          };
          appended.toolUse = tu;
          handlers.onToolUse?.(tu);
        }
        // thinking 等は描画しない
      }
    }
    return appended;
  }

  /**
   * 1 ターンを実行する: メッセージ送信 → JSONL を tail しつつ pane でターン完了を待つ。
   * completed=false はタイムアウト (プロンプト hang 等) または中断。
   *
   * @param isAborted 各ポーリングで呼ばれ、true を返すと即座に completed=false で
   *   抜ける。stop-and-reset / close / セッション差し替えで進行中ターンを早期に
   *   打ち切るために使う (tmux 上の claude 自体はそのまま動き続ける場合がある)。
   */
  async sendTurn(
    message: string,
    handlers: BeaconTurnHandlers,
    turnTimeoutMs: number,
    isAborted?: () => boolean
  ): Promise<BeaconTurnResult> {
    // 送信直前の JSONL 行数を基準にする (このターンの新規行だけを処理)
    if (this.jsonlPath) {
      this.processedLines = this.readTranscriptCached().length;
    }

    // メッセージ送信 + Enter。
    // 単一行は send-keys -l でリテラル送信する (検証済み)。複数行 (貼り付けたログ /
    // コード / スタックトレース等) を send-keys -l で送ると埋め込み \n が TTY で
    // 各行の確定 (Enter) として解釈され、1 行目だけが turn になり残りが後続入力に
    // ばらける。そのため複数行は tmux buffer 経由の **bracketed paste**
    // (paste-buffer -p) で 1 入力として送る (claude TUI の貼り付けと同じ扱い)。
    this.sendMessageInput(message);
    this.tmuxExec(["send-keys", "-t", BEACON_TMUX_SESSION, "Enter"]);

    // 送信先セッションが消えていたら (ensureCliStarted と sendTurn の間に kill/crash 等)、
    // 10 分の turn timeout を待たず即座に未完了で返す (infra 失敗を model timeout と
    // 誤分類せず、UI の loading を速やかに解除させる)。
    if (!this.isRunning()) {
      return { text: "", toolUse: undefined, completed: false };
    }

    const acc = {
      text: "",
      toolUse: undefined as { toolName: string; input: string } | undefined,
    };
    const merge = (r: {
      text: string;
      toolUse?: { toolName: string; input: string };
    }) => {
      if (r.text) {
        const m = appendText(acc, r.text);
        acc.text = m.text;
      }
      if (r.toolUse) acc.toolUse = r.toolUse;
    };

    const deadline = Date.now() + turnTimeoutMs;
    let sawBusy = false;
    let readyStreak = 0;
    let completed = false;
    // 送信直後は前の ready 状態が残るので少し待ってから判定に入る
    await sleep(1500);
    while (Date.now() < deadline) {
      // 中断要求 (stop-and-reset / close / セッション差し替え) を最優先で確認する。
      // tmux セッションが kill 済みなら最終取りこぼし回収だけして抜ける。
      if (isAborted?.()) break;
      merge(this.drainNewLines(handlers));
      // ターン中に tmux/claude が落ちると capture() は空のままで busy/ready いずれも
      // 成立せず、turnTimeoutMs (最大 10 分) まで loading が張り付く。毎周回で生存を
      // 確認し、消失していれば最終取りこぼしを回収済みの状態で即未完了で抜ける。
      if (!this.isRunning()) {
        completed = false;
        break;
      }
      const pane = this.capture();
      if (isBusy(pane)) {
        sawBusy = true;
        readyStreak = 0;
      } else if (isReady(pane)) {
        readyStreak += 1;
        // busy を観測済み、または assistant 応答を取得済みなら完了とみなす
        if (readyStreak >= 2 && (sawBusy || acc.text || acc.toolUse)) {
          completed = true;
          break;
        }
      } else {
        readyStreak = 0;
      }
      await sleep(500);
    }
    // 完了検出後、transcript への最終 flush は ready プロンプト表示より遅れることがある
    // (遅いディスク / 大きな応答)。1 度の drain だと最後の assistant 行を取り逃し、次ターンが
    // EOF を baseline して恒久的に飛ばしてしまう。新規行が落ち着くまで (連続 2 回新規ゼロ)
    // 短く drain し続けて取りこぼしを防ぐ。
    if (completed) {
      const settleDeadline = Date.now() + 3000;
      let stableRounds = 0;
      while (Date.now() < settleDeadline && stableRounds < 2) {
        const before = acc.text.length + (acc.toolUse ? 1 : 0);
        merge(this.drainNewLines(handlers));
        const after = acc.text.length + (acc.toolUse ? 1 : 0);
        stableRounds = after === before ? stableRounds + 1 : 0;
        await sleep(250);
      }
    } else {
      // 中断/タイムアウト時は settle しない (turn は破棄される)。最終取りこぼしだけ回収。
      merge(this.drainNewLines(handlers));
    }

    return { text: acc.text, toolUse: acc.toolUse, completed };
  }
}

/** ターン中に蓄積する応答 (確定 text + 最後の tool_use) */
interface TurnAccumulator {
  text: string;
  toolUse: { toolName: string; input: string } | undefined;
}

/** text を改行補完しつつ連結する (tool 前後の text が直結して行頭 markdown が壊れるのを防ぐ) */
function appendText(acc: TurnAccumulator, chunk: string): TurnAccumulator {
  const base = acc.text;
  const joined =
    base && !base.endsWith("\n") && !chunk.startsWith("\n")
      ? `${base}\n${chunk}`
      : base + chunk;
  return { text: joined, toolUse: acc.toolUse };
}
