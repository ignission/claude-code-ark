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
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import {
  type ChatMessage,
  type FrontlineRecord,
  type FrontlineStats,
  type McpServerConfig,
  type McpServerConfigInput,
  type Message,
  MESSAGE_SHORTCUT_MAX_LENGTH,
  type MessageShortcut,
  type MessageType,
  type Profile,
  type RepoProfileLink,
  type Session,
  type SessionStatus,
} from "../../shared/types.js";

// プロジェクトルートからの相対パスでDBファイルを配置
// NOTE: esbuildバンドル時にimport.meta.urlのパスが変わるため、process.cwd()を使用
const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "sessions.db");

/** データベースに保存されるセッションの行データ */
interface SessionRow {
  id: string;
  worktree_id: string;
  worktree_path: string;
  repo_path: string | null;
  status: string;
  profile_id: string | null;
  profile_config_dir: string | null;
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
  readonly repoPath?: string;
  readonly status: SessionStatus;
  /** プロファイルID（未紐付けはnull/undefined） */
  readonly profileId?: string | null;
  /** 起動時に確定したプロファイルのconfigDir（profile_id とペア） */
  readonly profileConfigDir?: string | null;
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

/** Beacon履歴の行データ */
interface BeaconMessageRow {
  id: string;
  role: string;
  content: string;
  tool_use_json: string | null;
  timestamp: string;
}

/** Beacon履歴追加時の入力データ */
interface BeaconMessageInput {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly toolUse?: {
    toolName: string;
    input: string;
    result?: string;
  };
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
export class SessionDatabase {
  private readonly db: Database.Database;

  /**
   * @param dbPath - DBファイルのパス。省略時はデフォルトの `data/sessions.db` を使用
   */
  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? DB_PATH;
    this.ensureDataDirectory(resolvedPath);
    this.db = new Database(resolvedPath);
    this.initialize();
  }

  /**
   * DBファイルの親ディレクトリが存在しない場合は作成
   */
  private ensureDataDirectory(dbPath: string): void {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
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
        profile_id TEXT,
        profile_config_dir TEXT,
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

    // 設定テーブルの作成（汎用KVストア）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // マイグレーション: sessionsテーブルにrepo_pathカラムを追加
    // SQLiteのALTER TABLEはIF NOT EXISTSをサポートしないためtry-catchで囲む
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN repo_path TEXT");
    } catch (e) {
      // カラムが既に存在する場合のみ無視、それ以外は再スロー
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) {
        throw e;
      }
    }

    // マイグレーション: sessionsテーブルにprofile_id列を追加
    // (server再起動後のセッション復元時に sessionProfiles Map を再構築するため)
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN profile_id TEXT");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) {
        throw e;
      }
    }

    // マイグレーション: sessionsテーブルにprofile_config_dir列を追加
    // (起動時のCLAUDE_CONFIG_DIRを記録し、profile.configDir変更を検出するため)
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN profile_config_dir TEXT");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) {
        throw e;
      }
    }

    // 既存のpetsテーブルを破棄（pet機能はサーバー側を廃止済み）
    this.db.exec("DROP TABLE IF EXISTS pets;");

    // Beacon履歴テーブル（グローバルチャット用・1セッションのみ）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS beacon_messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_use_json TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_beacon_messages_timestamp ON beacon_messages(timestamp);
    `);

    // マイグレーション: 旧テーブル名 (account_profiles / repo_account_links) を
    // 新名 (profiles / repo_profile_links) にリネーム。
    // 旧コードからアップグレードしたDBでのみ成功し、新規DBや既にrename済みの
    // ケースは catch で握り潰される。CREATE TABLE IF NOT EXISTS で fallback する。
    try {
      this.db.exec("ALTER TABLE account_profiles RENAME TO profiles");
    } catch {
      // 既にrename済み or 新規DB
    }
    try {
      this.db.exec(
        "ALTER TABLE repo_account_links RENAME TO repo_profile_links"
      );
    } catch {
      // 既にrename済み or 新規DB
    }
    try {
      this.db.exec(
        "ALTER TABLE repo_profile_links RENAME COLUMN account_profile_id TO profile_id"
      );
    } catch {
      // 既にrename済み or テーブル未作成
    }

    // CLAUDE_CONFIG_DIR プロファイル機能 (Linux限定) のテーブル
    // - profiles: 各プロファイルの configDir (name と config_dir はそれぞれ UNIQUE)
    // - repo_profile_links: リポジトリパスとプロファイルの紐付け (1:1)
    // プロファイル削除時は CASCADE で紐付けも自動削除する
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        config_dir TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_profile_links (
        repo_path TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
      );
    `);

    // マイグレーション: 既存DBにも config_dir の UNIQUE INDEX を追加。
    // 旧スキーマ (UNIQUE なし) で起動していたインスタンスでも、複数プロファイル
    // が同じconfigDirを指す状態を防ぐ。
    // 既に重複データがあると失敗するが、起動を止めるべき不整合なので throw する。
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS profiles_config_dir_unique ON profiles(config_dir)"
    );

    // マイグレーション: 旧 status 列を削除（認証ダイアログ廃止）
    try {
      this.db.exec("ALTER TABLE profiles DROP COLUMN status");
    } catch {
      // 既に削除済み
    }

    // メッセージショートカット（全リポジトリ共通の定型送信メッセージ）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_shortcuts (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_shortcuts_sort
        ON message_shortcuts (sort_order, created_at);
    `);

    // マイグレーション: 旧 label 列を削除する。
    // 1) 列が無ければ何もしない (新規 DB / 既に削除済み)
    // 2) DROP COLUMN は SQLite 3.35+ で対応。古いバージョンでは syntax error
    //    (near "DROP") を返すので、その場合は warn してスキップする。
    //    現行 DDL は label を持たないので、新規挿入は問題ない。
    try {
      const hasLabel = this.db
        .prepare(
          "SELECT 1 FROM pragma_table_info('message_shortcuts') WHERE name = 'label'"
        )
        .get();
      if (hasLabel) {
        try {
          this.db.exec("ALTER TABLE message_shortcuts DROP COLUMN label");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            "[DB] DROP COLUMN label failed (SQLite version too old?):",
            msg
          );
        }
      }
    } catch (e) {
      // pragma_table_info 自体が失敗したら新規 DB の可能性が高い、warn で継続
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[DB] pragma_table_info check failed:", msg);
    }

    // ============================================================
    // MCP server 管理 (Beacon が外部 OAuth MCP に接続するため)
    // ============================================================
    // mcp_servers: ユーザーが登録した外部 MCP server 設定
    // mcp_tokens: OAuth で取得した access/refresh token (1 server 1 token)
    //
    // 暗号化はしない (MVP)。data/sessions.db のファイル mode に依存する。
    // ADR-0012 相当の keychain 統合は将来課題。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        authorization_endpoint TEXT NOT NULL,
        token_endpoint TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        audience TEXT,
        prompt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        server_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_type TEXT NOT NULL DEFAULT 'Bearer',
        scopes TEXT NOT NULL DEFAULT '[]',
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER,
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
    `);

    // マイグレーション: マルチアカウント対応のため provider_id / label を追加。
    // - provider_id: ホワイトリスト registry の id (atlassian, linear, ...)
    // - label: UI 表示用 (「Atlassian #1」「仕事用」等、ユーザ識別用)
    // 既存行 (id="atlassian" 等の単一接続データ) は provider_id <- id の値で backfill する。
    try {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN provider_id TEXT");
      // 既存行の provider_id を id (旧スキーマでは provider と一致してた) で埋める
      this.db.exec(
        "UPDATE mcp_servers SET provider_id = id WHERE provider_id IS NULL"
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) throw e;
    }
    try {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN label TEXT");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) throw e;
    }
    // account_hint: provider 固有のアカウント詳細 (例: Atlassian なら site の cloudId + URL)。
    // Beacon の system prompt に注入してモデルが URL から connection を選べるようにする。
    try {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN account_hint TEXT");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) throw e;
    }
    // provider_id 検索を高速化 (UI のグループ表示で頻繁に集計するため)
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_mcp_servers_provider_id ON mcp_servers(provider_id)"
    );

    // フロントライン記録テーブル
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS frontline_records (
        id TEXT PRIMARY KEY,
        distance INTEGER NOT NULL,
        kills INTEGER NOT NULL,
        headshots INTEGER NOT NULL,
        total_shots INTEGER NOT NULL,
        play_time INTEGER NOT NULL,
        merit_points INTEGER NOT NULL,
        blocks INTEGER NOT NULL DEFAULT 0,
        heli_kills INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS frontline_stats (
        id TEXT PRIMARY KEY DEFAULT 'player',
        total_plays INTEGER NOT NULL DEFAULT 0,
        total_play_time INTEGER NOT NULL DEFAULT 0,
        total_kills INTEGER NOT NULL DEFAULT 0,
        total_headshots INTEGER NOT NULL DEFAULT 0,
        total_shots INTEGER NOT NULL DEFAULT 0,
        total_merit_points INTEGER NOT NULL DEFAULT 0,
        best_distance INTEGER NOT NULL DEFAULT 0,
        best_kills INTEGER NOT NULL DEFAULT 0,
        rank TEXT NOT NULL DEFAULT '二等兵',
        play_hours TEXT NOT NULL DEFAULT '{}',
        medals TEXT NOT NULL DEFAULT '[]',
        death_positions TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  private safeJsonParse<T>(json: string, fallback: T, fieldName: string): T {
    try {
      return JSON.parse(json) as T;
    } catch {
      console.warn(`[DB] Failed to parse frontline_stats.${fieldName}:`, json);
      return fallback;
    }
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
      INSERT INTO sessions (id, worktree_id, worktree_path, repo_path, status, profile_id, profile_config_dir, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.worktreeId,
      session.worktreePath,
      session.repoPath ?? null,
      session.status,
      session.profileId ?? null,
      session.profileConfigDir ?? null,
      now,
      now
    );
  }

  /**
   * セッションをupsert（存在すれば更新、なければ作成）
   *
   * worktree_pathのUNIQUE制約に基づき、競合時はid, worktree_id, status,
   * profile_id, profile_config_dir を更新する
   *
   * @param session - セッション作成データ
   */
  upsertSession(session: CreateSessionInput): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, worktree_id, worktree_path, repo_path, status, profile_id, profile_config_dir, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_path) DO UPDATE SET
        id = excluded.id,
        worktree_id = excluded.worktree_id,
        repo_path = COALESCE(excluded.repo_path, repo_path),
        status = excluded.status,
        profile_id = excluded.profile_id,
        profile_config_dir = excluded.profile_config_dir,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      session.id,
      session.worktreeId,
      session.worktreePath,
      session.repoPath ?? null,
      session.status,
      session.profileId ?? null,
      session.profileConfigDir ?? null,
      now,
      now
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
      "SELECT * FROM sessions WHERE worktree_path = ?"
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
      "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?"
    );
    stmt.run(status, now, id);
  }

  /**
   * セッションのリポジトリパスを更新
   *
   * @param id - セッションID
   * @param repoPath - リポジトリのルートパス
   */
  updateSessionRepoPath(id: string, repoPath: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE sessions SET repo_path = ?, updated_at = ? WHERE id = ?"
    );
    stmt.run(repoPath, now, id);
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
   * 旧セッションIDを削除し、新しいIDで upsert する操作を atomic に実行。
   *
   * restartSession 用。messages.session_id は ON DELETE CASCADE のみで
   * ON UPDATE CASCADE が無いため、id を直接書き換える upsert は外部キー
   * 違反になる。delete → insert の順で行うが、片方だけ成功すると整合性が
   * 壊れるためトランザクションで括る。失敗時は自動ROLLBACKされ、呼び出し
   * 側は旧行が無傷で残ったまま例外を受け取れる。
   */
  replaceSession(oldId: string, newSession: CreateSessionInput): void {
    const txn = this.db.transaction((oid: string, ns: CreateSessionInput) => {
      this.deleteSession(oid);
      this.upsertSession(ns);
    });
    txn(oldId, newSession);
  }

  /**
   * 全てのセッションを取得
   *
   * @returns セッションの配列
   */
  getAllSessions(): Session[] {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions ORDER BY created_at DESC"
    );
    const rows = stmt.all() as SessionRow[];
    return rows.map(row => this.rowToSession(row));
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
      message.timestamp.toISOString()
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
      "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC"
    );
    const rows = stmt.all(sessionId) as MessageRow[];
    return rows.map(row => this.rowToMessage(row));
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
  // Beacon履歴CRUD操作
  // ============================================================

  /** Beacon履歴の保持上限（UI表示・WebSocket送信のペイロード抑制用） */
  private static readonly BEACON_MESSAGES_RETENTION = 500;

  /**
   * Beaconチャット履歴にメッセージを追加
   *
   * 追加後、保持上限 (BEACON_MESSAGES_RETENTION) を超えた古いレコードを
   * LRU的にトリムしてDB無限成長を防ぐ。
   */
  addBeaconMessage(message: BeaconMessageInput): void {
    const stmt = this.db.prepare(`
      INSERT INTO beacon_messages (id, role, content, tool_use_json, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      message.role,
      message.content,
      message.toolUse ? JSON.stringify(message.toolUse) : null,
      message.timestamp.toISOString()
    );

    // 古いメッセージをトリム（直近 RETENTION 件のみ保持）
    const trim = this.db.prepare(`
      DELETE FROM beacon_messages
      WHERE id NOT IN (
        SELECT id FROM beacon_messages ORDER BY timestamp DESC LIMIT ?
      )
    `);
    trim.run(SessionDatabase.BEACON_MESSAGES_RETENTION);
  }

  /**
   * Beaconチャット履歴を取得（タイムスタンプ昇順、直近 limit 件）
   *
   * limit のデフォルトは保持上限と同じ。UI/WebSocket送信で全件返す必要がある想定。
   */
  getBeaconMessages(
    limit: number = SessionDatabase.BEACON_MESSAGES_RETENTION
  ): ChatMessage[] {
    // 直近 limit 件を時刻降順で取って、表示用に昇順に戻す
    const stmt = this.db.prepare(
      "SELECT * FROM (SELECT * FROM beacon_messages ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC"
    );
    const rows = stmt.all(limit) as BeaconMessageRow[];
    return rows.map(row => {
      const toolUse = row.tool_use_json
        ? this.safeJsonParse<ChatMessage["toolUse"]>(
            row.tool_use_json,
            undefined,
            `beacon_messages.tool_use_json[${row.id}]`
          )
        : undefined;
      return {
        id: row.id,
        role: row.role as "user" | "assistant",
        content: row.content,
        timestamp: new Date(row.timestamp),
        toolUse,
      };
    });
  }

  /**
   * Beaconチャット履歴を全削除
   */
  clearBeaconMessages(): void {
    this.db.exec("DELETE FROM beacon_messages");
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
      repoPath: row.repo_path ?? undefined,
      status: row.status as SessionStatus,
      createdAt: new Date(row.created_at),
      profileId: row.profile_id,
      profileConfigDir: row.profile_config_dir,
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

  // ============================================================
  // プロファイルCRUD操作 (CLAUDE_CONFIG_DIR切替機能)
  // ============================================================

  /**
   * profiles テーブルの行データ
   */
  private rowToProfile(row: {
    id: string;
    name: string;
    config_dir: string;
    created_at: number;
    updated_at: number;
  }): Profile {
    return {
      id: row.id,
      name: row.name,
      configDir: row.config_dir,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 登録済みプロファイルを全件取得（作成順）
   */
  listProfiles(): Profile[] {
    const stmt = this.db.prepare(
      "SELECT * FROM profiles ORDER BY created_at ASC"
    );
    const rows = stmt.all() as Array<{
      id: string;
      name: string;
      config_dir: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(row => this.rowToProfile(row));
  }

  /**
   * IDでプロファイルを取得
   */
  getProfile(id: string): Profile | null {
    const stmt = this.db.prepare("SELECT * FROM profiles WHERE id = ?");
    const row = stmt.get(id) as
      | {
          id: string;
          name: string;
          config_dir: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    return row ? this.rowToProfile(row) : null;
  }

  /**
   * 新規プロファイルを作成
   *
   * @throws name が既存と重複している場合（UNIQUE制約違反）
   */
  createProfile(input: { name: string; configDir: string }): Profile {
    const id = nanoid();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO profiles (id, name, config_dir, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, input.name, input.configDir, now, now);
    const created = this.getProfile(id);
    if (!created) {
      throw new Error(`Failed to create profile: ${id}`);
    }
    return created;
  }

  /**
   * プロファイルの一部フィールドを更新
   * undefined のフィールドはスキップ
   */
  updateProfile(
    id: string,
    patch: { name?: string; configDir?: string }
  ): Profile {
    const setClauses: string[] = [];
    const params: Array<string | number> = [];
    if (patch.name !== undefined) {
      setClauses.push("name = ?");
      params.push(patch.name);
    }
    if (patch.configDir !== undefined) {
      setClauses.push("config_dir = ?");
      params.push(patch.configDir);
    }
    setClauses.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);
    const stmt = this.db.prepare(
      `UPDATE profiles SET ${setClauses.join(", ")} WHERE id = ?`
    );
    const result = stmt.run(...params);
    if (result.changes === 0) {
      throw new Error(`Profile not found: ${id}`);
    }
    const updated = this.getProfile(id);
    if (!updated) {
      throw new Error(`Profile not found after update: ${id}`);
    }
    return updated;
  }

  /**
   * プロファイルを削除（紐付けはCASCADEで自動削除）
   */
  deleteProfile(id: string): void {
    const stmt = this.db.prepare("DELETE FROM profiles WHERE id = ?");
    stmt.run(id);
  }

  // ============================================================
  // リポジトリ ↔ プロファイル紐付けCRUD操作
  // ============================================================

  /**
   * すべてのリポジトリ紐付けを取得（クライアントの初期同期用）
   */
  listRepoProfileLinks(): RepoProfileLink[] {
    const stmt = this.db.prepare(
      "SELECT * FROM repo_profile_links ORDER BY updated_at DESC"
    );
    const rows = stmt.all() as Array<{
      repo_path: string;
      profile_id: string;
      updated_at: number;
    }>;
    return rows.map(row => ({
      repoPath: row.repo_path,
      profileId: row.profile_id,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * リポジトリパスから紐付けを取得
   */
  getRepoProfileLink(repoPath: string): RepoProfileLink | null {
    const stmt = this.db.prepare(
      "SELECT * FROM repo_profile_links WHERE repo_path = ?"
    );
    const row = stmt.get(repoPath) as
      | {
          repo_path: string;
          profile_id: string;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      repoPath: row.repo_path,
      profileId: row.profile_id,
      updatedAt: row.updated_at,
    };
  }

  /**
   * リポジトリとプロファイルを紐付け（UPSERT）
   */
  setRepoProfileLink(repoPath: string, profileId: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO repo_profile_links (repo_path, profile_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(repo_path) DO UPDATE SET
        profile_id = excluded.profile_id,
        updated_at = excluded.updated_at
    `);
    stmt.run(repoPath, profileId, now);
  }

  /**
   * リポジトリの紐付けを解除
   */
  removeRepoProfileLink(repoPath: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM repo_profile_links WHERE repo_path = ?"
    );
    stmt.run(repoPath);
  }

  // ============================================================
  // 設定CRUD操作
  // ============================================================

  /**
   * 全ての設定を取得
   */
  getAllSettings(): Record<string, unknown> {
    const stmt = this.db.prepare("SELECT key, value FROM settings");
    const rows = stmt.all() as Array<{ key: string; value: string }>;
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        result[row.key] = row.value;
      }
    }
    return result;
  }

  /**
   * 特定キーの設定を取得
   */
  getSetting(key: string): unknown | undefined {
    const stmt = this.db.prepare("SELECT value FROM settings WHERE key = ?");
    const row = stmt.get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  /**
   * 設定を保存（UPSERT）
   */
  setSetting(key: string, value: unknown): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run(key, JSON.stringify(value), now);
  }

  /**
   * 複数の設定を一括保存（トランザクション）
   */
  setSettings(entries: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const transaction = this.db.transaction(() => {
      for (const [key, value] of Object.entries(entries)) {
        stmt.run(key, JSON.stringify(value), now);
      }
    });
    transaction();
  }

  /**
   * 設定を削除
   */
  deleteSetting(key: string): void {
    const stmt = this.db.prepare("DELETE FROM settings WHERE key = ?");
    stmt.run(key);
  }

  // ============================================================
  // フロントラインCRUD操作
  // ============================================================

  /** フロントライン記録の行データ */
  createFrontlineRecord(record: FrontlineRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO frontline_records (id, distance, kills, headshots, total_shots, play_time, merit_points, blocks, heli_kills, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.distance,
      record.kills,
      record.headshots,
      record.totalShots,
      record.playTime,
      record.meritPoints,
      record.blocks,
      record.heliKills,
      record.createdAt
    );
  }

  getFrontlineRecords(limit = 50): FrontlineRecord[] {
    const stmt = this.db.prepare(
      "SELECT * FROM frontline_records ORDER BY created_at DESC LIMIT ?"
    );
    const rows = stmt.all(limit) as Array<{
      id: string;
      distance: number;
      kills: number;
      headshots: number;
      total_shots: number;
      play_time: number;
      merit_points: number;
      blocks: number;
      heli_kills: number;
      created_at: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      distance: row.distance,
      kills: row.kills,
      headshots: row.headshots,
      totalShots: row.total_shots,
      playTime: row.play_time,
      meritPoints: row.merit_points,
      blocks: row.blocks,
      heliKills: row.heli_kills,
      createdAt: row.created_at,
    }));
  }

  getFrontlineStats(): FrontlineStats | null {
    const stmt = this.db.prepare(
      "SELECT * FROM frontline_stats WHERE id = 'player'"
    );
    const row = stmt.get() as
      | {
          id: string;
          total_plays: number;
          total_play_time: number;
          total_kills: number;
          total_headshots: number;
          total_shots: number;
          total_merit_points: number;
          best_distance: number;
          best_kills: number;
          rank: string;
          play_hours: string;
          medals: string;
          death_positions: string;
        }
      | undefined;
    if (!row) return null;
    return {
      totalPlays: row.total_plays,
      totalPlayTime: row.total_play_time,
      totalKills: row.total_kills,
      totalHeadshots: row.total_headshots,
      totalShots: row.total_shots,
      totalMeritPoints: row.total_merit_points,
      bestDistance: row.best_distance,
      bestKills: row.best_kills,
      rank: row.rank,
      playHours: this.safeJsonParse<Record<string, number>>(
        row.play_hours,
        {},
        "play_hours"
      ),
      medals: this.safeJsonParse<string[]>(row.medals, [], "medals"),
      deathPositions: this.safeJsonParse<number[]>(
        row.death_positions,
        [],
        "death_positions"
      ),
    };
  }

  upsertFrontlineStats(stats: FrontlineStats): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO frontline_stats (id, total_plays, total_play_time, total_kills, total_headshots, total_shots, total_merit_points, best_distance, best_kills, rank, play_hours, medals, death_positions, updated_at)
      VALUES ('player', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_plays = excluded.total_plays,
        total_play_time = excluded.total_play_time,
        total_kills = excluded.total_kills,
        total_headshots = excluded.total_headshots,
        total_shots = excluded.total_shots,
        total_merit_points = excluded.total_merit_points,
        best_distance = excluded.best_distance,
        best_kills = excluded.best_kills,
        rank = excluded.rank,
        play_hours = excluded.play_hours,
        medals = excluded.medals,
        death_positions = excluded.death_positions,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      stats.totalPlays,
      stats.totalPlayTime,
      stats.totalKills,
      stats.totalHeadshots,
      stats.totalShots,
      stats.totalMeritPoints,
      stats.bestDistance,
      stats.bestKills,
      stats.rank,
      JSON.stringify(stats.playHours),
      JSON.stringify(stats.medals),
      JSON.stringify(stats.deathPositions),
      now
    );
  }

  // ============================================================
  // MCP server / OAuth token CRUD
  // ============================================================

  private rowToMcpServer(row: {
    id: string;
    name: string;
    url: string;
    authorization_endpoint: string;
    token_endpoint: string;
    client_id: string;
    scopes: string;
    audience: string | null;
    prompt: string | null;
    provider_id: string | null;
    label: string | null;
    account_hint: string | null;
    created_at: number;
    updated_at: number;
  }): McpServerConfig {
    return {
      id: row.id,
      // 旧スキーマ互換: provider_id 列が無い (NULL) なら id をそのまま使う
      providerId: row.provider_id || row.id,
      label: row.label || row.name,
      name: row.name,
      url: row.url,
      authorizationEndpoint: row.authorization_endpoint,
      tokenEndpoint: row.token_endpoint,
      clientId: row.client_id,
      scopes: this.safeJsonParse<string[]>(
        row.scopes,
        [],
        "mcp_servers.scopes"
      ),
      audience: row.audience ?? undefined,
      prompt: row.prompt ?? undefined,
      accountHint: row.account_hint ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 登録済み MCP server connection を一覧 (作成順) */
  listMcpServers(): McpServerConfig[] {
    const stmt = this.db.prepare(
      "SELECT * FROM mcp_servers ORDER BY created_at ASC"
    );
    return (stmt.all() as Parameters<typeof this.rowToMcpServer>[0][]).map(
      row => this.rowToMcpServer(row)
    );
  }

  /** connection ID で MCP server を取得 */
  getMcpServer(id: string): McpServerConfig | null {
    const stmt = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?");
    const row = stmt.get(id) as
      | Parameters<typeof this.rowToMcpServer>[0]
      | undefined;
    return row ? this.rowToMcpServer(row) : null;
  }

  /** 同 provider に属する connection 数 (label 自動採番に使う) */
  countMcpServersByProvider(providerId: string): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as n FROM mcp_servers WHERE provider_id = ?"
    );
    const row = stmt.get(providerId) as { n: number };
    return row.n;
  }

  /** MCP server connection を新規作成 */
  createMcpServer(input: McpServerConfigInput): McpServerConfig {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO mcp_servers (id, provider_id, label, name, url, authorization_endpoint, token_endpoint, client_id, scopes, audience, prompt, account_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      input.id,
      input.providerId,
      input.label,
      input.name,
      input.url,
      input.authorizationEndpoint,
      input.tokenEndpoint,
      input.clientId,
      JSON.stringify(input.scopes),
      input.audience ?? null,
      input.prompt ?? null,
      input.accountHint ?? null,
      now,
      now
    );
    const created = this.getMcpServer(input.id);
    if (!created) throw new Error(`Failed to create MCP server: ${input.id}`);
    return created;
  }

  /**
   * MCP server を部分更新。undefined のフィールドはスキップする。
   * id は変更不可。
   */
  updateMcpServer(
    id: string,
    patch: Partial<McpServerConfigInput>
  ): McpServerConfig {
    const setClauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      setClauses.push("name = ?");
      params.push(patch.name);
    }
    if (patch.url !== undefined) {
      setClauses.push("url = ?");
      params.push(patch.url);
    }
    if (patch.authorizationEndpoint !== undefined) {
      setClauses.push("authorization_endpoint = ?");
      params.push(patch.authorizationEndpoint);
    }
    if (patch.tokenEndpoint !== undefined) {
      setClauses.push("token_endpoint = ?");
      params.push(patch.tokenEndpoint);
    }
    if (patch.clientId !== undefined) {
      setClauses.push("client_id = ?");
      params.push(patch.clientId);
    }
    if (patch.scopes !== undefined) {
      setClauses.push("scopes = ?");
      params.push(JSON.stringify(patch.scopes));
    }
    if (patch.audience !== undefined) {
      setClauses.push("audience = ?");
      params.push(patch.audience || null);
    }
    if (patch.prompt !== undefined) {
      setClauses.push("prompt = ?");
      params.push(patch.prompt || null);
    }
    if (patch.label !== undefined) {
      setClauses.push("label = ?");
      params.push(patch.label);
    }
    if (patch.accountHint !== undefined) {
      setClauses.push("account_hint = ?");
      params.push(patch.accountHint || null);
    }
    setClauses.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);
    const stmt = this.db.prepare(
      `UPDATE mcp_servers SET ${setClauses.join(", ")} WHERE id = ?`
    );
    const result = stmt.run(...params);
    if (result.changes === 0) {
      throw new Error(`MCP server not found: ${id}`);
    }
    const updated = this.getMcpServer(id);
    if (!updated) throw new Error(`MCP server not found after update: ${id}`);
    return updated;
  }

  /** MCP server を削除（token も CASCADE で削除される） */
  deleteMcpServer(id: string): void {
    const stmt = this.db.prepare("DELETE FROM mcp_servers WHERE id = ?");
    stmt.run(id);
  }

  /** MCP server に紐づく OAuth token */
  getMcpToken(serverId: string): {
    accessToken: string;
    refreshToken: string | null;
    tokenType: string;
    scopes: string[];
    acquiredAt: number;
    expiresAt: number | null;
  } | null {
    const stmt = this.db.prepare(
      "SELECT * FROM mcp_tokens WHERE server_id = ?"
    );
    const row = stmt.get(serverId) as
      | {
          server_id: string;
          access_token: string;
          refresh_token: string | null;
          token_type: string;
          scopes: string;
          acquired_at: number;
          expires_at: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      tokenType: row.token_type,
      scopes: this.safeJsonParse<string[]>(row.scopes, [], "mcp_tokens.scopes"),
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
    };
  }

  /** OAuth token を upsert */
  upsertMcpToken(input: {
    serverId: string;
    accessToken: string;
    refreshToken?: string | null;
    tokenType?: string;
    scopes?: string[];
    acquiredAt: number;
    expiresAt?: number | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO mcp_tokens (server_id, access_token, refresh_token, token_type, scopes, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_type = excluded.token_type,
        scopes = excluded.scopes,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    `);
    stmt.run(
      input.serverId,
      input.accessToken,
      input.refreshToken ?? null,
      input.tokenType ?? "Bearer",
      JSON.stringify(input.scopes ?? []),
      input.acquiredAt,
      input.expiresAt ?? null
    );
  }

  /** OAuth token を削除（再認証時に呼ぶ） */
  deleteMcpToken(serverId: string): void {
    const stmt = this.db.prepare("DELETE FROM mcp_tokens WHERE server_id = ?");
    stmt.run(serverId);
  }

  // ============================================================
  // メッセージショートカットCRUD操作
  // ============================================================

  private rowToMessageShortcut(row: {
    id: string;
    message: string;
    sort_order: number;
    created_at: number;
    updated_at: number;
  }): MessageShortcut {
    return {
      id: row.id,
      message: row.message,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** ショートカットを並び順 → 作成順で全件取得 */
  listMessageShortcuts(): MessageShortcut[] {
    const stmt = this.db.prepare(
      "SELECT * FROM message_shortcuts ORDER BY sort_order ASC, created_at ASC"
    );
    const rows = stmt.all() as Array<{
      id: string;
      message: string;
      sort_order: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(row => this.rowToMessageShortcut(row));
  }

  getMessageShortcut(id: string): MessageShortcut | null {
    const stmt = this.db.prepare(
      "SELECT * FROM message_shortcuts WHERE id = ?"
    );
    const row = stmt.get(id) as
      | {
          id: string;
          message: string;
          sort_order: number;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    return row ? this.rowToMessageShortcut(row) : null;
  }

  /** 新規作成（sortOrderは既存の最大+1で末尾追加） */
  createMessageShortcut(input: { message: string }): MessageShortcut {
    if (typeof input.message !== "string" || input.message.length === 0) {
      throw new Error("message は必須です");
    }
    if (input.message.length > MESSAGE_SHORTCUT_MAX_LENGTH) {
      throw new Error(
        `message は ${MESSAGE_SHORTCUT_MAX_LENGTH} 文字以内で指定してください`
      );
    }
    const id = nanoid();
    const now = Date.now();
    const maxStmt = this.db.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS m FROM message_shortcuts"
    );
    const { m } = maxStmt.get() as { m: number };
    const stmt = this.db.prepare(`
      INSERT INTO message_shortcuts (id, message, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, input.message, m + 1, now, now);
    const created = this.getMessageShortcut(id);
    if (!created) {
      throw new Error(`Failed to create message shortcut: ${id}`);
    }
    return created;
  }

  /** 部分更新。undefined のフィールドはスキップ */
  updateMessageShortcut(
    id: string,
    patch: { message?: string; sortOrder?: number }
  ): MessageShortcut {
    if (patch.message !== undefined) {
      if (typeof patch.message !== "string" || patch.message.length === 0) {
        throw new Error("message は空にできません");
      }
      if (patch.message.length > MESSAGE_SHORTCUT_MAX_LENGTH) {
        throw new Error(
          `message は ${MESSAGE_SHORTCUT_MAX_LENGTH} 文字以内で指定してください`
        );
      }
    }
    if (patch.sortOrder !== undefined && !Number.isInteger(patch.sortOrder)) {
      throw new Error("sortOrder は整数で指定してください");
    }
    const setClauses: string[] = [];
    const params: Array<string | number> = [];
    if (patch.message !== undefined) {
      setClauses.push("message = ?");
      params.push(patch.message);
    }
    if (patch.sortOrder !== undefined) {
      setClauses.push("sort_order = ?");
      params.push(patch.sortOrder);
    }
    setClauses.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);
    const stmt = this.db.prepare(
      `UPDATE message_shortcuts SET ${setClauses.join(", ")} WHERE id = ?`
    );
    const result = stmt.run(...params);
    if (result.changes === 0) {
      throw new Error(`Message shortcut not found: ${id}`);
    }
    const updated = this.getMessageShortcut(id);
    if (!updated) {
      throw new Error(`Message shortcut not found after update: ${id}`);
    }
    return updated;
  }

  deleteMessageShortcut(id: string): void {
    const stmt = this.db.prepare("DELETE FROM message_shortcuts WHERE id = ?");
    stmt.run(id);
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
