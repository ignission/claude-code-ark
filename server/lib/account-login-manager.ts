/**
 * Account Login Manager
 *
 * Anthropic アカウントの追加ログインフローを管理する。
 * 流れ:
 *   1. profile.configDir を作成（無ければ）
 *   2. tmux ログインセッション (`arklogin-*`) を `claude /login` 起動コマンドで作成
 *   3. ttyd を起動してブラウザから iframe で操作可能にする
 *   4. CredentialsWatcher で `.credentials.json` の更新を監視
 *   5. 認証検知 → cleanup + `completed` event
 *   6. キャンセル / タイムアウト時は cleanup + `failed` event
 *
 * 設計上の重要事項:
 *   - tmux ログインセッションは `arklogin-` プレフィックスで通常の `ark-` セッションと
 *     名前空間を分離する（autoDiscover=false により SessionOrchestrator から不可視）
 *   - tmuxManager が autoDiscover=false の場合は `this.sessions` に登録しないため、
 *     killSession(sessionId) は使えない。代わりに spawnSync("tmux", ["kill-session", ...])
 *     をセッション名で直接実行する
 *   - startLogin の途中でエラーが起きた場合は逆順でロールバック（ttyd → tmux）
 */

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AccountProfile } from "../../shared/types.js";
import { CredentialsWatcher } from "./credentials-watcher.js";
import type { TmuxManager } from "./tmux-manager.js";
import type { TtydLoginManager } from "./ttyd-login-manager.js";

/** ログイン失敗理由 */
export type LoginFailReason = "cancelled" | "timeout" | "error";

export interface AccountLoginManagerOptions {
  /** ログインタイムアウト (ms)。デフォルト: 10分 */
  timeoutMs?: number;
}

interface ActiveLogin {
  profileId: string;
  tmuxSessionName: string;
  ttydPort: number;
  watcher: CredentialsWatcher;
  timeoutHandle: NodeJS.Timeout;
  urlDetectorHandle: NodeJS.Timeout | null;
  detectedUrl: string | null;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const URL_DETECT_INTERVAL_MS = 1000;
// credentials.json 検知後にtmux killまで待つ猶予 (ms)。
// claude /login は credentials 書き込み直後に onboarding 完了マーク
// (`hasCompletedOnboarding=true` 等) を `.claude.json` に書く。これらを
// 書き終わる前に kill すると次回起動で theme picker が再表示される。
const COMPLETION_GRACE_MS = 5000;
// OAuth URL の起点（`claude /login` が出す URL のホスト部）。
// 実機 (Claude CLI 2.1.x) では `claude.com/cai/oauth/...` を出す。
// 過去/将来バージョン互換のため、claude.* と anthropic.com の主要サブドメインを許容する。
const OAUTH_URL_START =
  /https?:\/\/(?:[a-z0-9-]+\.)?(?:claude\.(?:ai|com)|anthropic\.com)\//;
// URL文字の判定（RFC3986 unreserved + reserved の主要部分）
const URL_CHAR = /[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]/;
// ANSIエスケープシーケンス除去用 (CSI / OSC / charset switch)
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSIエスケープシーケンス除去のため
const ANSI_CSI = /\x1b\[[?#]?[0-9;]*[a-zA-Z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC終端は BEL または ESC\
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: charset切替シーケンス
const ANSI_CHARSET = /\x1b[()][AB012]/g;

/**
 * tmux capture-pane の生出力から OAuth URL を抽出する。
 *
 * ttyd ターミナル幅で URL が物理改行されてもロバストに復元する:
 *  - ANSIエスケープを除去
 *  - URL の起点 (claude.ai/oauth/... 等) を探す
 *  - URL文字を貪欲に収集。空白/改行は「次の非空白がURL文字なら折り返し」と判定して連結
 *  - 段落区切り (空行 or スペース2文字以上) は URL の終端と判定して停止
 *  - 末尾は redirect_uri= を含むことを必須にしてサニティ確認
 *    （長い URL の前半だけ取れて OAuth サーバから怒られる事故を防ぐ）
 *
 * 注: xterm.js の WebLinksAddon は視覚行ベースで URL 検出するため、
 * ttyd 内クリックでは折り返し済URLの先頭部分しか開けない。サーバ側で
 * 抽出して URL バナーから直接ブラウザを開かせるのが本機構の役割。
 */
export function extractOAuthUrl(rawCapture: string): string | null {
  const stripped = rawCapture
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_CHARSET, "")
    .replace(/\r/g, "");

  const start = stripped.match(OAUTH_URL_START);
  if (!start || start.index === undefined) return null;

  let pos = start.index;
  let url = "";
  while (pos < stripped.length) {
    const ch = stripped[pos];
    if (URL_CHAR.test(ch)) {
      url += ch;
      pos++;
      continue;
    }
    if (/\s/.test(ch)) {
      // 空白/改行: 次の非空白文字がURL文字なら「折り返し」とみなして連結
      // ただし以下の場合は段落区切りと判断して停止:
      //  - 連続する改行が2つ以上 (空行は段落の区切り)
      //  - 改行を挟まない複数空白文字 (URL内に空白は無いはず)
      let next = pos + 1;
      let newlineCount = ch === "\n" ? 1 : 0;
      let nonNewlineWs = ch !== "\n" ? 1 : 0;
      while (next < stripped.length && /\s/.test(stripped[next])) {
        if (stripped[next] === "\n") newlineCount++;
        else nonNewlineWs++;
        next++;
      }
      if (newlineCount >= 2 || nonNewlineWs >= 2) break;
      if (next < stripped.length && URL_CHAR.test(stripped[next])) {
        pos = next;
        continue;
      }
      break;
    }
    break;
  }

  // 必須クエリパラメータ (redirect_uri) を含むこと
  // → 取りこぼしで OAuth サーバが「無効なOAuth要求」と返す事故を防ぐ
  if (!url.includes("redirect_uri=")) return null;
  return url;
}

export class AccountLoginManager extends EventEmitter {
  private readonly active = new Map<string, ActiveLogin>();
  private readonly timeoutMs: number;

  constructor(
    private readonly tmuxManager: TmuxManager,
    private readonly ttydLoginManager: TtydLoginManager,
    options: AccountLoginManagerOptions = {}
  ) {
    super();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * インタラクティブなログインフローを開始する。
   * 同一 profileId で既にアクティブなログインが存在する場合は throw する。
   */
  async startLogin(profile: AccountProfile): Promise<{ ttydUrl: string }> {
    if (this.active.has(profile.id)) {
      throw new Error("Login already in progress");
    }

    // configDir が存在しないと tmux の cwd 指定で失敗するため事前作成
    await fs.mkdir(profile.configDir, { recursive: true });

    const credentialsPath = path.join(profile.configDir, ".credentials.json");

    // ログイン前の mtime を取得（再ログイン時の旧ファイルとの判別用）
    let preLoginMtime: number | null = null;
    try {
      const stat = await fs.stat(credentialsPath);
      preLoginMtime = stat.mtimeMs;
    } catch {
      // ENOENT 等 → 初回ログイン
      preLoginMtime = null;
    }

    // ロールバック用フラグ
    let tmuxCreated = false;
    let ttydStarted = false;
    let tmuxSessionName = "";

    try {
      // 1. tmux ログインセッション作成
      const tmuxSession = await this.tmuxManager.createSession(
        profile.configDir,
        {
          namePrefix: "arklogin-",
          autoDiscover: false,
          env: { CLAUDE_CONFIG_DIR: profile.configDir },
          commandLine: "claude /login",
        }
      );
      tmuxSessionName = tmuxSession.tmuxSessionName;
      tmuxCreated = true;

      // 2. ttyd 起動
      const ttydInstance = await this.ttydLoginManager.startTtyd(
        tmuxSessionName,
        profile.id
      );
      ttydStarted = true;

      // 3. CredentialsWatcher 起動
      const watcher = new CredentialsWatcher(credentialsPath, preLoginMtime);
      watcher.on("authenticated", () => {
        this.handleCompleted(profile.id);
      });
      watcher.start();

      // 4. タイムアウト設定
      const timeoutHandle = setTimeout(() => {
        void this.cancelLogin(profile.id, "timeout");
      }, this.timeoutMs);

      // 5. アクティブログインに登録
      this.active.set(profile.id, {
        profileId: profile.id,
        tmuxSessionName,
        ttydPort: ttydInstance.port,
        watcher,
        timeoutHandle,
        urlDetectorHandle: null,
        detectedUrl: null,
      });

      // 6. OAuth URL 検出ループ起動
      // ttyd内のターミナルは折り返し+tmuxコピーモードでクリップボード連携が
      // 効かないため、サーバ側で tmux capture-pane の出力からURLを抽出して
      // クライアントへ送信し、ボタンから直接ブラウザで開けるようにする
      this.startUrlDetector(profile.id);

      return { ttydUrl: ttydInstance.url };
    } catch (error) {
      // 逆順ロールバック: ttyd → tmux
      if (ttydStarted) {
        try {
          await this.ttydLoginManager.stopTtyd(tmuxSessionName);
        } catch {
          // クリーンアップ失敗は無視（元エラーを優先）
        }
      }
      if (tmuxCreated) {
        // autoDiscover=false のため tmuxManager.killSession は使えない。
        // tmux コマンドを直接呼んでセッション名で kill する
        spawnSync("tmux", ["kill-session", "-t", tmuxSessionName], {
          stdio: "pipe",
        });
      }
      throw error;
    }
  }

  /**
   * アクティブなログインをキャンセルする。対象が無ければ no-op。
   */
  async cancelLogin(
    profileId: string,
    reason: LoginFailReason = "cancelled"
  ): Promise<void> {
    await this.destroy(profileId, reason);
  }

  /** profileId が現在アクティブにログイン中か */
  isActive(profileId: string): boolean {
    return this.active.has(profileId);
  }

  /**
   * 全アクティブログインを停止する（graceful shutdown 用）。
   */
  async stopAll(): Promise<void> {
    const profileIds = Array.from(this.active.keys());
    for (const id of profileIds) {
      await this.cancelLogin(id, "cancelled");
    }
  }

  /**
   * 認証成功時のハンドラ。watcher の "authenticated" イベントから呼ばれる。
   *
   * 重要: credentials.json 書き込み直後に claude /login を kill すると、
   * onboarding 完了フラグ (`.claude.json` の `hasCompletedOnboarding`) や
   * theme 設定が書かれず、次回起動で theme picker が再表示される。
   * 後続書き込みのため数秒の grace period を取ってから destroy する。
   */
  private handleCompleted(profileId: string): void {
    const record = this.active.get(profileId);
    if (!record) return;
    setTimeout(() => {
      void this.destroy(profileId, "completed");
    }, COMPLETION_GRACE_MS);
  }

  /**
   * URL 検出ループを起動する。
   * tmux capture-pane で画面内容を取得し、改行やANSIで分断されたURLを
   * 復元してから OAuth URL パターンに一致する最初のURLを emit する。
   * 検出後はループを停止（再表示時にも対応するため `detectedUrl` を保持）。
   */
  private startUrlDetector(profileId: string): void {
    const record = this.active.get(profileId);
    if (!record) return;

    const tick = () => {
      const cur = this.active.get(profileId);
      if (!cur) return;
      try {
        // 履歴も含めて取得 (-S - で先頭から、-E - で末尾まで)。
        // -J で wrap 連結を試みつつ、対応しきれない折り返しは extractOAuthUrl で復元
        const r = spawnSync(
          "tmux",
          [
            "capture-pane",
            "-p",
            "-J",
            "-S",
            "-",
            "-E",
            "-",
            "-t",
            cur.tmuxSessionName,
          ],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        if (r.status !== 0) return;
        const url = extractOAuthUrl(r.stdout || "");
        if (url) {
          if (cur.detectedUrl !== url) {
            cur.detectedUrl = url;
            this.emit("url-detected", profileId, url);
            // 検出済みなのでループを止めて負荷を下げる
            if (cur.urlDetectorHandle) {
              clearInterval(cur.urlDetectorHandle);
              cur.urlDetectorHandle = null;
            }
          }
        }
      } catch {
        // capture-pane が失敗（セッション破棄直後など）→ 次回ティックに委ねる
      }
    };

    record.urlDetectorHandle = setInterval(tick, URL_DETECT_INTERVAL_MS);
    // 1回だけ即座に実行
    tick();
  }

  /**
   * リソース解放 + イベント emit を一元化する内部メソッド。
   */
  private async destroy(
    profileId: string,
    reason: LoginFailReason | "completed"
  ): Promise<void> {
    const record = this.active.get(profileId);
    if (!record) return;

    // 先にマップから外して二重解放を防ぐ
    this.active.delete(profileId);

    // watcher 停止
    try {
      record.watcher.stop();
    } catch {
      // ignore
    }

    // タイムアウト解除
    clearTimeout(record.timeoutHandle);

    // URL検出ループ停止
    if (record.urlDetectorHandle) {
      clearInterval(record.urlDetectorHandle);
    }

    // ttyd 停止
    try {
      await this.ttydLoginManager.stopTtyd(record.tmuxSessionName);
    } catch {
      // ignore（既に停止済み等）
    }

    // tmux セッション終了（autoDiscover=false のため名前指定で直接 kill）
    spawnSync("tmux", ["kill-session", "-t", record.tmuxSessionName], {
      stdio: "pipe",
    });

    // イベント emit
    if (reason === "completed") {
      this.emit("completed", profileId);
    } else {
      this.emit("failed", profileId, reason);
    }
  }
}
