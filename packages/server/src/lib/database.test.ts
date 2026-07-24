/**
 * SessionDatabase の profiles / repo_profile_links テーブルに対するCRUD・マイグレーションのテスト
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

describe("SessionDatabase - profiles / repo_profile_links", () => {
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
  // profiles CRUD
  // ============================================================

  describe("createProfile", () => {
    it("プロファイルを作成し、id/createdAt/updatedAtが付与される", () => {
      const profile = testDb.createProfile({
        name: "仕事Max",
        configDir: "/home/user/.claude-work",
      });
      expect(profile.id).toBeTruthy();
      expect(profile.name).toBe("仕事Max");
      expect(profile.configDir).toBe("/home/user/.claude-work");
      expect(typeof profile.createdAt).toBe("number");
      expect(typeof profile.updatedAt).toBe("number");
      expect(profile.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it("同名のプロファイルを作成すると例外が投げられる", () => {
      testDb.createProfile({
        name: "個人Max",
        configDir: "/home/user/.claude-personal",
      });
      expect(() =>
        testDb.createProfile({
          name: "個人Max",
          configDir: "/home/user/.claude-personal-2",
        })
      ).toThrow();
    });

    it("同一configDirのプロファイルを作成すると例外が投げられる", () => {
      testDb.createProfile({
        name: "First",
        configDir: "/home/user/.claude-shared",
      });
      // 別nameでも config_dir 重複は不可（隔離が破れるため）
      expect(() =>
        testDb.createProfile({
          name: "Second",
          configDir: "/home/user/.claude-shared",
        })
      ).toThrow();
    });
  });

  describe("listProfiles", () => {
    it("空の状態で空配列を返す", () => {
      expect(testDb.listProfiles()).toEqual([]);
    });

    it("作成したプロファイルが取得できる", () => {
      testDb.createProfile({
        name: "A",
        configDir: "/home/user/.claude-a",
      });
      testDb.createProfile({
        name: "B",
        configDir: "/home/user/.claude-b",
      });
      const list = testDb.listProfiles();
      expect(list).toHaveLength(2);
      expect(list.map(p => p.name).sort()).toEqual(["A", "B"]);
    });
  });

  describe("getProfile", () => {
    it("存在しないIDはnullを返す", () => {
      expect(testDb.getProfile("nonexistent")).toBeNull();
    });

    it("作成したプロファイルをIDで取得できる", () => {
      const created = testDb.createProfile({
        name: "X",
        configDir: "/home/user/.claude-x",
      });
      const fetched = testDb.getProfile(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("X");
      expect(fetched?.configDir).toBe("/home/user/.claude-x");
    });
  });

  describe("updateProfile", () => {
    it("name と configDir を更新できる", async () => {
      const created = testDb.createProfile({
        name: "Old",
        configDir: "/home/user/.claude-old",
      });
      // updatedAt が変わることを保証するため少し待機
      await new Promise(resolve => setTimeout(resolve, 5));
      const updated = testDb.updateProfile(created.id, {
        name: "New",
        configDir: "/home/user/.claude-new",
      });
      expect(updated.name).toBe("New");
      expect(updated.configDir).toBe("/home/user/.claude-new");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it("undefined のフィールドはスキップされる", () => {
      const created = testDb.createProfile({
        name: "Keep",
        configDir: "/home/user/.claude-keep",
      });
      const updated = testDb.updateProfile(created.id, {
        name: "Renamed",
      });
      expect(updated.name).toBe("Renamed");
      expect(updated.configDir).toBe("/home/user/.claude-keep");
    });

    it("存在しないIDの更新は例外を投げる", () => {
      expect(() =>
        testDb.updateProfile("nonexistent", { name: "X" })
      ).toThrow();
    });

    it("既存と同じconfigDirへの更新は例外を投げる", () => {
      testDb.createProfile({
        name: "A",
        configDir: "/home/user/.claude-A",
      });
      const b = testDb.createProfile({
        name: "B",
        configDir: "/home/user/.claude-B",
      });
      // BのconfigDirを A と同じに更新しようとして失敗
      expect(() =>
        testDb.updateProfile(b.id, { configDir: "/home/user/.claude-A" })
      ).toThrow();
    });
  });

  describe("deleteProfile", () => {
    it("プロファイルを削除する", () => {
      const created = testDb.createProfile({
        name: "Del",
        configDir: "/home/user/.claude-del",
      });
      testDb.deleteProfile(created.id);
      expect(testDb.getProfile(created.id)).toBeNull();
    });

    it("存在しないIDの削除はno-op", () => {
      expect(() => testDb.deleteProfile("nonexistent")).not.toThrow();
    });
  });

  // ============================================================
  // repo_profile_links CRUD
  // ============================================================

  describe("setRepoProfileLink / getRepoProfileLink", () => {
    it("リポジトリとプロファイルを紐付け、取得できる", () => {
      const profile = testDb.createProfile({
        name: "P1",
        configDir: "/home/user/.claude-p1",
      });
      testDb.setRepoProfileLink("/home/user/repos/foo", profile.id);
      const link = testDb.getRepoProfileLink("/home/user/repos/foo");
      expect(link).not.toBeNull();
      expect(link?.repoPath).toBe("/home/user/repos/foo");
      expect(link?.profileId).toBe(profile.id);
      expect(typeof link?.updatedAt).toBe("number");
    });

    it("存在しないリポジトリパスはnullを返す", () => {
      expect(testDb.getRepoProfileLink("/nonexistent/path")).toBeNull();
    });

    it("UPSERT: 同じリポジトリパスを再度setすると上書きされる", () => {
      const profileA = testDb.createProfile({
        name: "A",
        configDir: "/home/user/.claude-a",
      });
      const profileB = testDb.createProfile({
        name: "B",
        configDir: "/home/user/.claude-b",
      });
      testDb.setRepoProfileLink("/home/user/repos/bar", profileA.id);
      testDb.setRepoProfileLink("/home/user/repos/bar", profileB.id);
      const link = testDb.getRepoProfileLink("/home/user/repos/bar");
      expect(link?.profileId).toBe(profileB.id);
    });
  });

  describe("removeRepoProfileLink", () => {
    it("紐付けを削除する", () => {
      const profile = testDb.createProfile({
        name: "R",
        configDir: "/home/user/.claude-r",
      });
      testDb.setRepoProfileLink("/home/user/repos/baz", profile.id);
      testDb.removeRepoProfileLink("/home/user/repos/baz");
      expect(testDb.getRepoProfileLink("/home/user/repos/baz")).toBeNull();
    });

    it("存在しないリポジトリパスの削除はno-op", () => {
      expect(() => testDb.removeRepoProfileLink("/nonexistent")).not.toThrow();
    });
  });

  // ============================================================
  // CASCADE削除
  // ============================================================

  describe("CASCADE: deleteProfile", () => {
    it("プロファイル削除時に紐付けレコードも自動削除される", () => {
      const profile = testDb.createProfile({
        name: "Cascade",
        configDir: "/home/user/.claude-cascade",
      });
      testDb.setRepoProfileLink("/home/user/repos/r1", profile.id);
      testDb.setRepoProfileLink("/home/user/repos/r2", profile.id);

      testDb.deleteProfile(profile.id);

      expect(testDb.getRepoProfileLink("/home/user/repos/r1")).toBeNull();
      expect(testDb.getRepoProfileLink("/home/user/repos/r2")).toBeNull();
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
        // profile_id 列が追加され、既存rowは null
        expect(sessions[0]?.profileId).toBeNull();

        // 新テーブルが操作可能
        const profile = upgraded.createProfile({
          name: "PostMigrate",
          configDir: "/home/user/.claude-postmigrate",
        });
        upgraded.setRepoProfileLink("/legacy/path", profile.id);
        expect(upgraded.getRepoProfileLink("/legacy/path")?.profileId).toBe(
          profile.id
        );
      } finally {
        upgraded.close();
      }
    });
  });

  // ============================================================
  // sessions.profile_id 永続化
  // ============================================================

  describe("upsertSession: profile_id 永続化", () => {
    it("profileId付きでupsertすると getSessionByWorktreePath で復元できる", () => {
      const profile = testDb.createProfile({
        name: "Persist",
        configDir: "/home/user/.claude-persist",
      });
      testDb.upsertSession({
        id: "sess-1",
        worktreeId: "wt-1",
        worktreePath: "/repo/work",
        repoPath: "/repo",
        status: "active",
        profileId: profile.id,
      });

      const restored = testDb.getSessionByWorktreePath("/repo/work");
      expect(restored?.profileId).toBe(profile.id);
    });

    it("profileId 省略時は null として保存される", () => {
      testDb.upsertSession({
        id: "sess-2",
        worktreeId: "wt-2",
        worktreePath: "/repo/work2",
        status: "active",
      });

      const restored = testDb.getSessionByWorktreePath("/repo/work2");
      expect(restored?.profileId).toBeNull();
    });

    it("upsert 時に profileId が更新される (null → id, id → null)", () => {
      const profile = testDb.createProfile({
        name: "Switch",
        configDir: "/home/user/.claude-switch",
      });
      // 初回: null
      testDb.upsertSession({
        id: "sess-3",
        worktreeId: "wt-3",
        worktreePath: "/repo/work3",
        status: "active",
      });
      expect(
        testDb.getSessionByWorktreePath("/repo/work3")?.profileId
      ).toBeNull();

      // 2回目: profile.id を上書き
      testDb.upsertSession({
        id: "sess-3",
        worktreeId: "wt-3",
        worktreePath: "/repo/work3",
        status: "active",
        profileId: profile.id,
      });
      expect(testDb.getSessionByWorktreePath("/repo/work3")?.profileId).toBe(
        profile.id
      );

      // 3回目: 明示的に null へ戻す
      testDb.upsertSession({
        id: "sess-3",
        worktreeId: "wt-3",
        worktreePath: "/repo/work3",
        status: "active",
        profileId: null,
      });
      expect(
        testDb.getSessionByWorktreePath("/repo/work3")?.profileId
      ).toBeNull();
    });
  });

  // ============================================================
  // sessions.last_diagram_path 永続化（図解キャンバスの復元用）
  // ============================================================

  describe("updateSessionLastDiagram / lastDiagramPath 永続化", () => {
    it("upsert直後は lastDiagramPath が null", () => {
      testDb.upsertSession({
        id: "sess-diag-1",
        worktreeId: "wt-diag-1",
        worktreePath: "/repo/diag1",
        status: "active",
      });

      expect(
        testDb.getSessionByWorktreePath("/repo/diag1")?.lastDiagramPath
      ).toBeNull();
    });

    it("updateSessionLastDiagram で relPath を保存し、getSession/getSessionByWorktreePath 両方から読める", () => {
      testDb.upsertSession({
        id: "sess-diag-2",
        worktreeId: "wt-diag-2",
        worktreePath: "/repo/diag2",
        status: "active",
      });

      testDb.updateSessionLastDiagram(
        "sess-diag-2",
        ".claude/diagrams/a.diagram.html"
      );

      expect(testDb.getSession("sess-diag-2")?.lastDiagramPath).toBe(
        ".claude/diagrams/a.diagram.html"
      );
      expect(
        testDb.getSessionByWorktreePath("/repo/diag2")?.lastDiagramPath
      ).toBe(".claude/diagrams/a.diagram.html");
    });

    it("別の図を開くと上書きされる（最後に開いたものだけを保持する）", () => {
      testDb.upsertSession({
        id: "sess-diag-3",
        worktreeId: "wt-diag-3",
        worktreePath: "/repo/diag3",
        status: "active",
      });

      testDb.updateSessionLastDiagram(
        "sess-diag-3",
        ".claude/diagrams/a.diagram.html"
      );
      testDb.updateSessionLastDiagram(
        "sess-diag-3",
        ".claude/diagrams/b.diagram.html"
      );

      expect(testDb.getSession("sess-diag-3")?.lastDiagramPath).toBe(
        ".claude/diagrams/b.diagram.html"
      );
    });

    it("null を渡すと「最後に開いた図なし」の状態に戻せる", () => {
      testDb.upsertSession({
        id: "sess-diag-4",
        worktreeId: "wt-diag-4",
        worktreePath: "/repo/diag4",
        status: "active",
      });

      testDb.updateSessionLastDiagram(
        "sess-diag-4",
        ".claude/diagrams/a.diagram.html"
      );
      testDb.updateSessionLastDiagram("sess-diag-4", null);

      expect(testDb.getSession("sess-diag-4")?.lastDiagramPath).toBeNull();
    });

    it("存在しないsessionIdを指定しても例外を投げない（no-op）", () => {
      expect(() =>
        testDb.updateSessionLastDiagram(
          "no-such-session",
          ".claude/diagrams/a.diagram.html"
        )
      ).not.toThrow();
    });

    it("既存DBの旧 prefix だけを null にし、新 prefix と元の null は維持する", () => {
      const migrationPath = path.join(tmpDir, "diagram-prefix-migration.db");
      const seed = new SessionDatabase(migrationPath);
      for (const [id, worktreePath] of [
        ["legacy", "/repo/legacy"],
        ["current", "/repo/current"],
        ["empty", "/repo/empty"],
      ]) {
        seed.upsertSession({
          id,
          worktreeId: `wt-${id}`,
          worktreePath,
          status: "active",
        });
      }
      seed.updateSessionLastDiagram(
        "legacy",
        "docs/diagrams/legacy.diagram.html"
      );
      seed.updateSessionLastDiagram(
        "current",
        ".claude/diagrams/current.diagram.html"
      );
      seed.close();

      const migrated = new SessionDatabase(migrationPath);
      try {
        expect(migrated.getSession("legacy")?.lastDiagramPath).toBeNull();
        expect(migrated.getSession("current")?.lastDiagramPath).toBe(
          ".claude/diagrams/current.diagram.html"
        );
        expect(migrated.getSession("empty")?.lastDiagramPath).toBeNull();
      } finally {
        migrated.close();
      }

      const remigrated = new SessionDatabase(migrationPath);
      try {
        expect(remigrated.getSession("legacy")?.lastDiagramPath).toBeNull();
        expect(remigrated.getSession("current")?.lastDiagramPath).toBe(
          ".claude/diagrams/current.diagram.html"
        );
        expect(remigrated.getSession("empty")?.lastDiagramPath).toBeNull();
      } finally {
        remigrated.close();
      }
    });

    it("last_diagram_path列が無い既存DBでもマイグレーションで追加され、既存セッションは保持される", () => {
      const legacyPath = path.join(tmpDir, "legacy-diagram.db");
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
          "s-legacy-diagram",
          "wt-legacy-diagram",
          "/legacy/diagram-path",
          "idle",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z"
        );
      legacy.close();

      const upgraded = new SessionDatabase(legacyPath);
      try {
        const restored = upgraded.getSessionByWorktreePath(
          "/legacy/diagram-path"
        );
        expect(restored).not.toBeNull();
        expect(restored?.lastDiagramPath).toBeNull();

        // マイグレーション後のDBでも新規に更新できる
        upgraded.updateSessionLastDiagram(
          "s-legacy-diagram",
          ".claude/diagrams/legacy.diagram.html"
        );
        expect(
          upgraded.getSessionByWorktreePath("/legacy/diagram-path")
            ?.lastDiagramPath
        ).toBe(".claude/diagrams/legacy.diagram.html");
      } finally {
        upgraded.close();
      }
    });
  });

  // ============================================================
  // replaceSession (atomic delete + upsert for restartSession)
  // ============================================================

  describe("replaceSession", () => {
    it("旧セッションを削除しつつ新IDで挿入する (atomic)", () => {
      // 旧セッションを upsert
      testDb.upsertSession({
        id: "old-id",
        worktreeId: "wt-1",
        worktreePath: "/repo/work",
        repoPath: "/repo",
        status: "active",
      });
      expect(testDb.getAllSessions()).toHaveLength(1);

      // replaceSession で新IDに切替
      testDb.replaceSession("old-id", {
        id: "new-id",
        worktreeId: "wt-1",
        worktreePath: "/repo/work",
        repoPath: "/repo",
        status: "active",
      });

      const sessions = testDb.getAllSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("new-id");
      // 旧IDではもう取得できない
      expect(testDb.getAllSessions().some(s => s.id === "old-id")).toBe(false);
    });

    it("既存セッションのmessagesも CASCADE で削除される", () => {
      testDb.upsertSession({
        id: "old-id",
        worktreeId: "wt-1",
        worktreePath: "/repo/work",
        repoPath: "/repo",
        status: "active",
      });
      testDb.addMessage({
        id: "msg-1",
        sessionId: "old-id",
        role: "user",
        content: "hello",
        type: "text",
        timestamp: new Date(),
      });
      expect(testDb.getMessagesBySession("old-id")).toHaveLength(1);

      testDb.replaceSession("old-id", {
        id: "new-id",
        worktreeId: "wt-1",
        worktreePath: "/repo/work",
        repoPath: "/repo",
        status: "active",
      });

      // 旧IDのmessagesはCASCADEで消える
      expect(testDb.getMessagesBySession("old-id")).toHaveLength(0);
      // 新IDにmessagesは引き継がれない
      expect(testDb.getMessagesBySession("new-id")).toHaveLength(0);
    });
  });
});

// ============================================================
// mcp_servers URL マイグレーション (#203 追補)
// ============================================================

describe("SessionDatabase - mcp_servers URL マイグレーション", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ark-db-mig-test-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function insertMcpServerRow(url: string): void {
    // 旧バージョンで保存されたレコードを再現する (raw SQLite で直接 INSERT)
    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO mcp_servers
           (id, name, url, authorization_endpoint, token_endpoint, client_id,
            scopes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "atlassian-test01",
        "Atlassian #1",
        url,
        "https://auth.atlassian.com/authorize",
        "https://auth.atlassian.com/oauth/token",
        "client-x",
        "[]",
        Date.now(),
        Date.now()
      );
    raw.close();
  }

  it("旧 /v1/sse の保存済み URL が起動時に /v1/mcp へ正規化される", () => {
    // スキーマだけ作って閉じる → 旧 URL レコードを注入 → 再オープンで migration
    new SessionDatabase(dbPath).close();
    insertMcpServerRow("https://mcp.atlassian.com/v1/sse");

    const db2 = new SessionDatabase(dbPath);
    try {
      const server = db2.getMcpServer("atlassian-test01");
      expect(server?.url).toBe("https://mcp.atlassian.com/v1/mcp");
    } finally {
      db2.close();
    }
  });

  it("既に /v1/mcp のレコードはそのまま (冪等)", () => {
    new SessionDatabase(dbPath).close();
    insertMcpServerRow("https://mcp.atlassian.com/v1/mcp");

    const db2 = new SessionDatabase(dbPath);
    try {
      expect(db2.getMcpServer("atlassian-test01")?.url).toBe(
        "https://mcp.atlassian.com/v1/mcp"
      );
    } finally {
      db2.close();
    }
  });

  it("無関係な URL のレコードには触れない", () => {
    new SessionDatabase(dbPath).close();
    insertMcpServerRow("https://mcp.linear.app/sse");

    const db2 = new SessionDatabase(dbPath);
    try {
      expect(db2.getMcpServer("atlassian-test01")?.url).toBe(
        "https://mcp.linear.app/sse"
      );
    } finally {
      db2.close();
    }
  });
});
