/**
 * SessionDatabase の account_profiles / repo_account_links テーブルに対するCRUD・マイグレーションのテスト
 *
 * - 各テストごとに一時ディレクトリにDBファイルを作成して隔離
 * - シングルトン `db` は使わず、`SessionDatabase` をテスト用パスで直接生成
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionDatabase } from "./database.js";

describe("SessionDatabase - account_profiles / repo_account_links", () => {
  let tmpDir: string;
  let dbPath: string;
  let testDb: SessionDatabase;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ark-db-test-"));
    dbPath = path.join(tmpDir, "test.db");
    testDb = new SessionDatabase(dbPath);
  });

  afterEach(async () => {
    testDb.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // account_profiles CRUD
  // ============================================================

  describe("createAccountProfile", () => {
    it("プロファイルを作成し、id/createdAt/updatedAtが付与される", () => {
      const profile = testDb.createAccountProfile({
        name: "仕事Max",
        configDir: "/home/user/.claude-work",
      });
      expect(profile.id).toBeTruthy();
      expect(profile.name).toBe("仕事Max");
      expect(profile.configDir).toBe("/home/user/.claude-work");
      expect(profile.status).toBe("pending");
      expect(typeof profile.createdAt).toBe("number");
      expect(typeof profile.updatedAt).toBe("number");
      expect(profile.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it("同名のプロファイルを作成すると例外が投げられる", () => {
      testDb.createAccountProfile({
        name: "個人Max",
        configDir: "/home/user/.claude-personal",
      });
      expect(() =>
        testDb.createAccountProfile({
          name: "個人Max",
          configDir: "/home/user/.claude-personal-2",
        })
      ).toThrow();
    });
  });

  describe("listAccountProfiles", () => {
    it("空の状態で空配列を返す", () => {
      expect(testDb.listAccountProfiles()).toEqual([]);
    });

    it("作成したプロファイルが取得できる", () => {
      testDb.createAccountProfile({
        name: "A",
        configDir: "/home/user/.claude-a",
      });
      testDb.createAccountProfile({
        name: "B",
        configDir: "/home/user/.claude-b",
      });
      const list = testDb.listAccountProfiles();
      expect(list).toHaveLength(2);
      expect(list.map(p => p.name).sort()).toEqual(["A", "B"]);
    });
  });

  describe("getAccountProfile", () => {
    it("存在しないIDはnullを返す", () => {
      expect(testDb.getAccountProfile("nonexistent")).toBeNull();
    });

    it("作成したプロファイルをIDで取得できる", () => {
      const created = testDb.createAccountProfile({
        name: "X",
        configDir: "/home/user/.claude-x",
      });
      const fetched = testDb.getAccountProfile(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("X");
      expect(fetched?.configDir).toBe("/home/user/.claude-x");
    });
  });

  describe("updateAccountProfile", () => {
    it("name と configDir を更新できる", async () => {
      const created = testDb.createAccountProfile({
        name: "Old",
        configDir: "/home/user/.claude-old",
      });
      // updatedAt が変わることを保証するため少し待機
      await new Promise(resolve => setTimeout(resolve, 5));
      const updated = testDb.updateAccountProfile(created.id, {
        name: "New",
        configDir: "/home/user/.claude-new",
      });
      expect(updated.name).toBe("New");
      expect(updated.configDir).toBe("/home/user/.claude-new");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it("undefined のフィールドはスキップされる", () => {
      const created = testDb.createAccountProfile({
        name: "Keep",
        configDir: "/home/user/.claude-keep",
      });
      const updated = testDb.updateAccountProfile(created.id, {
        name: "Renamed",
      });
      expect(updated.name).toBe("Renamed");
      expect(updated.configDir).toBe("/home/user/.claude-keep");
    });

    it("存在しないIDの更新は例外を投げる", () => {
      expect(() =>
        testDb.updateAccountProfile("nonexistent", { name: "X" })
      ).toThrow();
    });
  });

  describe("markAccountAuthenticated", () => {
    it("status を authenticated に更新する", () => {
      const created = testDb.createAccountProfile({
        name: "Auth",
        configDir: "/home/user/.claude-auth",
      });
      expect(created.status).toBe("pending");
      testDb.markAccountAuthenticated(created.id);
      const refetched = testDb.getAccountProfile(created.id);
      expect(refetched?.status).toBe("authenticated");
    });
  });

  describe("deleteAccountProfile", () => {
    it("プロファイルを削除する", () => {
      const created = testDb.createAccountProfile({
        name: "Del",
        configDir: "/home/user/.claude-del",
      });
      testDb.deleteAccountProfile(created.id);
      expect(testDb.getAccountProfile(created.id)).toBeNull();
    });

    it("存在しないIDの削除はno-op", () => {
      expect(() => testDb.deleteAccountProfile("nonexistent")).not.toThrow();
    });
  });

  // ============================================================
  // repo_account_links CRUD
  // ============================================================

  describe("setRepoAccountLink / getRepoAccountLink", () => {
    it("リポジトリとプロファイルを紐付け、取得できる", () => {
      const profile = testDb.createAccountProfile({
        name: "P1",
        configDir: "/home/user/.claude-p1",
      });
      testDb.setRepoAccountLink("/home/user/repos/foo", profile.id);
      const link = testDb.getRepoAccountLink("/home/user/repos/foo");
      expect(link).not.toBeNull();
      expect(link?.repoPath).toBe("/home/user/repos/foo");
      expect(link?.accountProfileId).toBe(profile.id);
      expect(typeof link?.updatedAt).toBe("number");
    });

    it("存在しないリポジトリパスはnullを返す", () => {
      expect(testDb.getRepoAccountLink("/nonexistent/path")).toBeNull();
    });

    it("UPSERT: 同じリポジトリパスを再度setすると上書きされる", () => {
      const profileA = testDb.createAccountProfile({
        name: "A",
        configDir: "/home/user/.claude-a",
      });
      const profileB = testDb.createAccountProfile({
        name: "B",
        configDir: "/home/user/.claude-b",
      });
      testDb.setRepoAccountLink("/home/user/repos/bar", profileA.id);
      testDb.setRepoAccountLink("/home/user/repos/bar", profileB.id);
      const link = testDb.getRepoAccountLink("/home/user/repos/bar");
      expect(link?.accountProfileId).toBe(profileB.id);
    });
  });

  describe("removeRepoAccountLink", () => {
    it("紐付けを削除する", () => {
      const profile = testDb.createAccountProfile({
        name: "R",
        configDir: "/home/user/.claude-r",
      });
      testDb.setRepoAccountLink("/home/user/repos/baz", profile.id);
      testDb.removeRepoAccountLink("/home/user/repos/baz");
      expect(testDb.getRepoAccountLink("/home/user/repos/baz")).toBeNull();
    });

    it("存在しないリポジトリパスの削除はno-op", () => {
      expect(() => testDb.removeRepoAccountLink("/nonexistent")).not.toThrow();
    });
  });

  // ============================================================
  // CASCADE削除
  // ============================================================

  describe("CASCADE: deleteAccountProfile", () => {
    it("プロファイル削除時に紐付けレコードも自動削除される", () => {
      const profile = testDb.createAccountProfile({
        name: "Cascade",
        configDir: "/home/user/.claude-cascade",
      });
      testDb.setRepoAccountLink("/home/user/repos/r1", profile.id);
      testDb.setRepoAccountLink("/home/user/repos/r2", profile.id);

      testDb.deleteAccountProfile(profile.id);

      expect(testDb.getRepoAccountLink("/home/user/repos/r1")).toBeNull();
      expect(testDb.getRepoAccountLink("/home/user/repos/r2")).toBeNull();
    });
  });

  // ============================================================
  // マイグレーション安全性
  // ============================================================

  describe("マイグレーション: 新テーブルが無い既存DB", () => {
    it("既存のsessionsデータを保持したまま新テーブルが作成される", () => {
      // 1. 旧スキーマだけのDBを直接作成（account_* テーブルなし）
      const legacyPath = path.join(tmpDir, "legacy.db");
      const legacy = new Database(legacyPath);
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          worktree_path TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'idle',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      legacy
        .prepare(
          `INSERT INTO sessions (id, worktree_id, worktree_path, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          "s-legacy",
          "wt-legacy",
          "/legacy/path",
          "idle",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z"
        );
      legacy.close();

      // 2. SessionDatabase でラップして initialize を走らせる
      const upgraded = new SessionDatabase(legacyPath);
      try {
        // 既存セッションが残っている
        const sessions = upgraded.getAllSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.id).toBe("s-legacy");

        // 新テーブルが操作可能
        const profile = upgraded.createAccountProfile({
          name: "PostMigrate",
          configDir: "/home/user/.claude-postmigrate",
        });
        upgraded.setRepoAccountLink("/legacy/path", profile.id);
        expect(
          upgraded.getRepoAccountLink("/legacy/path")?.accountProfileId
        ).toBe(profile.id);
      } finally {
        upgraded.close();
      }
    });
  });
});
