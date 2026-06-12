/**
 * auq-hook-bridge - AskUserQuestion の PreToolUse hook 連携
 *
 * 背景 (チャット UI v3):
 *   対話版 claude は AskUserQuestion の tool_use を「ユーザーが回答/拒否した
 *   瞬間」に tool_result とまとめて transcript (JSONL) へ書く。質問が画面に
 *   表示されている間、JSONL には何も出ない。そのため回答待ちの質問を
 *   リアルタイムにチャット UI へ出すには JSONL 以外の情報源が必要になる。
 *
 * 方式:
 *   セッション起動時の claude コマンドに `--settings <このモジュールが生成
 *   する JSON>` を注入し、PreToolUse (matcher: AskUserQuestion) hook で
 *   tool_input を Ark の HTTP エンドポイント (/api/internal/auq-event) へ
 *   POST させる。hook の stdin には { session_id, cwd, tool_name, tool_input }
 *   の構造化 JSON が来るため、tmux 画面のパースは一切不要。
 *   (2026-06-10 実機検証: 質問表示とほぼ同時に発火、--dangerously-skip-
 *   permissions と共存可)
 *
 * セキュリティ:
 *   - エンドポイントは起動毎に生成するランダム token を要求する
 *   - token は settings ファイル (0600) の hook コマンドにのみ埋め込まれる
 *   - リモートクライアント (tunnel 経由) からの偽装 POST は token 不一致で拒否
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "./database.js";
import { getDataDir } from "./paths.js";

export const AUQ_EVENT_PATH = "/api/internal/auq-event";
export const AUQ_TOKEN_HEADER = "x-ark-auq-token";

/** hook 受信した回答待ち質問 (セッション毎に最新 1 件) */
export interface PendingAuq {
  /** サーバー受信時刻 epoch ms */
  at: number;
  /** tool_input.questions の生データ */
  questions: unknown;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const TOKEN_SETTING_KEY = "auq_hook_token";

/**
 * hook token は DB (settings テーブル) に永続化して再利用する。
 * 対話版 claude は起動時に読んだ settings (hook command 内の token) を
 * 生存中ずっと保持するため、サーバー再起動で token が変わると既存
 * セッションの hook がすべて 403 になる (Beacon の C-B3 と同じ構造)。
 */
function loadOrCreateToken(): string {
  try {
    const saved = db.getSetting(TOKEN_SETTING_KEY);
    if (typeof saved === "string" && /^[a-f0-9]{32,}$/.test(saved)) {
      return saved;
    }
    const fresh = randomBytes(24).toString("hex");
    db.setSetting(TOKEN_SETTING_KEY, fresh);
    return fresh;
  } catch {
    // DB が使えない場合は ephemeral にフォールバック (この起動中のみ有効)
    return randomBytes(24).toString("hex");
  }
}

export class AuqHookBridge {
  private token = loadOrCreateToken();
  private settingsPath: string | null = null;
  /** worktreePath や sessionId をキーにしない: 受け口で解決した sessionId で保持 */
  private pending = new Map<string, PendingAuq>();

  /** hook 認証 token の検証 */
  verifyToken(value: unknown): boolean {
    return typeof value === "string" && value === this.token;
  }

  /**
   * hook 定義入りの claude 用 settings JSON を data dir に書き出し、
   * そのパスを返す (claude 起動コマンドの --settings に渡す)。
   * port はサーバーの実 listen port。
   */
  writeSettingsFile(port: number): string {
    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const settingsPath = path.join(dataDir, "ark-claude-settings.json");
    // curl: -m 3 で TUI をブロックしない / 失敗は無視 (hook が claude の
    // 進行を止めないことを最優先)。stdin の JSON をそのまま転送する。
    const command = `curl -s -m 3 -X POST 'http://127.0.0.1:${port}${AUQ_EVENT_PATH}' -H 'Content-Type: application/json' -H '${AUQ_TOKEN_HEADER}: ${this.token}' --data-binary @- >/dev/null 2>&1 || true`;
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "AskUserQuestion",
            hooks: [{ type: "command", command }],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
    // writeFileSync の mode は新規作成時にしか適用されないため、
    // 既存ファイル (前回起動の生成物) の permission も明示的に矯正する
    // (token を含むファイルなので 0600 を assert する)
    fs.chmodSync(settingsPath, 0o600);
    this.settingsPath = settingsPath;
    return settingsPath;
  }

  getSettingsPath(): string | null {
    return this.settingsPath;
  }

  /** hook 受信を記録する (同一セッションの古い質問は上書き) */
  setPending(sessionId: string, questions: unknown): PendingAuq {
    const entry: PendingAuq = { at: Date.now(), questions };
    this.pending.set(sessionId, entry);
    return entry;
  }

  /**
   * セッションの回答待ち質問を返す (TTL 超過は破棄して null)。
   * クライアントの jsonl-subscribe 時の再送に使う。表示すべきかの最終判定
   * (すでに回答済みか) は、クライアントが JSONL の AUQ 解決イベント
   * timestamp と `at` を比較して行う。
   */
  getPending(sessionId: string): PendingAuq | null {
    const entry = this.pending.get(sessionId);
    if (!entry) return null;
    if (Date.now() - entry.at > PENDING_TTL_MS) {
      this.pending.delete(sessionId);
      return null;
    }
    return entry;
  }

  clearPending(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}

export const auqHookBridge = new AuqHookBridge();
