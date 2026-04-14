/**
 * セッションとメッセージの永続化を担当するSQLiteデータベースクラス
 *
 * @description
 * - better-sqlite3の同期APIを使用
 * - data/sessions.db にデータを保存
 * - 外部キー制約を有効化
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  FrontlineRecord,
  FrontlineStats,
  Message,
  MessageType,
  Pet,
  PetMood,
  PetSpecies,
  Session,
  SessionStatus,
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

/** データベースに保存されるペットの行データ */
interface PetRow {
  id: string;
  session_id: string;
  species: string;
  name: string | null;
  level: number;
  exp: number;
  hp: number;
  mood: string;
  created_at: string;
  updated_at: string;
}

/** ペット作成時の入力データ */
interface CreatePetInput {
  readonly id: string;
  readonly sessionId: string;
  readonly species: PetSpecies;
  readonly name?: string | null;
  readonly level?: number;
  readonly exp?: number;
  readonly hp?: number;
  readonly mood?: PetMood;
}

/** ペット更新時の入力データ */
interface UpdatePetInput {
  readonly name?: string | null;
  readonly level?: number;
  readonly exp?: number;
  readonly hp?: number;
  readonly mood?: PetMood;
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

    // ペットテーブルの作成（ON DELETE CASCADEなし — ペット削除はpetManager.onSessionDeleted()で明示的に行う）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        species TEXT NOT NULL,
        name TEXT,
        level INTEGER NOT NULL DEFAULT 1,
        exp INTEGER NOT NULL DEFAULT 0,
        hp INTEGER NOT NULL DEFAULT 100,
        mood TEXT NOT NULL DEFAULT 'happy',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);

    // マイグレーション: 既存のpetsテーブルにON DELETE CASCADEが付いている場合はテーブル再作成
    // SQLiteはFKの変更をサポートしないため、テーブル再作成で対応する
    this.migratePetsRemoveCascade();

    // ペットテーブルのインデックス作成
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pets_session_id ON pets(session_id);
    `);

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
        updated_at TEXT NOT NULL DEFAULT ''
      );
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
      INSERT INTO sessions (id, worktree_id, worktree_path, repo_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.worktreeId,
      session.worktreePath,
      session.repoPath ?? null,
      session.status,
      now,
      now
    );
  }

  /**
   * セッションをupsert（存在すれば更新、なければ作成）
   *
   * worktree_pathのUNIQUE制約に基づき、競合時はid, worktree_id, statusを更新する
   *
   * @param session - セッション作成データ
   */
  upsertSession(session: CreateSessionInput): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, worktree_id, worktree_path, repo_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_path) DO UPDATE SET
        id = excluded.id,
        worktree_id = excluded.worktree_id,
        repo_path = COALESCE(excluded.repo_path, repo_path),
        status = excluded.status,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      session.id,
      session.worktreeId,
      session.worktreePath,
      session.repoPath ?? null,
      session.status,
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
  // ペットCRUD操作
  // ============================================================

  /**
   * 新しいペットを作成
   *
   * @param pet - ペット作成データ
   */
  createPet(pet: CreatePetInput): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO pets (id, session_id, species, name, level, exp, hp, mood, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      pet.id,
      pet.sessionId,
      pet.species,
      pet.name ?? null,
      pet.level ?? 1,
      pet.exp ?? 0,
      pet.hp ?? 100,
      pet.mood ?? "happy",
      now,
      now
    );
  }

  /**
   * IDでペットを取得
   *
   * @param id - ペットID
   * @returns ペットオブジェクト、存在しない場合はnull
   */
  getPet(id: string): Pet | null {
    const stmt = this.db.prepare("SELECT * FROM pets WHERE id = ?");
    const row = stmt.get(id) as PetRow | undefined;
    return row ? this.toPet(row) : null;
  }

  /**
   * セッションIDでペットを取得
   *
   * @param sessionId - セッションID
   * @returns ペットオブジェクト、存在しない場合はnull
   */
  getPetBySessionId(sessionId: string): Pet | null {
    const stmt = this.db.prepare("SELECT * FROM pets WHERE session_id = ?");
    const row = stmt.get(sessionId) as PetRow | undefined;
    return row ? this.toPet(row) : null;
  }

  /**
   * 全てのペットを取得
   *
   * @returns ペットの配列
   */
  getAllPets(): Pet[] {
    const stmt = this.db.prepare("SELECT * FROM pets ORDER BY created_at DESC");
    const rows = stmt.all() as PetRow[];
    return rows.map(row => this.toPet(row));
  }

  /**
   * ペットを更新
   *
   * @param id - ペットID
   * @param updates - 更新するフィールド
   */
  updatePet(id: string, updates: UpdatePetInput): void {
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.level !== undefined) {
      fields.push("level = ?");
      values.push(updates.level);
    }
    if (updates.exp !== undefined) {
      fields.push("exp = ?");
      values.push(updates.exp);
    }
    if (updates.hp !== undefined) {
      fields.push("hp = ?");
      values.push(updates.hp);
    }
    if (updates.mood !== undefined) {
      fields.push("mood = ?");
      values.push(updates.mood);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(now);
    values.push(id);

    const stmt = this.db.prepare(
      `UPDATE pets SET ${fields.join(", ")} WHERE id = ?`
    );
    stmt.run(...values);
  }

  /**
   * セッションIDでペットを削除
   *
   * @param sessionId - セッションID
   */
  deletePetBySessionId(sessionId: string): void {
    const stmt = this.db.prepare("DELETE FROM pets WHERE session_id = ?");
    stmt.run(sessionId);
  }

  /**
   * データベース行をPetオブジェクトに変換
   */
  private toPet(row: PetRow): Pet {
    return {
      id: row.id,
      sessionId: row.session_id,
      species: row.species as PetSpecies,
      name: row.name,
      level: row.level,
      exp: row.exp,
      hp: row.hp,
      mood: row.mood as PetMood,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * petsテーブルからON DELETE CASCADEを除去するマイグレーション
   *
   * 既存DBのpetsテーブルにON DELETE CASCADEが付いている場合、
   * テーブル再作成（pets_new作成→データコピー→旧テーブル削除→リネーム）で対応する。
   * SQLiteはFKの変更をサポートしないためこの方法を取る。
   */
  private migratePetsRemoveCascade(): void {
    // petsテーブルのCREATE文を取得してCASCADEが含まれているか確認
    const tableInfo = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='pets'"
      )
      .get() as { sql: string } | undefined;

    if (!tableInfo?.sql.includes("ON DELETE CASCADE")) {
      return; // CASCADEなし、またはテーブルが存在しない場合はスキップ
    }

    console.log(
      "[DB] petsテーブルからON DELETE CASCADEを除去するマイグレーションを実行"
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pets_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        species TEXT NOT NULL,
        name TEXT,
        level INTEGER NOT NULL DEFAULT 1,
        exp INTEGER NOT NULL DEFAULT 0,
        hp INTEGER NOT NULL DEFAULT 100,
        mood TEXT NOT NULL DEFAULT 'happy',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      INSERT INTO pets_new SELECT * FROM pets;
      DROP TABLE pets;
      ALTER TABLE pets_new RENAME TO pets;
    `);
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
      playHours: JSON.parse(row.play_hours) as Record<string, number>,
      medals: JSON.parse(row.medals) as string[],
      deathPositions: JSON.parse(row.death_positions) as number[],
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

  /**
   * データベース接続を閉じる
   */
  close(): void {
    this.db.close();
  }
}

/** シングルトンインスタンス */
export const db = new SessionDatabase();
