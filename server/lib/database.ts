/**
 * セッションとメッセージの永続化を担当するSQLiteデータベースクラス
 *
 * @description
 * - better-sqlite3の同期APIを使用
 * - data/sessions.db にデータを保存
 * - 外部キー制約を有効化
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type {
  Message,
  MessageType,
  Session,
  SessionStatus,
} from "../../shared/types.js";

// ESM環境での__dirname相当を取得
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// プロジェクトルートからの相対パスでDBファイルを配置
const PROJECT_ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const DB_PATH = join(DATA_DIR, "sessions.db");

/** データベースに保存されるセッションの行データ */
interface SessionRow {
  id: string;
  worktree_id: string;
  worktree_path: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** データベースに保存されるメッセージの行データ */
interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  type: string;
  timestamp: string;
}

/** セッション作成時の入力データ */
interface CreateSessionInput {
  readonly id: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly status: SessionStatus;
}

/** メッセージ作成時の入力データ */
interface CreateMessageInput {
  readonly id: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly type?: MessageType;
  readonly timestamp: Date;
}

/**
 * セッションとメッセージを管理するSQLiteデータベースクラス
 *
 * @example
 * ```typescript
 * import { db } from './database.js';
 *
 * // セッション作成
 * db.createSession({
 *   id: 'session-123',
 *   worktreeId: 'wt-456',
 *   worktreePath: '/path/to/worktree',
 *   status: 'idle'
 * });
 *
 * // メッセージ追加
 * db.addMessage({
 *   id: 'msg-789',
 *   sessionId: 'session-123',
 *   role: 'user',
 *   content: 'Hello, Claude!',
 *   timestamp: new Date()
 * });
 * ```
 */
class SessionDatabase {
  private readonly db: Database.Database;

  constructor() {
    this.ensureDataDirectory();
    this.db = new Database(DB_PATH);
    this.initialize();
  }

  /**
   * data/ディレクトリが存在しない場合は作成
   */
  private ensureDataDirectory(): void {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * データベースの初期化
   * - 外部キー制約を有効化
   * - テーブルが存在しない場合は作成
   */
  private initialize(): void {
    // 外部キー制約を有効化
    this.db.pragma("foreign_keys = ON");

    // セッションテーブルの作成
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // メッセージテーブルの作成
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'text',
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // インデックスの作成（パフォーマンス向上）
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_worktree_path ON sessions(worktree_path);
    `);
  }

  // ============================================================
  // セッションCRUD操作
  // ============================================================

  /**
   * 新しいセッションを作成
   *
   * @param session - セッション作成データ
   * @throws {Error} worktree_pathが重複している場合
   */
  createSession(session: CreateSessionInput): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, worktree_id, worktree_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.worktreeId,
      session.worktreePath,
      session.status,
      now,
      now,
    );
  }

  /**
   * セッションをupsert（存在すれば更新、なければ作成）
   *
   * worktree_pathのUNIQUE制約に基づき、競合時はworktree_id, statusを更新する（idは既存値を維持）
   *
   * @param session - セッション作成データ
   */
  upsertSession(session: CreateSessionInput): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, worktree_id, worktree_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_path) DO UPDATE SET
        worktree_id = excluded.worktree_id,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      session.id,
      session.worktreeId,
      session.worktreePath,
      session.status,
      now,
      now,
    );
  }

  /**
   * IDでセッションを取得
   *
   * @param id - セッションID
   * @returns セッションオブジェクト、存在しない場合はnull
   */
  getSession(id: string): Session | null {
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE id = ?");
    const row = stmt.get(id) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  /**
   * worktreeパスでセッションを取得
   *
   * @param worktreePath - worktreeのファイルパス
   * @returns セッションオブジェクト、存在しない場合はnull
   */
  getSessionByWorktreePath(worktreePath: string): Session | null {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE worktree_path = ?",
    );
    const row = stmt.get(worktreePath) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  /**
   * セッションのステータスを更新
   *
   * @param id - セッションID
   * @param status - 新しいステータス
   */
  updateSessionStatus(id: string, status: SessionStatus): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
    );
    stmt.run(status, now, id);
  }

  /**
   * セッションを削除（関連するメッセージも自動削除）
   *
   * @param id - セッションID
   */
  deleteSession(id: string): void {
    const stmt = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    stmt.run(id);
  }

  /**
   * 全てのセッションを取得
   *
   * @returns セッションの配列
   */
  getAllSessions(): Session[] {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions ORDER BY created_at DESC",
    );
    const rows = stmt.all() as SessionRow[];
    return rows.map((row) => this.rowToSession(row));
  }

  // ============================================================
  // メッセージCRUD操作
  // ============================================================

  /**
   * 新しいメッセージを追加
   *
   * @param message - メッセージ作成データ
   * @throws {Error} session_idが存在しない場合（外部キー制約違反）
   */
  addMessage(message: CreateMessageInput): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.type ?? "text",
      message.timestamp.toISOString(),
    );
  }

  /**
   * セッションに紐づくメッセージを取得
   *
   * @param sessionId - セッションID
   * @returns メッセージの配列（タイムスタンプ昇順）
   */
  getMessagesBySession(sessionId: string): Message[] {
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
    );
    const rows = stmt.all(sessionId) as MessageRow[];
    return rows.map((row) => this.rowToMessage(row));
  }

  /**
   * セッションのメッセージを全て削除
   *
   * @param sessionId - セッションID
   */
  clearMessages(sessionId: string): void {
    const stmt = this.db.prepare("DELETE FROM messages WHERE session_id = ?");
    stmt.run(sessionId);
  }

  // ============================================================
  // ユーティリティメソッド
  // ============================================================

  /**
   * データベース行をSessionオブジェクトに変換
   */
  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      worktreeId: row.worktree_id,
      worktreePath: row.worktree_path,
      status: row.status as SessionStatus,
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * データベース行をMessageオブジェクトに変換
   */
  private rowToMessage(row: MessageRow): Message {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role as "user" | "assistant" | "system",
      content: row.content,
      type: row.type as MessageType,
      timestamp: new Date(row.timestamp),
    };
  }

  /**
   * データベース接続を閉じる
   */
  close(): void {
    this.db.close();
  }
}

/** シングルトンインスタンス */
export const db = new SessionDatabase();
