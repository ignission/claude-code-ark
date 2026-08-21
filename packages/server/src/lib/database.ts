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
import {
  MESSAGE_SHORTCUT_MAX_LENGTH,
  type Message,
  type MessageShortcut,
  type MessageType,
  type Profile,
  type RepoProfileLink,
  type Session,
  type SessionStatus,
  type WorktreeDisplayName,
  type WorktreeProfileLink,
} from "@ark/shared";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { getDataDir } from "./paths.js";

const LEGACY_DIAGRAM_PREFIX = "docs/diagrams/";

// データディレクトリの解決は `paths.ts` の `getDataDir()` に一元化。
// ARK_DATA_DIR 環境変数 / macOS の Application Support / Linux の cwd ベースを順に判定する。
// 旧: `path.join(process.cwd(), "data")` 直書きだったが、Finder から起動した .app では
// cwd が "/" になり書き込み失敗するため抽象化した。
//
// 注意: モジュール評価時には ARK_DATA_DIR がまだ未設定の場合があるため
// (Electron の `configureAppPaths()` が import 後に走るケース)、
// const で固定せず `getDbPath()` 経由で都度評価する。これは F3 review 指摘事項。
function getDbPath(): string {
  return join(getDataDir(), "sessions.db");
}

/** データベースに保存されるセッションの行データ */
interface SessionRow {
  id: string;
  worktree_id: string;
  worktree_path: string;
  repo_path: string | null;
  status: string;
  profile_id: string | null;
  profile_config_dir: string | null;
  board_mcp_config_path: string | null;
  /** セッションで最後に開いた図（.claude/diagrams/*.diagram.html）の worktree 相対パス */
  last_diagram_path: string | null;
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
  /**
   * board MCP の per-session mcp-config ファイルのパス。
   * 稼働中の claude は起動時に渡された token を保持し続けるため、サーバー
   * 再起動後もこのファイルから token を読み戻して registry へ復帰させる
   * （復帰しないと board_write が 401 で全滅する）。token 自体は 0600 の
   * このファイルにのみ置き、DB にはパスだけを持つ。
   */
  readonly boardMcpConfigPath?: string | null;
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
export class SessionDatabase {
  private readonly db: Database.Database;

  /**
   * @param dbPath - DBファイルのパス。省略時はデフォルトの `<dataDir>/sessions.db` を使用
   * デフォルトパスは constructor 呼び出し時点で評価するため、
   * import 後に process.env.ARK_DATA_DIR を override する Electron 用途でも追従する。
   */
  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? getDbPath();
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

    // マイグレーション: sessionsテーブルにboard_mcp_config_path列を追加
    // (サーバー再起動後に board token を registry へ復帰させるため)
    try {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN board_mcp_config_path TEXT"
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) {
        throw e;
      }
    }

    // マイグレーション: sessionsテーブルにlast_diagram_path列を追加
    // (board_open で開いた図をリロード後も右ペインに復元するため)
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN last_diagram_path TEXT");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("duplicate column name")) {
        throw e;
      }
    }
    // 旧 root の保存値は実ファイルの移行を保証できず stale tab を作るため、
    // prefix rewrite せず無効化する。同じ UPDATE の再実行は結果を変えない。
    this.db
      .prepare(
        "UPDATE sessions SET last_diagram_path = NULL WHERE substr(last_diagram_path, 1, ?) = ?"
      )
      .run(LEGACY_DIAGRAM_PREFIX.length, LEGACY_DIAGRAM_PREFIX);

    // 既存のpetsテーブルを破棄（pet機能はサーバー側を廃止済み）
    this.db.exec("DROP TABLE IF EXISTS pets;");

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
      CREATE TABLE IF NOT EXISTS worktree_profile_links (
        worktree_path TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS worktree_display_names (
        worktree_path TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // 注意: canvas_boards（旧 Excalidraw ボードの scene 永続化）テーブルは
    // B-1 でコードから撤去した。既存 DB に残っている canvas_boards テーブルは
    // 意図的に DROP していない（使われなくなるだけで害はなく、稼働中 DB を
    // 誤って壊すリスクの方が大きいため）。新規 DB でも作成しない。

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
      INSERT INTO sessions (id, worktree_id, worktree_path, repo_path, status, profile_id, profile_config_dir, board_mcp_config_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_path) DO UPDATE SET
        id = excluded.id,
        worktree_id = excluded.worktree_id,
        repo_path = COALESCE(excluded.repo_path, repo_path),
        status = excluded.status,
        profile_id = excluded.profile_id,
        profile_config_dir = excluded.profile_config_dir,
        board_mcp_config_path = excluded.board_mcp_config_path,
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
      session.boardMcpConfigPath ?? null,
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
   * セッションで最後に開いた図（worktree相対パス）を更新
   *
   * board_open で図を開くたびに呼び出し、リロード後の右ペイン復元に使う。
   * relPath に null を渡すと「最後に開いた図なし」の状態に戻せる。
   *
   * @param sessionId - セッションID
   * @param relPath - 図ファイルの worktree 相対パス、または null
   */
  updateSessionLastDiagram(sessionId: string, relPath: string | null): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE sessions SET last_diagram_path = ?, updated_at = ? WHERE id = ?"
    );
    stmt.run(relPath, now, sessionId);
  }

  /**
   * 指定 path が現在値と一致する場合だけ last_diagram_path を消去する。
   * board_open との競合で保存された別 path を消さないよう比較と更新を単一 SQL にする。
   */
  clearSessionLastDiagramIfMatches(
    sessionId: string,
    relPath: string
  ): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE sessions SET last_diagram_path = NULL, updated_at = ? WHERE id = ? AND last_diagram_path = ?"
    );
    return stmt.run(now, sessionId, relPath).changes > 0;
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
      boardMcpConfigPath: row.board_mcp_config_path,
      lastDiagramPath: row.last_diagram_path,
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
  // Worktree ↔ プロファイル紐付けCRUD操作
  // worktree個別の紐付けが優先され、無い場合は repo_profile_links がデフォルト
  // ============================================================

  /**
   * すべてのworktree紐付けを取得（クライアントの初期同期用）
   */
  listWorktreeProfileLinks(): WorktreeProfileLink[] {
    const stmt = this.db.prepare(
      "SELECT * FROM worktree_profile_links ORDER BY updated_at DESC"
    );
    const rows = stmt.all() as Array<{
      worktree_path: string;
      profile_id: string;
      updated_at: number;
    }>;
    return rows.map(row => ({
      worktreePath: row.worktree_path,
      profileId: row.profile_id,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * worktreeパスから紐付けを取得
   */
  getWorktreeProfileLink(worktreePath: string): WorktreeProfileLink | null {
    const stmt = this.db.prepare(
      "SELECT * FROM worktree_profile_links WHERE worktree_path = ?"
    );
    const row = stmt.get(worktreePath) as
      | {
          worktree_path: string;
          profile_id: string;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      worktreePath: row.worktree_path,
      profileId: row.profile_id,
      updatedAt: row.updated_at,
    };
  }

  /**
   * worktreeとプロファイルを紐付け（UPSERT）
   */
  setWorktreeProfileLink(worktreePath: string, profileId: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO worktree_profile_links (worktree_path, profile_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(worktree_path) DO UPDATE SET
        profile_id = excluded.profile_id,
        updated_at = excluded.updated_at
    `);
    stmt.run(worktreePath, profileId, now);
  }

  /**
   * worktreeの紐付けを解除
   */
  removeWorktreeProfileLink(worktreePath: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM worktree_profile_links WHERE worktree_path = ?"
    );
    stmt.run(worktreePath);
  }

  // ============================================================
  // Worktree カスタム表示名CRUD操作
  // 未設定時は UI 側で branch 名にフォールバックする
  // ============================================================

  /**
   * すべてのworktree表示名を取得（クライアントの初期同期用）
   */
  listWorktreeDisplayNames(): WorktreeDisplayName[] {
    const stmt = this.db.prepare(
      "SELECT * FROM worktree_display_names ORDER BY updated_at DESC"
    );
    const rows = stmt.all() as Array<{
      worktree_path: string;
      display_name: string;
      updated_at: number;
    }>;
    return rows.map(row => ({
      worktreePath: row.worktree_path,
      displayName: row.display_name,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * worktreeパスから表示名を取得
   */
  getWorktreeDisplayName(worktreePath: string): WorktreeDisplayName | null {
    const stmt = this.db.prepare(
      "SELECT * FROM worktree_display_names WHERE worktree_path = ?"
    );
    const row = stmt.get(worktreePath) as
      | {
          worktree_path: string;
          display_name: string;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      worktreePath: row.worktree_path,
      displayName: row.display_name,
      updatedAt: row.updated_at,
    };
  }

  /**
   * worktreeにカスタム表示名を設定（UPSERT）
   */
  setWorktreeDisplayName(worktreePath: string, displayName: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO worktree_display_names (worktree_path, display_name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(worktree_path) DO UPDATE SET
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `);
    stmt.run(worktreePath, displayName, now);
  }

  /**
   * worktreeの表示名を解除（branch名にフォールバック）
   */
  removeWorktreeDisplayName(worktreePath: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM worktree_display_names WHERE worktree_path = ?"
    );
    stmt.run(worktreePath);
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

  /**
   * message を trim 後に検証する。
   * 上位レイヤー (server handler) も trim しているが、SessionDatabase は public API
   * なので別経路から呼ばれた際にも invariant を保つよう DB 層でも正規化する。
   */
  private normalizeShortcutMessage(value: unknown): string {
    if (typeof value !== "string") {
      throw new Error("message は文字列で指定してください");
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error("message は空にできません");
    }
    if (trimmed.length > MESSAGE_SHORTCUT_MAX_LENGTH) {
      throw new Error(
        `message は ${MESSAGE_SHORTCUT_MAX_LENGTH} 文字以内で指定してください`
      );
    }
    return trimmed;
  }

  /** 新規作成（sortOrderは既存の最大+1で末尾追加） */
  createMessageShortcut(input: { message: string }): MessageShortcut {
    const message = this.normalizeShortcutMessage(input.message);
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
    stmt.run(id, message, m + 1, now, now);
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
    let normalizedMessage: string | undefined;
    if (patch.message !== undefined) {
      normalizedMessage = this.normalizeShortcutMessage(patch.message);
    }
    if (patch.sortOrder !== undefined && !Number.isInteger(patch.sortOrder)) {
      throw new Error("sortOrder は整数で指定してください");
    }
    const setClauses: string[] = [];
    const params: Array<string | number> = [];
    if (normalizedMessage !== undefined) {
      setClauses.push("message = ?");
      params.push(normalizedMessage);
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
