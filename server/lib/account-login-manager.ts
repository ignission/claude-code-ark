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
// `claude /login` が表示する OAuth URL を検出する正規表現
// 例: https://claude.ai/oauth/authorize?... / https://console.anthropic.com/oauth/...
const OAUTH_URL_PATTERN =
  /https?:\/\/(?:claude\.ai|console\.anthropic\.com)\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/;
// ANSIエスケープシーケンス除去用
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSIエスケープシーケンス除去のため
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

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
   */
  private handleCompleted(profileId: string): void {
    const record = this.active.get(profileId);
    if (!record) return;
    void this.destroy(profileId, "completed");
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
        const r = spawnSync(
          "tmux",
          ["capture-pane", "-p", "-J", "-t", cur.tmuxSessionName],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        if (r.status !== 0) return;
        // ANSIエスケープを除去（色やカーソル制御）
        const cleaned = (r.stdout || "")
          .replace(ANSI_ESCAPE_PATTERN, "")
          // ターミナル幅で改行されたURL断片を結合（claude /login は URL を1行で書くが、
          // ttyd の幅で物理改行される。-J オプションで連結を試みるが、改行コードは残るので除去）
          .replace(/\r/g, "")
          // 改行+空白のパターンは折り返しと判断して連結
          .replace(/\n\s*/g, "");
        const m = cleaned.match(OAUTH_URL_PATTERN);
        if (m) {
          const url = m[0];
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
