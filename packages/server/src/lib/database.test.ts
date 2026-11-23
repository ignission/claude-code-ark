/**
 * SessionDatabase の CRUD・マイグレーションのテスト
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

describe("SessionDatabase", () => {
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
  // マイグレーション安全性
  // ============================================================

  describe("マイグレーション: 旧スキーマの既存DB", () => {
    it("既存のsessionsデータを保持したまま初期化される", () => {
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
      } finally {
        upgraded.close();
      }
    });
  });

  describe("撤去したプロファイル切替の表", () => {
    it("既存DBの表と行は消さずに残す", () => {
      const legacyPath = path.join(tmpDir, "with-profiles.db");
      const legacy = new Database(legacyPath);
      legacy.exec(`
        CREATE TABLE profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          config_dir TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      legacy
        .prepare(
          "INSERT INTO profiles (id, name, config_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run("p1", "work", "/home/user/.claude-work", 1, 1);
      legacy.close();

      new SessionDatabase(legacyPath).close();

      const reopened = new Database(legacyPath);
      try {
        const rows = reopened.prepare("SELECT id FROM profiles").all();
        expect(rows).toEqual([{ id: "p1" }]);
      } finally {
        reopened.close();
      }
    });

    it("新しいDBには作らない", () => {
      testDb.close();
      const raw = new Database(dbPath);
      try {
        const tables = raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%profile%'"
          )
          .all();
        expect(tables).toEqual([]);
      } finally {
        raw.close();
      }
      testDb = new SessionDatabase(dbPath);
    });
  });

  // ============================================================
  // sessions.parent_worktree_path (task_start で起こした子の親)
  // ============================================================

  describe("upsertSession: parentWorktreePath 永続化", () => {
    it("親つきで保存すると読み戻せ、省略すれば null", () => {
      testDb.upsertSession({
        id: "child",
        worktreeId: "wt-child",
        worktreePath: "/repo-fix",
        repoPath: "/repo",
        status: "active",
        parentWorktreePath: "/repo",
      });
      testDb.upsertSession({
        id: "plain",
        worktreeId: "wt-plain",
        worktreePath: "/repo-plain",
        status: "active",
      });
      expect(
        testDb.getSessionByWorktreePath("/repo-fix")?.parentWorktreePath
      ).toBe("/repo");
      expect(
        testDb.getSessionByWorktreePath("/repo-plain")?.parentWorktreePath
      ).toBeNull();
    });

    it("親を渡さない upsert (OS の再起動後の session:start など) では親を消さない", () => {
      const base = {
        worktreeId: "wt",
        worktreePath: "/repo-fix",
        status: "active" as const,
      };
      testDb.upsertSession({ id: "a", ...base, parentWorktreePath: "/repo" });
      testDb.upsertSession({ id: "b", ...base });
      expect(
        testDb.getSessionByWorktreePath("/repo-fix")?.parentWorktreePath
      ).toBe("/repo");
    });

    it("replaceSession (再起動) で親を渡せば引き継がれる", () => {
      testDb.upsertSession({
        id: "old",
        worktreeId: "wt",
        worktreePath: "/repo-fix",
        status: "active",
        parentWorktreePath: "/repo",
      });
      testDb.replaceSession("old", {
        id: "new",
        worktreeId: "wt",
        worktreePath: "/repo-fix",
        status: "active",
        parentWorktreePath: "/repo",
      });
      const restored = testDb.getSessionByWorktreePath("/repo-fix");
      expect(restored?.id).toBe("new");
      expect(restored?.parentWorktreePath).toBe("/repo");
    });

    it("親のリポジトリも保存でき、親を渡さない upsert では消さず、再起動で引き継ぐ", () => {
      const base = {
        worktreeId: "wt",
        worktreePath: "/other-fix",
        repoPath: "/other",
        status: "active" as const,
      };
      testDb.upsertSession({
        id: "a",
        ...base,
        parentWorktreePath: "/repo",
        parentRepoPath: "/repo",
      });
      testDb.upsertSession({ id: "b", ...base });
      expect(
        testDb.getSessionByWorktreePath("/other-fix")?.parentRepoPath
      ).toBe("/repo");
      testDb.replaceSession("b", {
        id: "c",
        ...base,
        parentWorktreePath: "/repo",
        parentRepoPath: "/repo",
      });
      expect(
        testDb.getSessionByWorktreePath("/other-fix")?.parentRepoPath
      ).toBe("/repo");
      testDb.upsertSession({ id: "plain", ...base, worktreePath: "/plain" });
      expect(
        testDb.getSessionByWorktreePath("/plain")?.parentRepoPath
      ).toBeNull();
    });
  });

  // ============================================================
  // sessions.last_diagram_path 永続化（図解キャンバスの復元用）
  // ============================================================

  describe("updateSessionLastDiagram / lastDiagramPath 永続化", () => {
    it("一致する lastDiagramPath だけを単一条件付き更新で null にする", () => {
      for (const [id, relPath] of [
        ["matched", ".claude/diagrams/a.diagram.html"],
        ["different", ".claude/diagrams/b.diagram.html"],
        ["already-null", null],
      ] as const) {
        testDb.upsertSession({
          id,
          worktreeId: `wt-${id}`,
          worktreePath: `/repo/${id}`,
          status: "active",
        });
        if (relPath !== null) testDb.updateSessionLastDiagram(id, relPath);
      }

      expect(
        testDb.clearSessionLastDiagramIfMatches(
          "matched",
          ".claude/diagrams/a.diagram.html"
        )
      ).toBe(true);
      expect(testDb.getSession("matched")?.lastDiagramPath).toBeNull();

      expect(
        testDb.clearSessionLastDiagramIfMatches(
          "different",
          ".claude/diagrams/a.diagram.html"
        )
      ).toBe(false);
      expect(testDb.getSession("different")?.lastDiagramPath).toBe(
        ".claude/diagrams/b.diagram.html"
      );

      expect(
        testDb.clearSessionLastDiagramIfMatches(
          "already-null",
          ".claude/diagrams/a.diagram.html"
        )
      ).toBe(false);
      expect(testDb.getSession("already-null")?.lastDiagramPath).toBeNull();
      expect(
        testDb.clearSessionLastDiagramIfMatches(
          "missing",
          ".claude/diagrams/a.diagram.html"
        )
      ).toBe(false);
    });

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

  describe("screens", () => {
    const input = {
      name: "ビルド VM",
      sshHost: "build.example.internal",
      sshPort: 2222,
      sshUser: "user",
      vncHost: "127.0.0.1",
      vncPort: 5900,
      vncUser: "user",
      vncPassword: "secret",
    };

    it("作成した画面を一覧・取得でき、パスワードは載らない", () => {
      const created = testDb.createScreen(input);
      expect(created).toMatchObject({
        name: "ビルド VM",
        sshHost: "build.example.internal",
        sshPort: 2222,
        sshUser: "user",
        vncHost: "127.0.0.1",
        vncPort: 5900,
        vncUser: "user",
      });
      expect(created).not.toHaveProperty("vncPassword");
      expect(testDb.listScreens()).toEqual([created]);
      expect(testDb.getScreen(created.id)).toEqual(created);
      expect(testDb.getScreen("nope")).toBeNull();
    });

    it("getScreenRecord はパスワードを含む", () => {
      const created = testDb.createScreen(input);
      expect(testDb.getScreenRecord(created.id)).toMatchObject({
        id: created.id,
        vncPassword: "secret",
      });
      expect(testDb.getScreenRecord("nope")).toBeNull();
    });

    it("同名の画面は作成できない", () => {
      testDb.createScreen(input);
      expect(() => testDb.createScreen(input)).toThrow();
    });

    it("部分更新で指定した列だけ変わり、パスワード省略時は保持される", () => {
      const created = testDb.createScreen(input);
      const updated = testDb.updateScreen(created.id, {
        name: "別名",
        vncPort: 5901,
      });
      expect(updated.name).toBe("別名");
      expect(updated.vncPort).toBe(5901);
      expect(updated.sshHost).toBe("build.example.internal");
      expect(testDb.getScreenRecord(created.id)?.vncPassword).toBe("secret");

      testDb.updateScreen(created.id, { vncPassword: "new" });
      expect(testDb.getScreenRecord(created.id)?.vncPassword).toBe("new");
    });

    it("存在しない id の更新は例外", () => {
      expect(() => testDb.updateScreen("nope", { name: "x" })).toThrow(
        /Screen not found/
      );
    });

    it("削除すると一覧から消える", () => {
      const created = testDb.createScreen(input);
      testDb.deleteScreen(created.id);
      expect(testDb.listScreens()).toEqual([]);
    });
  });
});
