import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `.credentials.json` 監視オプション
 */
export interface CredentialsWatcherOptions {
  /** atomic write完了を確認するための安定化待機時間 (ms) */
  stabilizationMs?: number;
  /** ポーリング間隔 (ms) */
  pollIntervalMs?: number;
}

/**
 * Claude CLI が書き込む `.credentials.json` を監視し、
 * ログイン成功（`claudeAiOauth.accessToken` が非空文字列）を検知する。
 *
 * 検知アルゴリズム:
 *   1. ポーリング（または fs.watch）で変更通知を受ける
 *   2. mtime が `preLoginMtime` と異なるか確認（変化していなければ未ログイン）
 *   3. `stabilizationMs` 待機後に再 stat して mtime が変わっていない（書き込み完了）
 *   4. JSON parse して `data.claudeAiOauth.accessToken` が非空 string であれば認証成功
 *
 * 必須フィールド形式（実機確認済 2026-04-25 / Claude CLI 2.1.120）:
 *   - camelCase + ネスト構造: `claudeAiOauth.accessToken`
 *   - snake_case (`access_token`) ではない
 *
 * 実装メモ:
 *   - 対象ファイルは小さい (~600B) ため fs.statSync / readFileSync を使用。
 *     sync I/O により fake timers との挙動を予測可能にし、async I/O 完了の
 *     macrotask 取り込み問題を回避する。
 */
export class CredentialsWatcher extends EventEmitter {
  private readonly stabilizationMs: number;
  private readonly pollIntervalMs: number;

  private intervalHandle: NodeJS.Timeout | null = null;
  private stabilizationTimer: NodeJS.Timeout | null = null;
  private pendingStartMtime: number | null = null;
  private fsWatcher: fs.FSWatcher | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private stopped = false;

  constructor(
    private readonly credentialsPath: string,
    private readonly preLoginMtime: number | null,
    options: CredentialsWatcherOptions = {}
  ) {
    super();
    this.stabilizationMs = options.stabilizationMs ?? 500;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  /**
   * 監視を開始する。ポーリングを主に、fs.watch を補助として使う。
   */
  start(): void {
    if (this.stopped) return;
    if (this.intervalHandle) return;

    this.intervalHandle = setInterval(() => {
      this.check();
    }, this.pollIntervalMs);

    // fs.watch を補助として使う（Linuxの inotify 制約に注意。あくまで補助）
    this.tryAttachFsWatch();
  }

  /**
   * 監視を停止し、リソースをクリーンアップする。
   */
  stop(): void {
    this.stopped = true;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.stabilizationTimer) {
      clearTimeout(this.stabilizationTimer);
      this.stabilizationTimer = null;
    }
    this.pendingStartMtime = null;

    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignore
      }
      this.fsWatcher = null;
    }
    if (this.dirWatcher) {
      try {
        this.dirWatcher.close();
      } catch {
        // ignore
      }
      this.dirWatcher = null;
    }
  }

  /**
   * fs.watch を補助的に取り付ける。失敗しても致命的ではない（ポーリングが主軸）。
   */
  private tryAttachFsWatch(): void {
    // ファイル自身を watch（既に存在する場合）
    try {
      if (fs.existsSync(this.credentialsPath)) {
        this.fsWatcher = fs.watch(this.credentialsPath, () => {
          this.check();
        });
        this.fsWatcher.on("error", () => {
          // エラーは握り潰し、ポーリングに委ねる
        });
      }
    } catch {
      // ignore
    }

    // 親ディレクトリも watch（ファイル作成イベントを拾うため）
    try {
      const dir = path.dirname(this.credentialsPath);
      if (fs.existsSync(dir)) {
        this.dirWatcher = fs.watch(dir, () => {
          this.check();
          // ファイル自身の watcher が未設定なら再試行
          if (!this.fsWatcher && !this.stopped) {
            try {
              if (fs.existsSync(this.credentialsPath)) {
                this.fsWatcher = fs.watch(this.credentialsPath, () => {
                  this.check();
                });
                this.fsWatcher.on("error", () => {
                  // ignore
                });
              }
            } catch {
              // ignore
            }
          }
        });
        this.dirWatcher.on("error", () => {
          // ignore
        });
      }
    } catch {
      // ignore
    }
  }

  /**
   * credentials ファイルの状態を確認し、認証成功を判定する。
   *
   * 安定化期間は内部で setTimeout を使って後続検証を予約する非同期パイプラインで実装。
   * これにより fake timers での時間制御が確定的になる。
   */
  private check(): void {
    if (this.stopped) return;

    // 既に安定化待機中なら何もしない（多重起動防止）
    if (this.stabilizationTimer) return;

    // 1. ファイル存在確認 + mtime 取得
    let stat1: fs.Stats;
    try {
      stat1 = fs.statSync(this.credentialsPath);
    } catch {
      // ENOENT 等 → 次回ポーリングに委ねる
      return;
    }

    const mtime1 = stat1.mtimeMs;

    // 2. preLoginMtime と一致 → ファイル未変更、未ログイン
    if (this.preLoginMtime !== null && mtime1 === this.preLoginMtime) {
      return;
    }

    // 3. 安定化待機を予約 → 待機後に再 stat して書き込み完了を確認
    this.pendingStartMtime = mtime1;
    this.stabilizationTimer = setTimeout(() => {
      this.stabilizationTimer = null;
      this.verifyAfterStabilization();
    }, this.stabilizationMs);
  }

  private verifyAfterStabilization(): void {
    if (this.stopped) return;

    const startMtime = this.pendingStartMtime;
    this.pendingStartMtime = null;
    if (startMtime === null) return;

    // 再 stat して書き込み完了確認
    let stat2: fs.Stats;
    try {
      stat2 = fs.statSync(this.credentialsPath);
    } catch {
      return;
    }

    if (stat2.mtimeMs !== startMtime) {
      // まだ書き込み中 → 次回ポーリングに委ねる
      return;
    }

    // ファイルを読み JSON parse
    let content: string;
    try {
      content = fs.readFileSync(this.credentialsPath, "utf8");
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // JSON parse 失敗（書き込み途中等）→ 次回に委ねる
      return;
    }

    // 必須フィールド検証: `claudeAiOauth.accessToken` が非空 string
    if (!this.hasValidAccessToken(parsed)) {
      return;
    }

    // 認証成功 → emit + stop
    this.emit("authenticated");
    this.stop();
  }

  private hasValidAccessToken(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const root = parsed as Record<string, unknown>;
    const oauth = root.claudeAiOauth;
    if (!oauth || typeof oauth !== "object") return false;
    const accessToken = (oauth as Record<string, unknown>).accessToken;
    return typeof accessToken === "string" && accessToken.length > 0;
  }
}
