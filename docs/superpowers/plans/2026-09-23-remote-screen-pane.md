# リモート画面 (別 VM の画面共有) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ark のサイドバーから、SSH で届く別ホストの VNC 画面 (第一の対象は macOS の画面共有) を main 領域に全面表示して操作できるようにする。

**Architecture:** 画面の設定は SQLite の `screens` テーブルに置き、`profile:*` と同型の `screen:*` Socket.IO イベントで CRUD する。表示は `@novnc/novnc` の `RFB` を React 部品 (`ScreenPane`) から直接使い、WebSocket は Ark サーバの `/screen/:id/ws` に繋ぐ。サーバは upgrade ごとに `ssh -W <vncHost>:<vncPort>` を子プロセスで起こし、stdio と WebSocket を直結する (`screen-bridge.ts`)。websockify もローカルポートも使わない。

**Tech Stack:** TypeScript / Express + `ws` (サーバ) / React 19 + `@novnc/novnc` 1.7 (web) / better-sqlite3 / vitest

設計文書: `docs/superpowers/specs/2026-09-23-remote-screen-pane-design.md`

## Global Constraints

- VM のアドレス・ユーザー名・パスワードをコード・テスト・コメント・コミットメッセージのどこにも書かない (テストの値は `example.internal` / `user` などの架空値)
- 共有型 `Screen` に `vncPassword` を**含めない**。パスワードは `screen:credentials` の callback だけで配る
- 子プロセスは `vi.mock("node:child_process")` でモックする (`.claude/rules/backend-testing.md`)。実 ssh を起動するテストは書かない
- web のテストは `// @vitest-environment jsdom` + `createRoot` + `act` (testing-library は無い)。既存の `SessionSidebar.test.tsx` の型に合わせる
- 一度開いた画面は `display:none` で切り替え、再マウント (再接続) しない (`.claude/rules/frontend-codegen.md`)
- ssh の引数はすべて配列で渡す (`spawn("ssh", args)`)。`sshHost` / `sshUser` / `vncHost` は `-` で始まる値を拒否する (オプション注入の防止)
- コミットメッセージは日本語。`Co-Authored-By` は付けない
- `pnpm check` (biome + tsc -b) と `pnpm test` を各タスクの最後に通す

---

## ファイル構成

| 区分 | パス | 責務 |
|---|---|---|
| 作成 | `packages/server/src/lib/screen-input.ts` | 入力値の検証 (純粋関数) |
| 作成 | `packages/server/src/lib/screen-input.test.ts` | 同上のテスト |
| 作成 | `packages/server/src/lib/screen-bridge.ts` | WebSocket ↔ `ssh -W` の直結 |
| 作成 | `packages/server/src/lib/screen-bridge.test.ts` | 同上のテスト (spawn をモック) |
| 変更 | `packages/shared/src/types.ts` | `Screen` / `ScreenInput` / `screen:*` イベント |
| 変更 | `packages/server/src/lib/database.ts` | `screens` テーブルと CRUD |
| 変更 | `packages/server/src/lib/database.test.ts` | `screens` の CRUD テスト |
| 変更 | `packages/server/src/index.ts` | `screen:*` ハンドラ、`/screen/:id/ws` の upgrade、停止処理 |
| 変更 | `packages/server/package.json` | `ws` / `@types/ws` |
| 変更 | `packages/web/package.json` | `@novnc/novnc` |
| 作成 | `packages/web/src/types/novnc.d.ts` | 使う範囲だけの型宣言 |
| 作成 | `packages/web/src/lib/auth-token.ts` | URL の token 取得と `/screen` WebSocket URL の組み立て |
| 作成 | `packages/web/src/lib/auth-token.test.ts` | 同上のテスト |
| 作成 | `packages/web/src/components/ScreenPane.tsx` | RFB を使う画面部品 |
| 作成 | `packages/web/src/components/ScreenPane.test.tsx` | 同上のテスト (`@novnc/novnc` をモック) |
| 作成 | `packages/web/src/components/ScreenManagerDialog.tsx` | 画面の管理ダイアログ |
| 作成 | `packages/web/src/components/ScreenManagerDialog.test.tsx` | 同上のテスト |
| 変更 | `packages/web/src/hooks/useSocket.ts` | `screens` state と操作関数 |
| 変更 | `packages/web/src/components/SessionSidebar.tsx` | 画面メニュー (Monitor アイコン) |
| 変更 | `packages/web/src/components/SessionSidebar.test.tsx` | 同上のテスト |
| 変更 | `packages/web/src/pages/Dashboard.tsx` | `"screen:<id>"` の選択と全面表示 |
| 変更 | `packages/web/src/components/MobileLayout.tsx` | モバイルの画面タブ |
| 変更 | `packages/web/vite.config.ts` | `/screen` の dev proxy |
| 変更 | `CLAUDE.md` | 機能表とイベント表 |

---

### Task 1: 共有型と `screens` テーブル

**Files:**
- Modify: `packages/shared/src/types.ts` (`Profile` の直後 116 行付近、`ServerToClientEvents` 550 行付近、`ClientToServerEvents` 787 行付近)
- Modify: `packages/server/src/lib/database.ts` (`initialize()` の profiles ブロック直後 333 行付近、CRUD は `deleteProfile` の直後 779 行付近)
- Test: `packages/server/src/lib/database.test.ts`

**Interfaces:**
- Produces:
  - `Screen` / `ScreenInput` / `ScreenPatch` / `ScreenCredentials` (shared)
  - `SessionDatabase.listScreens(): Screen[]`
  - `SessionDatabase.getScreen(id): Screen | null`
  - `SessionDatabase.getScreenRecord(id): ScreenRecord | null` (パスワード込み。サーバ内部専用)
  - `SessionDatabase.createScreen(input: ScreenInput): Screen`
  - `SessionDatabase.updateScreen(id, patch: ScreenPatch): Screen`
  - `SessionDatabase.deleteScreen(id): void`

- [ ] **Step 1: 共有型を追加する**

`packages/shared/src/types.ts` の `Profile` インターフェースの直後に追加:

```ts
/**
 * リモート画面 (SSH 越しに届く VNC 画面)。
 * パスワードは含めない。`screen:credentials` の callback だけで配る
 */
export interface Screen {
  id: string;
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** SSH ホストから見た VNC ホスト。既定 127.0.0.1 */
  vncHost: string;
  vncPort: number;
  /** ARD 認証のユーザー名。標準 VNC 認証のホストでは空文字 */
  vncUser: string;
  createdAt: number;
  updatedAt: number;
}

/** 画面の作成入力 */
export interface ScreenInput {
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  vncHost: string;
  vncPort: number;
  vncUser: string;
  vncPassword: string;
}

/** 画面の部分更新。vncPassword は指定したときだけ更新する */
export type ScreenPatch = Partial<ScreenInput>;

/** noVNC の credentials に渡す値 */
export interface ScreenCredentials {
  username: string;
  password: string;
}
```

`ServerToClientEvents` の `"profile:error"` の直後に追加:

```ts
  // リモート画面
  "screen:list": (screens: Screen[]) => void;
  "screen:created": (screen: Screen) => void;
  "screen:updated": (screen: Screen) => void;
  "screen:deleted": (data: { id: string }) => void;
  "screen:error": (data: { message: string; code?: string }) => void;
```

`ClientToServerEvents` の `"profile:delete"` の直後に追加:

```ts
  // リモート画面
  "screen:list": () => void;
  "screen:create": (data: ScreenInput) => void;
  "screen:update": (data: { id: string } & ScreenPatch) => void;
  "screen:delete": (data: { id: string }) => void;
  /** 接続直前に 1 回だけ呼ぶ。未登録なら null */
  "screen:credentials": (
    id: string,
    callback: (creds: ScreenCredentials | null) => void
  ) => void;
```

- [ ] **Step 2: DB テストを書く**

`packages/server/src/lib/database.test.ts` の末尾 (最後の `});` の前) に追加:

```ts
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
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/database.test.ts`
Expected: FAIL (`createScreen is not a function`)

- [ ] **Step 4: テーブルと CRUD を実装する**

`packages/server/src/lib/database.ts` の import に `Screen, ScreenInput, ScreenPatch` を追加 (既存の `Profile` の import と同じ行)。

`initialize()` の `profiles_config_dir_unique` インデックス作成の直後に追加:

```ts
    // リモート画面 (SSH 越しの VNC)。vnc_password は平文で持つ
    // (単一ユーザー前提。data/ は gitignore 済み)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS screens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        ssh_host TEXT NOT NULL,
        ssh_port INTEGER NOT NULL,
        ssh_user TEXT NOT NULL,
        vnc_host TEXT NOT NULL,
        vnc_port INTEGER NOT NULL,
        vnc_user TEXT NOT NULL,
        vnc_password TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
```

`deleteProfile` の直後に追加:

```ts
  // ============================================================
  // リモート画面 CRUD
  // ============================================================

  private rowToScreenRecord(row: ScreenRow): ScreenRecord {
    return {
      id: row.id,
      name: row.name,
      sshHost: row.ssh_host,
      sshPort: row.ssh_port,
      sshUser: row.ssh_user,
      vncHost: row.vnc_host,
      vncPort: row.vnc_port,
      vncUser: row.vnc_user,
      vncPassword: row.vnc_password,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static stripScreenPassword(record: ScreenRecord): Screen {
    const { vncPassword: _password, ...screen } = record;
    return screen;
  }

  /** 登録済み画面を全件取得 (作成順)。パスワードは含めない */
  listScreens(): Screen[] {
    const rows = this.db
      .prepare("SELECT * FROM screens ORDER BY created_at ASC")
      .all() as ScreenRow[];
    return rows.map(row =>
      SessionDatabase.stripScreenPassword(this.rowToScreenRecord(row))
    );
  }

  /** パスワード込みの行。ブリッジと credentials 配布だけが使う */
  getScreenRecord(id: string): ScreenRecord | null {
    const row = this.db.prepare("SELECT * FROM screens WHERE id = ?").get(id) as
      | ScreenRow
      | undefined;
    return row ? this.rowToScreenRecord(row) : null;
  }

  getScreen(id: string): Screen | null {
    const record = this.getScreenRecord(id);
    return record ? SessionDatabase.stripScreenPassword(record) : null;
  }

  /** @throws name が既存と重複している場合 (UNIQUE 制約違反) */
  createScreen(input: ScreenInput): Screen {
    const id = nanoid();
    const now = Date.now();
    this.db
      .prepare(`
      INSERT INTO screens (id, name, ssh_host, ssh_port, ssh_user, vnc_host, vnc_port, vnc_user, vnc_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        input.name,
        input.sshHost,
        input.sshPort,
        input.sshUser,
        input.vncHost,
        input.vncPort,
        input.vncUser,
        input.vncPassword,
        now,
        now
      );
    const created = this.getScreen(id);
    if (!created) {
      throw new Error(`Failed to create screen: ${id}`);
    }
    return created;
  }

  /** undefined のフィールドはスキップ。vncPassword も指定時だけ更新 */
  updateScreen(id: string, patch: ScreenPatch): Screen {
    const columns: Array<[keyof ScreenPatch, string]> = [
      ["name", "name"],
      ["sshHost", "ssh_host"],
      ["sshPort", "ssh_port"],
      ["sshUser", "ssh_user"],
      ["vncHost", "vnc_host"],
      ["vncPort", "vnc_port"],
      ["vncUser", "vnc_user"],
      ["vncPassword", "vnc_password"],
    ];
    const setClauses: string[] = [];
    const params: Array<string | number> = [];
    for (const [key, column] of columns) {
      const value = patch[key];
      if (value !== undefined) {
        setClauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    setClauses.push("updated_at = ?");
    params.push(Date.now(), id);
    const result = this.db
      .prepare(`UPDATE screens SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...params);
    if (result.changes === 0) {
      throw new Error(`Screen not found: ${id}`);
    }
    const updated = this.getScreen(id);
    if (!updated) {
      throw new Error(`Screen not found after update: ${id}`);
    }
    return updated;
  }

  deleteScreen(id: string): void {
    this.db.prepare("DELETE FROM screens WHERE id = ?").run(id);
  }
```

ファイル上部の `SessionRow` / `MessageRow` の並びに行型を追加:

```ts
/** screens テーブルの行 */
interface ScreenRow {
  id: string;
  name: string;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  vnc_host: string;
  vnc_port: number;
  vnc_user: string;
  vnc_password: string;
  created_at: number;
  updated_at: number;
}

/** パスワード込みの画面。サーバ内部だけで使い、クライアントへは出さない */
export type ScreenRecord = Screen & { vncPassword: string };
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/database.test.ts`
Expected: PASS

- [ ] **Step 6: 型チェックとコミット**

Run: `pnpm check`
Expected: エラー 0

```bash
git add packages/shared/src/types.ts packages/server/src/lib/database.ts packages/server/src/lib/database.test.ts
git commit -m "feat(server): リモート画面の共有型と screens テーブルを追加"
```

---

### Task 2: 入力値の検証 (`screen-input.ts`)

**Files:**
- Create: `packages/server/src/lib/screen-input.ts`
- Test: `packages/server/src/lib/screen-input.test.ts`

**Interfaces:**
- Consumes: `ScreenInput` / `ScreenPatch` (Task 1)
- Produces:
  - `validateScreenInput(raw: unknown): ScreenValidation<ScreenInput>`
  - `validateScreenPatch(raw: unknown): ScreenValidation<ScreenPatch>`
  - `type ScreenValidation<T> = { ok: true; value: T } | { ok: false; message: string; code: string }`

- [ ] **Step 1: テストを書く**

```ts
import { describe, expect, it } from "vitest";
import { validateScreenInput, validateScreenPatch } from "./screen-input.js";

const valid = {
  name: " ビルド VM ",
  sshHost: "build.example.internal",
  sshPort: 2222,
  sshUser: "user",
  vncHost: "127.0.0.1",
  vncPort: 5900,
  vncUser: "user",
  vncPassword: "secret",
};

describe("validateScreenInput", () => {
  it("正常値は trim して返す", () => {
    const result = validateScreenInput(valid);
    expect(result).toEqual({
      ok: true,
      value: { ...valid, name: "ビルド VM" },
    });
  });

  it("vncHost / vncPort / vncUser は既定値で補う", () => {
    const { vncHost: _h, vncPort: _p, vncUser: _u, ...rest } = valid;
    const result = validateScreenInput({ ...rest, sshPort: "22" });
    expect(result).toEqual({
      ok: true,
      value: {
        ...rest,
        name: "ビルド VM",
        sshPort: 22,
        vncHost: "127.0.0.1",
        vncPort: 5900,
        vncUser: "",
      },
    });
  });

  it.each([
    [{ name: "" }, "invalid_name"],
    [{ sshHost: "" }, "invalid_host"],
    [{ sshHost: "-oProxyCommand=x" }, "invalid_host"],
    [{ sshHost: "a b" }, "invalid_host"],
    [{ vncHost: "-x" }, "invalid_host"],
    [{ sshUser: "" }, "invalid_user"],
    [{ sshUser: "-l" }, "invalid_user"],
    [{ sshPort: 0 }, "invalid_port"],
    [{ sshPort: 70000 }, "invalid_port"],
    [{ vncPort: "abc" }, "invalid_port"],
    [{ vncPassword: "" }, "invalid_password"],
  ])("%o は %s で拒否する", (override, code) => {
    const result = validateScreenInput({ ...valid, ...override });
    expect(result).toMatchObject({ ok: false, code });
  });

  it("オブジェクト以外は拒否する", () => {
    expect(validateScreenInput(null)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });
});

describe("validateScreenPatch", () => {
  it("指定したフィールドだけ検証して返す", () => {
    expect(validateScreenPatch({ name: " x ", vncPort: 5901 })).toEqual({
      ok: true,
      value: { name: "x", vncPort: 5901 },
    });
  });

  it("空の vncPassword は「変更しない」として落とす", () => {
    expect(validateScreenPatch({ vncPassword: "" })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("不正なフィールドがあれば拒否する", () => {
    expect(validateScreenPatch({ sshHost: "-bad" })).toMatchObject({
      ok: false,
      code: "invalid_host",
    });
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/screen-input.test.ts`
Expected: FAIL (モジュールが無い)

- [ ] **Step 3: 実装する**

```ts
/**
 * リモート画面の入力値検証。
 *
 * 値はそのまま `ssh` の引数になるので、ホスト名とユーザー名は
 * `-` 始まり (オプションに化ける) と空白・記号を拒否する。
 */

import type { ScreenInput, ScreenPatch } from "@ark/shared";

export type ScreenValidation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; code: string };

/** ホスト名 / IPv4。先頭の `-` は不可 */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** POSIX ユーザー名。先頭の `-` は不可 */
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

type Field = keyof ScreenInput;

function fail(message: string, code: string): ScreenValidation<never> {
  return { ok: false, message, code };
}

function parsePort(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) {
    return null;
  }
  return n;
}

function validateField(
  field: Field,
  value: unknown
): ScreenValidation<string | number> {
  switch (field) {
    case "name": {
      const name = typeof value === "string" ? value.trim() : "";
      return name
        ? { ok: true, value: name }
        : fail("名前を入力してください", "invalid_name");
    }
    case "sshHost":
    case "vncHost": {
      const host = typeof value === "string" ? value.trim() : "";
      return HOST_PATTERN.test(host)
        ? { ok: true, value: host }
        : fail(
            `${field === "sshHost" ? "SSH" : "VNC"} ホストはホスト名か IP アドレスで指定してください`,
            "invalid_host"
          );
    }
    case "sshUser": {
      const user = typeof value === "string" ? value.trim() : "";
      return USER_PATTERN.test(user)
        ? { ok: true, value: user }
        : fail("SSH ユーザー名が不正です", "invalid_user");
    }
    case "vncUser": {
      const user = typeof value === "string" ? value.trim() : "";
      return { ok: true, value: user };
    }
    case "sshPort":
    case "vncPort": {
      const port = parsePort(value);
      return port !== null
        ? { ok: true, value: port }
        : fail(
            `${field === "sshPort" ? "SSH" : "VNC"} ポートは 1〜65535 の整数で指定してください`,
            "invalid_port"
          );
    }
    case "vncPassword": {
      return typeof value === "string" && value.length > 0
        ? { ok: true, value }
        : fail("VNC パスワードを入力してください", "invalid_password");
    }
  }
}

const DEFAULTS: Pick<ScreenInput, "vncHost" | "vncPort" | "vncUser"> = {
  vncHost: "127.0.0.1",
  vncPort: 5900,
  vncUser: "",
};

const FIELDS: Field[] = [
  "name",
  "sshHost",
  "sshPort",
  "sshUser",
  "vncHost",
  "vncPort",
  "vncUser",
  "vncPassword",
];

/** 作成入力。vncHost / vncPort / vncUser は省略時に既定値で補う */
export function validateScreenInput(raw: unknown): ScreenValidation<ScreenInput> {
  if (typeof raw !== "object" || raw === null) {
    return fail("入力が不正です", "invalid_input");
  }
  const source = { ...DEFAULTS, ...(raw as Record<string, unknown>) };
  const value: Record<string, string | number> = {};
  for (const field of FIELDS) {
    const result = validateField(field, source[field]);
    if (!result.ok) return result;
    value[field] = result.value;
  }
  return { ok: true, value: value as unknown as ScreenInput };
}

/** 部分更新。undefined と空の vncPassword は「変更しない」 */
export function validateScreenPatch(raw: unknown): ScreenValidation<ScreenPatch> {
  if (typeof raw !== "object" || raw === null) {
    return fail("入力が不正です", "invalid_input");
  }
  const source = raw as Record<string, unknown>;
  const value: Record<string, string | number> = {};
  for (const field of FIELDS) {
    const input = source[field];
    if (input === undefined) continue;
    if (field === "vncPassword" && input === "") continue;
    const result = validateField(field, input);
    if (!result.ok) return result;
    value[field] = result.value;
  }
  return { ok: true, value: value as ScreenPatch };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/screen-input.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm check
git add packages/server/src/lib/screen-input.ts packages/server/src/lib/screen-input.test.ts
git commit -m "feat(server): リモート画面の入力値検証を追加"
```

---

### Task 3: WebSocket ↔ `ssh -W` ブリッジ (`screen-bridge.ts`)

**Files:**
- Modify: `packages/server/package.json` (`ws` を dependencies、`@types/ws` を devDependencies)
- Create: `packages/server/src/lib/screen-bridge.ts`
- Test: `packages/server/src/lib/screen-bridge.test.ts`

**Interfaces:**
- Consumes: `ScreenRecord` (Task 1) から `sshHost / sshPort / sshUser / vncHost / vncPort`
- Produces:
  - `interface ScreenSshTarget { sshHost; sshPort; sshUser; vncHost; vncPort }`
  - `buildSshArgs(target: ScreenSshTarget): string[]`
  - `interface BridgeSocket` (ws の `WebSocket` が満たす最小限)
  - `class ScreenBridge { attach(ws: BridgeSocket, target: ScreenSshTarget): void; closeAll(): void; get activeCount(): number }`
  - `export const screenBridge = new ScreenBridge()`

- [ ] **Step 1: 依存を追加する**

Run: `pnpm --filter @ark/server add ws && pnpm --filter @ark/server add -D @types/ws`
Expected: `packages/server/package.json` の dependencies に `"ws"`、devDependencies に `"@types/ws"` が入る (`ws` は dependencies に置くこと。`build.mjs` は dependencies だけを external にする)

- [ ] **Step 2: テストを書く**

```ts
/**
 * screen-bridge のテスト。ssh は spawn をモックして、
 * stdin をそのまま stdout に返す偽プロセスで代用する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  type BridgeSocket,
  buildSshArgs,
  ScreenBridge,
} from "./screen-bridge.js";

const mockedSpawn = vi.mocked(spawn);

const target = {
  sshHost: "build.example.internal",
  sshPort: 2222,
  sshUser: "user",
  vncHost: "127.0.0.1",
  vncPort: 5900,
};

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & BridgeSocket & {
    sent: Buffer[];
    closed: Array<{ code?: number; reason?: string }>;
  };
  socket.sent = [];
  socket.closed = [];
  socket.readyState = 1;
  socket.send = vi.fn((data: Buffer) => {
    socket.sent.push(Buffer.from(data));
  });
  socket.close = vi.fn((code?: number, reason?: string) => {
    socket.readyState = 3;
    socket.closed.push({ code, reason });
  });
  socket.terminate = vi.fn();
  return socket;
}

describe("buildSshArgs", () => {
  it("BatchMode と -W で VNC ポートへ繋ぐ引数を組み立てる", () => {
    expect(buildSshArgs(target)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "2222",
      "-W",
      "127.0.0.1:5900",
      "user@build.example.internal",
    ]);
  });
});

describe("ScreenBridge", () => {
  let bridge: ScreenBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new ScreenBridge();
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("WebSocket の受信を ssh の stdin へ、stdout を WebSocket へ流す", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    expect(mockedSpawn).toHaveBeenCalledWith("ssh", buildSshArgs(target), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(bridge.activeCount).toBe(1);

    const received: Buffer[] = [];
    child.stdin.on("data", chunk => received.push(chunk));
    socket.emit("message", Buffer.from("RFB 003.008\n"));
    expect(Buffer.concat(received).toString()).toBe("RFB 003.008\n");

    child.stdout.write(Buffer.from("RFB 003.889\n"));
    expect(Buffer.concat(socket.sent).toString()).toBe("RFB 003.889\n");
  });

  it("WebSocket が閉じたら ssh を SIGTERM し、猶予後に SIGKILL する", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    socket.emit("close");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("ssh が非 0 で終わったら stderr の最後の行を理由に載せて閉じる", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    child.stderr.write("Warning: something\n");
    child.stderr.write("user@build.example.internal: Permission denied (publickey).\n");
    child.emit("exit", 255, null);

    expect(socket.closed).toEqual([
      {
        code: 1011,
        reason: "user@build.example.internal: Permission denied (publickey).",
      },
    ]);
    expect(bridge.activeCount).toBe(0);
  });

  it("ssh が 0 で終わったら通常終了で閉じる", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    child.emit("exit", 0, null);
    expect(socket.closed).toEqual([{ code: 1000, reason: "" }]);
  });

  it("理由は 123 バイトに切り詰める", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    child.stderr.write(`${"あ".repeat(100)}\n`);
    child.emit("exit", 1, null);
    expect(Buffer.byteLength(socket.closed[0].reason ?? "")).toBeLessThanOrEqual(
      123
    );
  });

  it("spawn の error は 1011 で閉じる", () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as never);
    const socket = fakeSocket();
    bridge.attach(socket, target);

    child.emit("error", new Error("spawn ssh ENOENT"));
    expect(socket.closed).toEqual([{ code: 1011, reason: "spawn ssh ENOENT" }]);
  });

  it("closeAll は残っている接続をすべて閉じる", () => {
    const children = [fakeChild(), fakeChild()];
    mockedSpawn
      .mockReturnValueOnce(children[0] as never)
      .mockReturnValueOnce(children[1] as never);
    const sockets = [fakeSocket(), fakeSocket()];
    bridge.attach(sockets[0], target);
    bridge.attach(sockets[1], target);

    bridge.closeAll();
    expect(sockets[0].close).toHaveBeenCalledWith(1001, "server shutdown");
    expect(sockets[1].close).toHaveBeenCalledWith(1001, "server shutdown");
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1].kill).toHaveBeenCalledWith("SIGTERM");
  });
});
```

- [ ] **Step 3: 失敗を確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/screen-bridge.test.ts`
Expected: FAIL (モジュールが無い)

- [ ] **Step 4: 実装する**

```ts
/**
 * リモート画面ブリッジ
 *
 * WebSocket (noVNC) と `ssh -W <vncHost>:<vncPort>` の stdio を直結する。
 * websockify もローカルポートも使わないので、接続ごとの後始末は
 * 「socket が閉じたら子プロセスを止める」だけで決定的になる。
 */

import { type ChildProcess, spawn } from "node:child_process";

export interface ScreenSshTarget {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  vncHost: string;
  vncPort: number;
}

/** ws の WebSocket が満たす最小限。テストで差し替えられるようにする */
export interface BridgeSocket {
  readyState: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** SIGTERM → SIGKILL の猶予 (ミリ秒) */
const KILL_GRACE_MS = 3000;
/** stderr の保持上限 (バイト)。理由の抽出にしか使わない */
const STDERR_CAP = 4096;
/** WebSocket の close reason の上限 (RFC 6455) */
const CLOSE_REASON_MAX_BYTES = 123;
const WS_OPEN = 1;

export function buildSshArgs(target: ScreenSshTarget): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-p",
    String(target.sshPort),
    "-W",
    `${target.vncHost}:${target.vncPort}`,
    `${target.sshUser}@${target.sshHost}`,
  ];
}

/** UTF-8 の境界を壊さずに 123 バイトへ切り詰める */
function truncateReason(text: string): string {
  let out = text;
  while (Buffer.byteLength(out) > CLOSE_REASON_MAX_BYTES) {
    out = out.slice(0, -1);
  }
  return out;
}

function lastLine(text: string): string {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

export class ScreenBridge {
  private readonly children = new Set<ChildProcess>();
  private readonly sockets = new Set<BridgeSocket>();

  get activeCount(): number {
    return this.children.size;
  }

  attach(ws: BridgeSocket, target: ScreenSshTarget): void {
    const child = spawn("ssh", buildSshArgs(target), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    this.sockets.add(ws);

    let stderr = "";
    let killTimer: NodeJS.Timeout | null = null;

    const closeSocket = (code: number, reason: string) => {
      if (ws.readyState === WS_OPEN) {
        ws.close(code, truncateReason(reason));
      }
    };

    const stopChild = () => {
      if (child.exitCode !== null || killTimer) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_CAP);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (ws.readyState === WS_OPEN) ws.send(chunk);
    });
    child.on("error", error => {
      this.children.delete(child);
      closeSocket(1011, error.message);
    });
    child.on("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      this.children.delete(child);
      if (code === 0) {
        closeSocket(1000, "");
      } else {
        closeSocket(1011, lastLine(stderr) || `ssh exited (${code ?? signal})`);
      }
    });

    ws.on("message", (data: Buffer) => {
      child.stdin?.write(data);
    });
    ws.on("close", () => {
      this.sockets.delete(ws);
      stopChild();
    });
    ws.on("error", stopChild);
  }

  /** サーバ停止時。残っている接続を閉じて ssh を止める */
  closeAll(): void {
    for (const child of this.children) {
      child.kill("SIGTERM");
    }
    for (const ws of this.sockets) {
      ws.close(1001, "server shutdown");
    }
    this.sockets.clear();
  }
}

export const screenBridge = new ScreenBridge();
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm --filter @ark/server exec vitest run src/lib/screen-bridge.test.ts`
Expected: PASS (7 件)

- [ ] **Step 6: コミット**

```bash
pnpm check
git add packages/server/package.json pnpm-lock.yaml packages/server/src/lib/screen-bridge.ts packages/server/src/lib/screen-bridge.test.ts
git commit -m "feat(server): WebSocket と ssh -W を直結するリモート画面ブリッジを追加"
```

---

### Task 4: サーバ配線 (`screen:*` ハンドラ、upgrade、停止)

**Files:**
- Modify: `packages/server/src/index.ts`
  - import 群 (先頭付近)
  - upgrade handler の `// Let Socket.IO handle other WebSocket connections` の直前 (1350 行付近)
  - `profile:delete` ハンドラの直後 (2802 行付近)
  - `stop()` の `browserManager.cleanup();` の直後 (3528 行付近)
- Modify: `packages/web/vite.config.ts` (`/ttyd` proxy の直後)

**Interfaces:**
- Consumes: `db.listScreens / getScreen / getScreenRecord / createScreen / updateScreen / deleteScreen` (Task 1)、`validateScreenInput / validateScreenPatch` (Task 2)、`screenBridge` (Task 3)
- Produces: Socket.IO `screen:*`、WebSocket `/screen/:id/ws`

- [ ] **Step 1: import を追加する**

`index.ts` の import 群に追加:

```ts
import { WebSocketServer } from "ws";
import { screenBridge } from "./lib/screen-bridge.js";
import { validateScreenInput, validateScreenPatch } from "./lib/screen-input.js";
```

- [ ] **Step 2: upgrade handler に `/screen/:id/ws` を足す**

`server.on("upgrade", ...)` より前 (`ttydProxy` の生成の直後、420 行付近) に:

```ts
  // リモート画面: noVNC の WebSocket を ssh -W へ直結する (screen-bridge.ts)
  const screenWss = new WebSocketServer({ noServer: true });
```

upgrade handler の `// Let Socket.IO handle other WebSocket connections` の直前に:

```ts
    // Handle remote screen (noVNC → ssh -W) WebSocket connections
    const screenMatch = pathname.match(/^\/screen\/([^/]+)\/ws$/);
    if (screenMatch) {
      // 認証検証（Quick Tunnel時のみ）
      if (!authorizeWebSocketUpgrade(req, url)) {
        socket.destroy();
        return;
      }
      const record = db.getScreenRecord(screenMatch[1]);
      if (!record) {
        socket.destroy();
        return;
      }
      screenWss.handleUpgrade(req, socket, head, ws => {
        screenBridge.attach(ws, record);
      });
      return;
    }
```

- [ ] **Step 3: Socket.IO ハンドラを追加する**

`profile:delete` ハンドラの直後に:

```ts
    // ===== Remote Screen Commands =====

    socket.on("screen:list", () => {
      try {
        socket.emit("screen:list", db.listScreens());
      } catch (e) {
        socket.emit("screen:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("screen:create", data => {
      const validated = validateScreenInput(data);
      if (!validated.ok) {
        socket.emit("screen:error", {
          message: validated.message,
          code: validated.code,
        });
        return;
      }
      try {
        const screen = db.createScreen(validated.value);
        io.emit("screen:created", screen);
        io.emit("screen:list", db.listScreens());
      } catch (e) {
        socket.emit("screen:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("screen:update", data => {
      const { id, ...rest } = data ?? ({} as { id?: string });
      if (typeof id !== "string" || id.length === 0) {
        socket.emit("screen:error", {
          message: "id は必須です",
          code: "invalid_id",
        });
        return;
      }
      const validated = validateScreenPatch(rest);
      if (!validated.ok) {
        socket.emit("screen:error", {
          message: validated.message,
          code: validated.code,
        });
        return;
      }
      try {
        const screen = db.updateScreen(id, validated.value);
        io.emit("screen:updated", screen);
        io.emit("screen:list", db.listScreens());
      } catch (e) {
        socket.emit("screen:error", { message: getErrorMessage(e) });
      }
    });

    socket.on("screen:delete", ({ id }) => {
      try {
        db.deleteScreen(id);
        io.emit("screen:deleted", { id });
        io.emit("screen:list", db.listScreens());
      } catch (e) {
        socket.emit("screen:error", { message: getErrorMessage(e) });
      }
    });

    // パスワードはこの callback でだけ配る (一覧には載せない)
    socket.on("screen:credentials", (id, callback) => {
      const record = db.getScreenRecord(id);
      callback(
        record ? { username: record.vncUser, password: record.vncPassword } : null
      );
    });
```

接続時の初期同期として、`socket.emit("system:capabilities", capabilities);` の直後に:

```ts
    // リモート画面の一覧 (機能フラグに依らず常に送る)
    socket.emit("screen:list", db.listScreens());
```

- [ ] **Step 4: 停止処理に加える**

`stop()` の `browserManager.cleanup();` の直後に:

```ts
    screenBridge.closeAll();
```

- [ ] **Step 5: dev proxy を足す**

`packages/web/vite.config.ts` の `"/ttyd"` エントリの直後に:

```ts
      "/screen": {
        target: process.env.VITE_API_URL || "http://localhost:4001",
        ws: true,
        changeOrigin: true,
      },
```

- [ ] **Step 6: 型チェックと全テスト**

Run: `pnpm check && pnpm test`
Expected: エラー 0、既存テスト PASS

- [ ] **Step 7: 疎通を手で確かめる (サーバのみ)**

隔離インスタンスで起動し (`ARK_DATA_DIR=<scratchpad>/ark-data PORT=4101 pnpm --filter @ark/server exec tsx src/cli.ts`)、別シェルから Node で `screen:create` → `screen:list` → `screen:credentials` を叩いて、一覧にパスワードが無く callback にだけ出ることを見る。登録した画面の `/screen/<id>/ws` に `ws` で繋ぎ、最初のフレームが `RFB 003.` で始まることを見る (実ホストの値はシェルの環境変数から渡し、記録に残さない)。終わったら `ARK_DATA_DIR` のディレクトリを消す。

- [ ] **Step 8: コミット**

```bash
git add packages/server/src/index.ts packages/web/vite.config.ts
git commit -m "feat(server): リモート画面の screen:* イベントと /screen/:id/ws を配線"
```

---

### Task 5: noVNC の同梱と `ScreenPane`

**Files:**
- Modify: `packages/web/package.json` (`@novnc/novnc`)
- Create: `packages/web/src/types/novnc.d.ts`
- Create: `packages/web/src/lib/auth-token.ts`
- Test: `packages/web/src/lib/auth-token.test.ts`
- Create: `packages/web/src/components/ScreenPane.tsx`
- Test: `packages/web/src/components/ScreenPane.test.tsx`

**Interfaces:**
- Consumes: `Screen` / `ScreenCredentials` (Task 1)
- Produces:
  - `getAuthToken(): string | null`
  - `buildScreenWsUrl(screenId: string): string`
  - `ScreenPane({ screen, requestCredentials }: { screen: Screen; requestCredentials: (id: string) => Promise<ScreenCredentials | null> })`

- [ ] **Step 1: 依存を追加する**

Run: `pnpm --filter @ark/web add @novnc/novnc`
Expected: `packages/web/package.json` に `"@novnc/novnc": "^1.7.0"`

- [ ] **Step 2: 型宣言を書く**

`packages/web/src/types/novnc.d.ts` (パッケージは型を同梱しないので、使う範囲だけ宣言する):

```ts
declare module "@novnc/novnc" {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export type RFBEventMap = {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    desktopname: CustomEvent<{ name: string }>;
  };

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: RFBOptions
    );
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    background: string;
    focusOnClick: boolean;
    disconnect(): void;
    sendCredentials(creds: RFBCredentials): void;
    focus(): void;
    blur(): void;
    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void
    ): void;
    removeEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void
    ): void;
  }
}
```

`packages/web/tsconfig.json` の `include` に `src` が含まれていれば追加設定は不要 (確認: `grep include packages/web/tsconfig.json`)。

- [ ] **Step 3: `auth-token` のテストを書く**

`packages/web/src/lib/auth-token.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { buildScreenWsUrl, getAuthToken } from "./auth-token";

function setLocation(url: string) {
  window.history.replaceState(null, "", url);
}

afterEach(() => {
  setLocation("/");
});

describe("getAuthToken", () => {
  it("URL の token を返す", () => {
    setLocation("/?token=abc");
    expect(getAuthToken()).toBe("abc");
  });

  it("無ければ null", () => {
    expect(getAuthToken()).toBeNull();
  });
});

describe("buildScreenWsUrl", () => {
  it("同一オリジンの ws URL を組み立てる", () => {
    expect(buildScreenWsUrl("s1")).toBe(`ws://${window.location.host}/screen/s1/ws`);
  });

  it("token があればクエリに載せる", () => {
    setLocation("/?token=a%26b");
    expect(buildScreenWsUrl("s1")).toBe(
      `ws://${window.location.host}/screen/s1/ws?token=a%26b`
    );
  });
});
```

- [ ] **Step 4: `auth-token` を実装する**

`packages/web/src/lib/auth-token.ts`:

```ts
/**
 * Quick Tunnel のトークンは URL のクエリで届く。Socket.IO は handshake の auth に、
 * 生の WebSocket (リモート画面) は upgrade リクエストのクエリに載せる。
 */

export function getAuthToken(): string | null {
  return new URLSearchParams(window.location.search).get("token");
}

/** リモート画面ブリッジ (`/screen/:id/ws`) の WebSocket URL */
export function buildScreenWsUrl(screenId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const base = `${protocol}://${window.location.host}/screen/${encodeURIComponent(screenId)}/ws`;
  const token = getAuthToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
```

Run: `pnpm exec vitest run packages/web/src/lib/auth-token.test.ts`
Expected: PASS

- [ ] **Step 5: `ScreenPane` のテストを書く**

`packages/web/src/components/ScreenPane.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  instances: [] as Array<{
    target: HTMLElement;
    channel: unknown;
    options: unknown;
    listeners: Map<string, (event: { detail: unknown }) => void>;
    disconnect: ReturnType<typeof vi.fn>;
    scaleViewport: boolean;
  }>,
}));

vi.mock("@novnc/novnc", () => ({
  default: class FakeRFB {
    scaleViewport = false;
    background = "";
    disconnect = vi.fn();
    listeners = new Map<string, (event: { detail: unknown }) => void>();
    constructor(target: HTMLElement, channel: unknown, options: unknown) {
      doubles.instances.push({
        target,
        channel,
        options,
        listeners: this.listeners,
        disconnect: this.disconnect,
        scaleViewport: false,
      });
    }
    addEventListener(type: string, listener: (event: { detail: unknown }) => void) {
      this.listeners.set(type, listener);
    }
    removeEventListener() {}
  },
}));

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  binaryType = "blob";
  readyState = 0;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
}

import { ScreenPane } from "./ScreenPane";

const screen = {
  id: "s1",
  name: "ビルド VM",
  sshHost: "build.example.internal",
  sshPort: 22,
  sshUser: "user",
  vncHost: "127.0.0.1",
  vncPort: 5900,
  vncUser: "user",
  createdAt: 0,
  updatedAt: 0,
};

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  doubles.instances.length = 0;
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

describe("ScreenPane", () => {
  it("credentials を取ってから RFB を作り、接続中の表示を出す", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ username: "user", password: "pw" });
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();

    expect(requestCredentials).toHaveBeenCalledWith("s1");
    expect(doubles.instances).toHaveLength(1);
    const rfb = doubles.instances[0];
    expect(rfb.channel).toBe(FakeWebSocket.instances[0]);
    expect(FakeWebSocket.instances[0].url).toContain("/screen/s1/ws");
    expect(rfb.options).toEqual({
      credentials: { username: "user", password: "pw" },
    });
    expect(container.textContent).toContain("接続中");

    act(() => rfb.listeners.get("connect")?.({ detail: {} }));
    expect(container.textContent).not.toContain("接続中");
  });

  it("切断されたら WebSocket の close reason を出し、再接続ボタンで繋ぎ直す", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ username: "user", password: "pw" });
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();

    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.dispatchEvent(
        new CloseEvent("close", { code: 1011, reason: "Permission denied" })
      );
      doubles.instances[0].listeners.get("disconnect")?.({
        detail: { clean: false },
      });
    });
    expect(container.textContent).toContain("Permission denied");

    const retry = Array.from(container.querySelectorAll("button")).find(
      b => b.textContent === "再接続"
    );
    act(() => retry?.click());
    await flush();
    expect(doubles.instances).toHaveLength(2);
    expect(requestCredentials).toHaveBeenCalledTimes(2);
  });

  it("認証失敗は securityfailure の理由を出す", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ username: "user", password: "pw" });
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();

    act(() => {
      doubles.instances[0].listeners.get("securityfailure")?.({
        detail: { status: 1, reason: "Authentication failed" },
      });
      doubles.instances[0].listeners.get("disconnect")?.({
        detail: { clean: false },
      });
    });
    expect(container.textContent).toContain("認証に失敗しました");
    expect(container.textContent).toContain("Authentication failed");
  });

  it("credentials が無ければ設定を促す", async () => {
    const requestCredentials = vi.fn().mockResolvedValue(null);
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();
    expect(doubles.instances).toHaveLength(0);
    expect(container.textContent).toContain("画面の設定が見つかりません");
  });

  it("安全なコンテキストでなければ接続せずに案内する", async () => {
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    const requestCredentials = vi.fn();
    const container = mount(
      <ScreenPane screen={screen} requestCredentials={requestCredentials} />
    );
    await flush();
    expect(requestCredentials).not.toHaveBeenCalled();
    expect(container.textContent).toContain("HTTPS");
  });

  it("アンマウントで RFB を切断する", async () => {
    const requestCredentials = vi
      .fn()
      .mockResolvedValue({ username: "user", password: "pw" });
    mount(<ScreenPane screen={screen} requestCredentials={requestCredentials} />);
    await flush();
    const rfb = doubles.instances[0];
    for (const { root, container } of mountedRoots.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
    expect(rfb.disconnect).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 失敗を確認する**

Run: `pnpm exec vitest run packages/web/src/components/ScreenPane.test.tsx`
Expected: FAIL (モジュールが無い)

- [ ] **Step 7: `ScreenPane` を実装する**

`packages/web/src/components/ScreenPane.tsx`:

```tsx
import type { Screen, ScreenCredentials } from "@ark/shared";
import RFB from "@novnc/novnc";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildScreenWsUrl } from "@/lib/auth-token";

interface ScreenPaneProps {
  screen: Screen;
  /** 接続の直前に 1 回だけ呼ぶ。未登録なら null */
  requestCredentials: (id: string) => Promise<ScreenCredentials | null>;
}

type Status =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string };

/**
 * リモート画面 (noVNC)。
 *
 * WebSocket は自前で開いて RFB に渡す。RFB は close の reason を
 * イベントに載せないので、close を自分で聞いて理由を表示に使う。
 * ARD 認証は WebCrypto を使うため、安全なコンテキスト
 * (localhost か HTTPS) でしか繋がらない。
 */
export function ScreenPane({ screen, requestCredentials }: ScreenPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const secure = window.isSecureContext;

  const connect = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return () => {};
    setStatus({ kind: "connecting" });

    const creds = await requestCredentials(screen.id);
    if (!creds) {
      setStatus({
        kind: "disconnected",
        reason: "画面の設定が見つかりません。画面の管理から登録し直してください",
      });
      return () => {};
    }

    let closeReason = "";
    let securityReason = "";
    const ws = new WebSocket(buildScreenWsUrl(screen.id));
    ws.binaryType = "arraybuffer";
    ws.addEventListener("close", event => {
      closeReason = event.reason;
    });

    const rfb = new RFB(container, ws, {
      credentials: { username: creds.username, password: creds.password },
    });
    rfb.scaleViewport = true;
    rfb.background = "transparent";
    rfb.addEventListener("connect", () => setStatus({ kind: "connected" }));
    rfb.addEventListener("securityfailure", event => {
      securityReason = `認証に失敗しました (${event.detail.reason ?? "理由不明"})`;
    });
    rfb.addEventListener("disconnect", event => {
      const reason =
        securityReason ||
        closeReason ||
        (event.detail.clean ? "切断されました" : "接続が切れました");
      setStatus({ kind: "disconnected", reason });
    });
    rfbRef.current = rfb;

    return () => {
      rfb.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
    };
  }, [screen.id, requestCredentials]);

  useEffect(() => {
    if (!secure) return;
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    void connect().then(fn => {
      if (cancelled) fn();
      else cleanup = fn;
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [connect, secure, attempt]);

  if (!secure) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
        リモート画面は HTTPS か localhost でだけ使えます (認証に WebCrypto
        が要るため)
      </div>
    );
  }

  return (
    <div className="relative h-full bg-black">
      <div ref={containerRef} className="absolute inset-0" />
      {status.kind === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground bg-background/80">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          {screen.name} に接続中...
        </div>
      )}
      {status.kind === "disconnected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm bg-background/90 px-6 text-center">
          <p className="text-muted-foreground break-all">{status.reason}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAttempt(n => n + 1)}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            再接続
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `pnpm exec vitest run packages/web/src/components/ScreenPane.test.tsx packages/web/src/lib/auth-token.test.ts`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
pnpm check
git add packages/web/package.json pnpm-lock.yaml packages/web/src/types/novnc.d.ts packages/web/src/lib/auth-token.ts packages/web/src/lib/auth-token.test.ts packages/web/src/components/ScreenPane.tsx packages/web/src/components/ScreenPane.test.tsx
git commit -m "feat(web): noVNC を同梱してリモート画面を描画する ScreenPane を追加"
```

---

### Task 6: `useSocket` の `screens` と管理ダイアログ

**Files:**
- Modify: `packages/web/src/hooks/useSocket.ts` (interface 248 行付近、state 418 行付近、listener 943 行付近、cleanup 1067 行付近、actions 1455 行付近、return 1632 行付近)
- Create: `packages/web/src/components/ScreenManagerDialog.tsx`
- Test: `packages/web/src/components/ScreenManagerDialog.test.tsx`

**Interfaces:**
- Consumes: `Screen` / `ScreenInput` / `ScreenPatch` / `ScreenCredentials` (Task 1)
- Produces (useSocket の戻り値に追加):
  - `screens: Screen[]`
  - `createScreen(input: ScreenInput): void`
  - `updateScreen(id: string, patch: ScreenPatch): void`
  - `deleteScreen(id: string): void`
  - `requestScreenCredentials(id: string): Promise<ScreenCredentials | null>`
- Produces: `ScreenManagerDialog({ open, onOpenChange, screens, onCreate, onUpdate, onDelete })`

- [ ] **Step 1: `useSocket` に state と操作を足す**

interface (`restartSessionWithProfile` の直後):

```ts
  // リモート画面
  screens: Screen[];
  createScreen: (input: ScreenInput) => void;
  updateScreen: (id: string, patch: ScreenPatch) => void;
  deleteScreen: (id: string) => void;
  /** 接続直前に 1 回だけ呼ぶ。socket 未接続や未登録は null */
  requestScreenCredentials: (id: string) => Promise<ScreenCredentials | null>;
```

state (`capabilities` の useState の直後):

```ts
  // リモート画面
  const [screens, setScreens] = useState<Screen[]>([]);
```

listener (`profile:error` の listener の直後):

```ts
    // リモート画面 ---------------------------------------------------
    socket.on("screen:list", list => {
      setScreens(list);
    });
    socket.on("screen:created", screen => {
      setScreens(prev =>
        prev.some(s => s.id === screen.id) ? prev : [...prev, screen]
      );
    });
    socket.on("screen:updated", screen => {
      setScreens(prev => prev.map(s => (s.id === screen.id ? screen : s)));
    });
    socket.on("screen:deleted", ({ id }) => {
      setScreens(prev => prev.filter(s => s.id !== id));
    });
    socket.on("screen:error", ({ message, code }) => {
      console.error("[Socket] Screen error:", message, code);
      toast.error(message);
    });
```

cleanup (`socket.off("browser:error");` の直後):

```ts
      socket.off("screen:list");
      socket.off("screen:created");
      socket.off("screen:updated");
      socket.off("screen:deleted");
      socket.off("screen:error");
```

actions (`deleteProfile` の直後):

```ts
  // リモート画面 actions
  const createScreen = useCallback((input: ScreenInput) => {
    socketRef.current?.emit("screen:create", input);
  }, []);

  const updateScreen = useCallback((id: string, patch: ScreenPatch) => {
    socketRef.current?.emit("screen:update", { id, ...patch });
  }, []);

  const deleteScreen = useCallback((id: string) => {
    socketRef.current?.emit("screen:delete", { id });
  }, []);

  const requestScreenCredentials = useCallback(
    (id: string) =>
      new Promise<ScreenCredentials | null>(resolve => {
        const socket = socketRef.current;
        if (!socket) {
          resolve(null);
          return;
        }
        socket.emit("screen:credentials", id, creds => resolve(creds));
      }),
    []
  );
```

return (`restartSessionWithProfile,` の直後):

```ts
    // リモート画面
    screens,
    createScreen,
    updateScreen,
    deleteScreen,
    requestScreenCredentials,
```

import に `Screen, ScreenCredentials, ScreenInput, ScreenPatch` を足す (`@ark/shared` の type import)。

- [ ] **Step 2: ダイアログのテストを書く**

`packages/web/src/components/ScreenManagerDialog.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Radix の Dialog は Portal と pointer イベントが絡むので素通しにする
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-testid="alert">{children}</div> : null,
  AlertDialogContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" data-action="" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { ScreenManagerDialog } from "./ScreenManagerDialog";

const screen = {
  id: "s1",
  name: "ビルド VM",
  sshHost: "build.example.internal",
  sshPort: 2222,
  sshUser: "user",
  vncHost: "127.0.0.1",
  vncPort: 5900,
  vncUser: "user",
  createdAt: 0,
  updatedAt: 0,
};

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

function setInput(container: HTMLElement, id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  expect(input).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    b => b.textContent?.trim() === text
  );
  expect(button, text).toBeDefined();
  act(() => button?.click());
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector("form");
  expect(form).not.toBeNull();
  act(() => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function dialogProps(overrides: Partial<Parameters<typeof ScreenManagerDialog>[0]> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    screens: [screen],
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

describe("ScreenManagerDialog", () => {
  it("登録済みの画面を一覧に出す", () => {
    const container = mount(<ScreenManagerDialog {...dialogProps()} />);
    expect(container.textContent).toContain("ビルド VM");
    expect(container.textContent).toContain("user@build.example.internal:2222");
  });

  it("新規追加で必須項目を埋めると onCreate に既定値込みで渡す", () => {
    const props = dialogProps({ screens: [] });
    const container = mount(<ScreenManagerDialog {...props} />);
    clickButton(container, "新規追加");
    setInput(container, "screen-name", "新しい VM");
    setInput(container, "screen-ssh-host", "vm.example.internal");
    setInput(container, "screen-ssh-user", "user");
    setInput(container, "screen-vnc-user", "user");
    setInput(container, "screen-vnc-password", "pw");
    submitForm(container);

    expect(props.onCreate).toHaveBeenCalledWith({
      name: "新しい VM",
      sshHost: "vm.example.internal",
      sshPort: 22,
      sshUser: "user",
      vncHost: "127.0.0.1",
      vncPort: 5900,
      vncUser: "user",
      vncPassword: "pw",
    });
  });

  it("名前が空なら送らずにエラーを出す", () => {
    const props = dialogProps({ screens: [] });
    const container = mount(<ScreenManagerDialog {...props} />);
    clickButton(container, "新規追加");
    submitForm(container);
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("名前を入力してください");
  });

  it("編集ではパスワードを空のまま保存すると vncPassword を送らない", () => {
    const props = dialogProps();
    const container = mount(<ScreenManagerDialog {...props} />);
    const edit = container.querySelector<HTMLButtonElement>('button[title="編集"]');
    act(() => edit?.click());
    setInput(container, "screen-name", "改名");
    submitForm(container);

    expect(props.onUpdate).toHaveBeenCalledWith("s1", {
      name: "改名",
      sshHost: "build.example.internal",
      sshPort: 2222,
      sshUser: "user",
      vncHost: "127.0.0.1",
      vncPort: 5900,
      vncUser: "user",
    });
  });

  it("削除は確認してから onDelete を呼ぶ", () => {
    const props = dialogProps();
    const container = mount(<ScreenManagerDialog {...props} />);
    const del = container.querySelector<HTMLButtonElement>('button[title="削除"]');
    act(() => del?.click());
    expect(props.onDelete).not.toHaveBeenCalled();
    const confirm = document.body.querySelector<HTMLButtonElement>("[data-action]");
    act(() => confirm?.click());
    expect(props.onDelete).toHaveBeenCalledWith("s1");
  });
});
```

- [ ] **Step 3: 失敗を確認する**

Run: `pnpm exec vitest run packages/web/src/components/ScreenManagerDialog.test.tsx`
Expected: FAIL (モジュールが無い)

- [ ] **Step 4: ダイアログを実装する**

`packages/web/src/components/ScreenManagerDialog.tsx` (`ProfileManagerDialog.tsx` と同型。フォームは 8 項目):

```tsx
import type { Screen, ScreenInput, ScreenPatch } from "@ark/shared";
import { Monitor, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ScreenManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  screens: Screen[];
  onCreate: (input: ScreenInput) => void;
  onUpdate: (id: string, patch: ScreenPatch) => void;
  onDelete: (id: string) => void;
}

type Mode = { kind: "list" } | { kind: "add" } | { kind: "edit"; id: string };

/** フォームの文字列 state。ポートも文字列で持ち、送信時に数値へ変える */
interface FormValues {
  name: string;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  vncHost: string;
  vncPort: string;
  vncUser: string;
  vncPassword: string;
}

type FormField = keyof FormValues;

const EMPTY_FORM: FormValues = {
  name: "",
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  vncHost: "127.0.0.1",
  vncPort: "5900",
  vncUser: "",
  vncPassword: "",
};

function formFromScreen(screen: Screen): FormValues {
  return {
    name: screen.name,
    sshHost: screen.sshHost,
    sshPort: String(screen.sshPort),
    sshUser: screen.sshUser,
    vncHost: screen.vncHost,
    vncPort: String(screen.vncPort),
    vncUser: screen.vncUser,
    vncPassword: "",
  };
}

function parsePort(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * 入力値検証 (サーバの screen-input.ts と同じ規則)。
 * 編集時はパスワード空を「変更しない」として通す
 */
function validateForm(
  values: FormValues,
  kind: "add" | "edit"
): { ok: true } | { ok: false; field: FormField; message: string } {
  if (!values.name.trim()) {
    return { ok: false, field: "name", message: "名前を入力してください" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(values.sshHost.trim())) {
    return {
      ok: false,
      field: "sshHost",
      message: "SSH ホストはホスト名か IP アドレスで指定してください",
    };
  }
  if (parsePort(values.sshPort) === null) {
    return {
      ok: false,
      field: "sshPort",
      message: "SSH ポートは 1〜65535 の整数で指定してください",
    };
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(values.sshUser.trim())) {
    return { ok: false, field: "sshUser", message: "SSH ユーザー名が不正です" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(values.vncHost.trim())) {
    return {
      ok: false,
      field: "vncHost",
      message: "VNC ホストはホスト名か IP アドレスで指定してください",
    };
  }
  if (parsePort(values.vncPort) === null) {
    return {
      ok: false,
      field: "vncPort",
      message: "VNC ポートは 1〜65535 の整数で指定してください",
    };
  }
  if (kind === "add" && values.vncPassword.length === 0) {
    return {
      ok: false,
      field: "vncPassword",
      message: "VNC パスワードを入力してください",
    };
  }
  return { ok: true };
}

export function ScreenManagerDialog({
  open,
  onOpenChange,
  screens,
  onCreate,
  onUpdate,
  onDelete,
}: ScreenManagerDialogProps) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [pendingDelete, setPendingDelete] = useState<Screen | null>(null);

  useEffect(() => {
    if (!open) {
      setMode({ kind: "list" });
      setPendingDelete(null);
    }
  }, [open]);

  const editing =
    mode.kind === "edit" ? (screens.find(s => s.id === mode.id) ?? null) : null;

  useEffect(() => {
    if (mode.kind === "edit" && !editing) setMode({ kind: "list" });
  }, [mode, editing]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-card border-border w-[calc(100%-2rem)] max-w-2xl mx-auto max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
          {mode.kind === "list" && (
            <ListView
              screens={screens}
              onAdd={() => setMode({ kind: "add" })}
              onEdit={id => setMode({ kind: "edit", id })}
              onAskDelete={setPendingDelete}
              onClose={() => onOpenChange(false)}
            />
          )}
          {mode.kind === "add" && (
            <AddOrEditView
              kind="add"
              initial={EMPTY_FORM}
              onCancel={() => setMode({ kind: "list" })}
              onSubmit={values => {
                onCreate({
                  name: values.name.trim(),
                  sshHost: values.sshHost.trim(),
                  sshPort: Number(values.sshPort),
                  sshUser: values.sshUser.trim(),
                  vncHost: values.vncHost.trim(),
                  vncPort: Number(values.vncPort),
                  vncUser: values.vncUser.trim(),
                  vncPassword: values.vncPassword,
                });
                setMode({ kind: "list" });
              }}
            />
          )}
          {mode.kind === "edit" && editing && (
            <AddOrEditView
              kind="edit"
              initial={formFromScreen(editing)}
              onCancel={() => setMode({ kind: "list" })}
              onSubmit={values => {
                const patch: ScreenPatch = {
                  name: values.name.trim(),
                  sshHost: values.sshHost.trim(),
                  sshPort: Number(values.sshPort),
                  sshUser: values.sshUser.trim(),
                  vncHost: values.vncHost.trim(),
                  vncPort: Number(values.vncPort),
                  vncUser: values.vncUser.trim(),
                };
                if (values.vncPassword.length > 0) {
                  patch.vncPassword = values.vncPassword;
                }
                onUpdate(editing.id, patch);
                setMode({ kind: "list" });
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={openState => {
          if (!openState) setPendingDelete(null);
        }}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>画面を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `「${pendingDelete.name}」の接続設定を削除します。接続先のホストには何もしません。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) {
                  onDelete(pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ListView({
  screens,
  onAdd,
  onEdit,
  onAskDelete,
  onClose,
}: {
  screens: Screen[];
  onAdd: () => void;
  onEdit: (id: string) => void;
  onAskDelete: (screen: Screen) => void;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader className="px-5 py-4 border-b border-border">
        <DialogTitle className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-muted-foreground" />
          画面の管理
        </DialogTitle>
        <DialogDescription>
          SSH で届くホストの VNC 画面 (macOS の画面共有など) を Ark
          の中に表示します。
        </DialogDescription>
      </DialogHeader>

      <div className="px-5 py-3 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground font-medium">
            登録済みの画面 ({screens.length})
          </span>
          <Button type="button" size="sm" onClick={onAdd}>
            <Plus className="w-3 h-3 mr-1" />
            新規追加
          </Button>
        </div>

        {screens.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground border border-dashed border-border rounded-md">
            画面が未登録です。
          </div>
        ) : (
          <div className="space-y-2">
            {screens.map(screen => (
              <div
                key={screen.id}
                className="bg-background border border-border hover:border-muted-foreground/40 rounded-md p-3 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{screen.name}</span>
                    <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
                      {screen.sshUser}@{screen.sshHost}:{screen.sshPort} →{" "}
                      {screen.vncHost}:{screen.vncPort}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => onEdit(screen.id)}
                      title="編集"
                      className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onAskDelete(screen)}
                      title="削除"
                      className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-border flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </>
  );
}

const FIELD_LABELS: Array<{
  field: FormField;
  id: string;
  label: string;
  placeholder: string;
  type?: "text" | "password";
}> = [
  { field: "name", id: "screen-name", label: "名前", placeholder: "例: ビルド VM" },
  {
    field: "sshHost",
    id: "screen-ssh-host",
    label: "SSH ホスト",
    placeholder: "ホスト名か IP アドレス",
  },
  { field: "sshPort", id: "screen-ssh-port", label: "SSH ポート", placeholder: "22" },
  { field: "sshUser", id: "screen-ssh-user", label: "SSH ユーザー", placeholder: "" },
  {
    field: "vncHost",
    id: "screen-vnc-host",
    label: "VNC ホスト (SSH ホストから見た宛先)",
    placeholder: "127.0.0.1",
  },
  { field: "vncPort", id: "screen-vnc-port", label: "VNC ポート", placeholder: "5900" },
  {
    field: "vncUser",
    id: "screen-vnc-user",
    label: "VNC ユーザー名 (macOS の画面共有では必須)",
    placeholder: "",
  },
  {
    field: "vncPassword",
    id: "screen-vnc-password",
    label: "VNC パスワード",
    placeholder: "",
    type: "password",
  },
];

function AddOrEditView({
  kind,
  initial,
  onCancel,
  onSubmit,
}: {
  kind: "add" | "edit";
  initial: FormValues;
  onCancel: () => void;
  onSubmit: (values: FormValues) => void;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [error, setError] = useState<{ field: FormField; message: string } | null>(
    null
  );

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const result = validateForm(values, kind);
    if (!result.ok) {
      setError({ field: result.field, message: result.message });
      return;
    }
    setError(null);
    onSubmit(values);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
      <DialogHeader className="px-5 py-4 border-b border-border">
        <DialogTitle>{kind === "add" ? "画面を追加" : "画面を編集"}</DialogTitle>
        <DialogDescription>
          {kind === "add"
            ? "Ark のサーバから SSH 鍵で繋がるホストを指定します。"
            : "パスワードは空のままにすると変更しません。"}
        </DialogDescription>
      </DialogHeader>

      <div className="px-5 py-4 flex-1 overflow-y-auto space-y-4">
        {FIELD_LABELS.map(({ field, id, label, placeholder, type }) => (
          <div key={field}>
            <Label htmlFor={id} className="text-xs font-medium mb-1.5 block">
              {label}
            </Label>
            <Input
              id={id}
              type={type ?? "text"}
              value={values[field]}
              onChange={e => {
                const next = e.target.value;
                setValues(prev => ({ ...prev, [field]: next }));
                if (error?.field === field) setError(null);
              }}
              placeholder={placeholder}
              autoFocus={field === "name"}
              autoComplete={type === "password" ? "new-password" : "off"}
              className="bg-background border-border"
            />
            {error?.field === field && (
              <p className="text-xs text-destructive mt-1">{error.message}</p>
            )}
          </div>
        ))}
      </div>

      <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          キャンセル
        </Button>
        <Button type="submit" size="sm">
          {kind === "add" ? "追加" : "保存"}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm exec vitest run packages/web/src/components/ScreenManagerDialog.test.tsx`
Expected: PASS (5 件)

- [ ] **Step 6: コミット**

```bash
pnpm check
git add packages/web/src/hooks/useSocket.ts packages/web/src/components/ScreenManagerDialog.tsx packages/web/src/components/ScreenManagerDialog.test.tsx
git commit -m "feat(web): リモート画面の state と管理ダイアログを追加"
```

---

### Task 7: サイドバーの画面メニューと Dashboard の全面表示 (PC)

**Files:**
- Modify: `packages/web/src/components/SessionSidebar.tsx`
- Modify: `packages/web/src/components/SessionSidebar.test.tsx`
- Modify: `packages/web/src/pages/Dashboard.tsx`

**Interfaces:**
- Consumes: `screens / createScreen / updateScreen / deleteScreen / requestScreenCredentials` (Task 6)、`ScreenPane` (Task 5)、`ScreenManagerDialog` (Task 6)
- Produces (SessionSidebar props):
  - `screens?: Screen[]`
  - `selectedScreenId?: string | null`
  - `onSelectScreen?: (id: string) => void`
  - `onOpenScreenManager?: () => void`
- 選択の番兵: `selectedSessionId === "screen:<id>"`。判定は `parseScreenSelection(selectedSessionId)` (Dashboard 内の純関数)

- [ ] **Step 1: サイドバーのテストを書く**

`SessionSidebar.test.tsx` の `sidebarProps()` に手を入れず、`describe` の末尾に追加:

```tsx
  it("画面メニューから登録済みの画面を選び、管理ダイアログを開ける", () => {
    const props = {
      ...sidebarProps(),
      screens: [
        {
          id: "s1",
          name: "ビルド VM",
          sshHost: "build.example.internal",
          sshPort: 22,
          sshUser: "user",
          vncHost: "127.0.0.1",
          vncPort: 5900,
          vncUser: "user",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      selectedScreenId: null,
      onSelectScreen: vi.fn(),
      onOpenScreenManager: vi.fn(),
    };
    const container = mount(<SessionSidebar {...props} />);

    expect(container.querySelector('button[aria-label="画面"]')).not.toBeNull();
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-menu-item]")
    );
    act(() => items.find(i => i.textContent === "ビルド VM")?.click());
    expect(props.onSelectScreen).toHaveBeenCalledWith("s1");

    act(() => items.find(i => i.textContent === "画面の管理...")?.click());
    expect(props.onOpenScreenManager).toHaveBeenCalledTimes(1);
  });

  it("画面が未登録でも管理の項目だけは出す", () => {
    const props = {
      ...sidebarProps(),
      screens: [],
      onSelectScreen: vi.fn(),
      onOpenScreenManager: vi.fn(),
    };
    const container = mount(<SessionSidebar {...props} />);
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-menu-item]")
    ).map(i => i.textContent);
    expect(items).toContain("画面の管理...");
  });

  it("onOpenScreenManager が無ければ画面メニューを出さない", () => {
    const container = mount(<SessionSidebar {...sidebarProps()} />);
    expect(container.querySelector('button[aria-label="画面"]')).toBeNull();
  });
```

テスト冒頭の `vi.mock("@/components/ui/dropdown-menu", ...)` に `DropdownMenuSeparator` を足す:

```tsx
  DropdownMenuSeparator: () => <hr />,
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run packages/web/src/components/SessionSidebar.test.tsx`
Expected: 新規 3 件が FAIL

- [ ] **Step 3: サイドバーを実装する**

`SessionSidebar.tsx`:

import を変更:

```tsx
import type { Screen } from "@ark/shared";
import { ChevronDown, Globe, Info, Monitor, Plus, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

props に追加 (`notificationControl?: ReactNode;` の前):

```tsx
  /** リモート画面。onOpenScreenManager が無ければメニューを出さない */
  screens?: Screen[];
  selectedScreenId?: string | null;
  onSelectScreen?: (id: string) => void;
  onOpenScreenManager?: () => void;
```

分割代入に `screens = [], selectedScreenId = null, onSelectScreen, onOpenScreenManager,` を足す。

`{notificationControl}` の直後 (ブラウザボタンの前) に:

```tsx
        {onOpenScreenManager && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={selectedScreenId ? "default" : "ghost"}
                size="icon"
                className="h-8 w-8"
                aria-label="画面"
                aria-pressed={selectedScreenId !== null}
                title="画面"
              >
                <Monitor className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {screens.map(screen => (
                <DropdownMenuItem
                  key={screen.id}
                  onSelect={() => onSelectScreen?.(screen.id)}
                >
                  <Monitor />
                  {screen.name}
                </DropdownMenuItem>
              ))}
              {screens.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={onOpenScreenManager}>
                <Settings />
                画面の管理...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
```

Run: `pnpm exec vitest run packages/web/src/components/SessionSidebar.test.tsx`
Expected: PASS

- [ ] **Step 4: Dashboard を配線する**

`Dashboard.tsx`:

import に追加:

```tsx
import { ScreenManagerDialog } from "@/components/ScreenManagerDialog";
import { ScreenPane } from "@/components/ScreenPane";
```

ファイル上部 (コンポーネント外) に純関数:

```tsx
/** selectedSessionId の "screen:<id>" 番兵を読む。該当しなければ null */
export function parseScreenSelection(selectedSessionId: string | null): string | null {
  return selectedSessionId?.startsWith("screen:")
    ? selectedSessionId.slice("screen:".length)
    : null;
}
```

`useSocket` の分割代入 (`navigateBrowser,` の直後) に:

```tsx
    screens,
    createScreen,
    updateScreen,
    deleteScreen,
    requestScreenCredentials,
```

`hasBrowserOpened` の useState の直後に:

```tsx
  // 一度開いた画面の id。開いた ScreenPane はマウントしたまま display で切り替える
  const [openedScreenIds, setOpenedScreenIds] = useState<Set<string>>(
    () => new Set()
  );
  const [showScreenManager, setShowScreenManager] = useState(false);
  const selectedScreenId = parseScreenSelection(selectedSessionId);

  const handleSelectScreen = useCallback((id: string) => {
    setSelectedSessionId(`screen:${id}`);
    setOpenedScreenIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // 削除された画面を選択中なら選択を外し、マウントも解く (再接続先が無い)
  useEffect(() => {
    if (selectedScreenId && !screens.some(s => s.id === selectedScreenId)) {
      setSelectedSessionId(null);
    }
    setOpenedScreenIds(prev => {
      const next = new Set([...prev].filter(id => screens.some(s => s.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [screens, selectedScreenId]);
```

セッション自動選択の effect (`// ブラウザ選択中はリセットしない` の行) を:

```tsx
    // ブラウザ・画面の選択中はリセットしない
    if (selectedSessionId === "browser" || selectedScreenId) return;
```

に変え、依存配列に `selectedScreenId` を足す。

`<SessionSidebar>` の props に追加 (`isRemote={isRemote}` の直後):

```tsx
              screens={screens}
              selectedScreenId={selectedScreenId}
              onSelectScreen={handleSelectScreen}
              onOpenScreenManager={() => setShowScreenManager(true)}
```

main 領域のブラウザビュー (`{hasBrowserOpened && (...)}`) の直後に:

```tsx
                {/* リモート画面: 一度開いた画面はマウントしたまま display で切り替え、
                    再接続を防ぐ (ブラウザビューと同じ) */}
                {screens
                  .filter(screen => openedScreenIds.has(screen.id))
                  .map(screen => (
                    <div
                      key={screen.id}
                      className={
                        selectedScreenId === screen.id ? "h-full" : "hidden"
                      }
                    >
                      <ScreenPane
                        screen={screen}
                        requestCredentials={requestScreenCredentials}
                      />
                    </div>
                  ))}
```

`<ProfileManagerDialog>` の直後に:

```tsx
      <ScreenManagerDialog
        open={showScreenManager}
        onOpenChange={setShowScreenManager}
        screens={screens}
        onCreate={createScreen}
        onUpdate={updateScreen}
        onDelete={deleteScreen}
      />
```

- [ ] **Step 5: 既存の Dashboard テストを通す**

`Dashboard.test.tsx` の `useSocket` モックの戻り値 (`browserSessions: new Map(),` の並び) に追加:

```tsx
    screens: [],
    createScreen: vi.fn(),
    updateScreen: vi.fn(),
    deleteScreen: vi.fn(),
    requestScreenCredentials: vi.fn().mockResolvedValue(null),
```

`vi.mock("@/components/BrowserPane", ...)` の隣に:

```tsx
vi.mock("@/components/ScreenPane", () => ({ ScreenPane: () => null }));
```

Run: `pnpm check && pnpm test`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/web/src/components/SessionSidebar.tsx packages/web/src/components/SessionSidebar.test.tsx packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Dashboard.test.tsx
git commit -m "feat(web): サイドバーの画面メニューからリモート画面を全面表示する"
```

---

### Task 8: モバイルの画面タブ

**Files:**
- Modify: `packages/web/src/components/MobileLayout.tsx` (`MOBILE_TABS` 38 行、props 156 行付近、`showBottomNav` 361 行付近、ブラウザビュー 511〜536 行、下部タブ 538〜561 行)
- Modify: `packages/web/src/components/MobileLayout.test.tsx` (props の既定値)
- Modify: `packages/web/src/pages/Dashboard.tsx` (`<MobileLayout>` の props)

**Interfaces:**
- Consumes: `ScreenPane` (Task 5)、`screens / requestScreenCredentials` (Task 6)
- Produces (MobileLayout props): `screens: Screen[]`, `requestScreenCredentials`, `onOpenScreenManager: () => void`
- `MobileTab` に `"screen"` を追加

- [ ] **Step 1: `MOBILE_TABS` と props を足す**

```tsx
const MOBILE_TABS = ["session", "browser", "screen"] as const;
```

props (`isRemote: boolean;` の直後):

```tsx
  // リモート画面
  screens: Screen[];
  requestScreenCredentials: (id: string) => Promise<ScreenCredentials | null>;
  onOpenScreenManager: () => void;
```

import に `import { ScreenPane } from "@/components/ScreenPane";` と `Screen, ScreenCredentials` の type import を足す。

- [ ] **Step 2: タブの出し分けを変える**

`activeTab` の算出 (`const activeTab: MobileTab = isRemote ? storedActiveTab : "session";`) を:

```tsx
  // ブラウザのタブはリモート時だけ、画面のタブは登録があるときだけある。
  // 無いタブが保存されていたら一覧に戻す (戻る手段の無い空の画面を避ける)
  const hasScreens = screens.length > 0;
  const activeTab: MobileTab =
    (storedActiveTab === "browser" && !isRemote) ||
    (storedActiveTab === "screen" && !hasScreens)
      ? "session"
      : storedActiveTab;
```

`showBottomNav` と `paneClassName`:

```tsx
  const hasBottomNav = isRemote || hasScreens;
  const showBottomNav = hasBottomNav && !isDetailShown;
  const paneClassName = hasBottomNav
    ? "flex-1 flex flex-col min-h-0 pb-14"
    : "flex-1 flex flex-col min-h-0";
```

`handleOpenBrowser` の直後に:

```tsx
  // 画面タブ。複数登録があれば上部の select で切り替える
  const [selectedScreenId, setSelectedScreenId] = useState<string | null>(null);
  const [openedScreenIds, setOpenedScreenIds] = useState<Set<string>>(
    () => new Set()
  );
  const activeScreenId =
    selectedScreenId && screens.some(s => s.id === selectedScreenId)
      ? selectedScreenId
      : (screens[0]?.id ?? null);
  const handleOpenScreenTab = useCallback(() => {
    onChangeActiveTab("screen");
    if (activeScreenId) {
      setOpenedScreenIds(prev =>
        prev.has(activeScreenId) ? prev : new Set(prev).add(activeScreenId)
      );
    }
  }, [onChangeActiveTab, activeScreenId]);
  useEffect(() => {
    if (activeTab === "screen" && activeScreenId) {
      setOpenedScreenIds(prev =>
        prev.has(activeScreenId) ? prev : new Set(prev).add(activeScreenId)
      );
    }
  }, [activeTab, activeScreenId]);
```

- [ ] **Step 3: 画面ビューと下部タブを足す**

ブラウザビューのブロックの直後に:

```tsx
      {/* リモート画面 - 一度開いた画面はマウントしたまま display で切り替える */}
      {openedScreenIds.size > 0 && (
        <div className={activeTab === "screen" ? paneClassName : "hidden"}>
          <div className="h-12 border-b border-border flex items-center gap-3 px-4 shrink-0">
            <button
              type="button"
              className="inline-flex items-center gap-0.5 text-sm text-muted-foreground"
              onClick={() => onChangeActiveTab("session")}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              戻る
            </button>
            {screens.length > 1 ? (
              <select
                aria-label="表示する画面"
                className="text-sm bg-transparent"
                value={activeScreenId ?? ""}
                onChange={e => setSelectedScreenId(e.target.value)}
              >
                {screens.map(screen => (
                  <option key={screen.id} value={screen.id}>
                    {screen.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm font-medium">
                {screens[0]?.name ?? "画面"}
              </span>
            )}
            <button
              type="button"
              className="ml-auto text-sm text-muted-foreground"
              onClick={onOpenScreenManager}
            >
              管理
            </button>
          </div>
          <div className="flex-1 min-h-0 relative">
            {screens
              .filter(screen => openedScreenIds.has(screen.id))
              .map(screen => (
                <div
                  key={screen.id}
                  className={
                    activeScreenId === screen.id ? "absolute inset-0" : "hidden"
                  }
                >
                  <ScreenPane
                    screen={screen}
                    requestCredentials={requestScreenCredentials}
                  />
                </div>
              ))}
          </div>
        </div>
      )}
```

下部タブの `<nav>` 内、ブラウザのボタンを `isRemote &&` で囲み、その後に画面のボタンを足す:

```tsx
          {isRemote && (
            <button
              type="button"
              aria-current={activeTab === "browser" ? "page" : undefined}
              className={tabClassName(activeTab === "browser")}
              onClick={handleOpenBrowser}
            >
              ブラウザ
            </button>
          )}
          {hasScreens && (
            <button
              type="button"
              aria-current={activeTab === "screen" ? "page" : undefined}
              className={tabClassName(activeTab === "screen")}
              onClick={handleOpenScreenTab}
            >
              画面
            </button>
          )}
```

- [ ] **Step 4: Dashboard から渡す**

`<MobileLayout>` の props (`isRemote={isRemote}` の直後) に:

```tsx
          screens={screens}
          requestScreenCredentials={requestScreenCredentials}
          onOpenScreenManager={() => setShowScreenManager(true)}
```

`MobileLayout.test.tsx` の既定 props に `screens: [], requestScreenCredentials: vi.fn().mockResolvedValue(null), onOpenScreenManager: vi.fn(),` を足し、`vi.mock("@/components/ScreenPane", () => ({ ScreenPane: () => null }));` を加える。

- [ ] **Step 5: モバイルのテストを 1 件足す**

`MobileLayout.test.tsx` は jsdom ではなく `renderToStaticMarkup` で描画する (既存の `createProps()` を使う)。`describe` 末尾に:

```tsx
  it("画面が登録されていればローカルでも下部タブに「画面」を出す", () => {
    const props = {
      ...createProps(),
      isRemote: false,
      screens: [
        {
          id: "s1",
          name: "ビルド VM",
          sshHost: "build.example.internal",
          sshPort: 22,
          sshUser: "user",
          vncHost: "127.0.0.1",
          vncPort: 5900,
          vncUser: "user",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(MobileLayout, props));
    expect(html).toContain('aria-label="画面の切り替え"');
    expect(html).toContain(">画面</button>");
    expect(html).not.toContain(">ブラウザ</button>");
  });

  it("画面が未登録ならローカルでは下部タブを出さない", () => {
    const props = { ...createProps(), isRemote: false, screens: [] };
    const html = renderToStaticMarkup(createElement(MobileLayout, props));
    expect(html).not.toContain('aria-label="画面の切り替え"');
  });
```

Run: `pnpm check && pnpm test`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/web/src/components/MobileLayout.tsx packages/web/src/components/MobileLayout.test.tsx packages/web/src/pages/Dashboard.tsx
git commit -m "feat(web): モバイルにリモート画面のタブを追加"
```

---

### Task 9: 実機確認とドキュメント

**Files:**
- Modify: `CLAUDE.md` (「実装済み機能」表、Socket.IO イベント表)

- [ ] **Step 1: 検証ビルドで実機確認する**

`reference_ark_live_e2e_procedure` の手順どおり、本番 dist を上書きしない検証ビルド (別 outDir + `vite preview`、または `ARK_DATA_DIR` + `PORT` の隔離サーバ) を立て、Playwright (headless、`executablePath` は `~/.cache/ms-playwright/chromium-*/chrome-linux/chrome`) で:

1. サイドバーの Monitor アイコン → 「画面の管理...」 → 新規追加で対象 VM を登録 (値は環境変数から入力し、スクリーンショットや記録に残さない)
2. メニューから画面を選び、デスクトップが描画されるスクリーンショットを取る (`.claude/` や repo の外、scratchpad に置く)
3. 画面内をクリックしてウィンドウが反応すること、キー入力 (例: Cmd+Space) が届くことを見る
4. 別のセッションに切り替えて戻り、再接続していない (接続中の表示が出ない) ことを見る
5. サーバ側で該当 ssh を `kill` し、切断理由と再接続ボタンが出て、押すと繋ぎ直ることを見る
6. `pnpm exec playwright` で viewport を iPhone 幅にし、下部タブの「画面」から同じ画面が出ることを見る

- [ ] **Step 2: CLAUDE.md を更新する**

「実装済み機能」表に行を足す:

```markdown
| リモート画面           | SSH で届くホストの VNC 画面 (macOS の画面共有など) を noVNC で全面表示する。サイドバーの画面メニューから選ぶ。設定は SQLite の `screens`、WebSocket は Ark サーバ内で `ssh -W` に直結 (`screen-bridge.ts`)。認証に WebCrypto を使うため localhost か HTTPS でだけ繋がる |
```

クライアント → サーバの表に:

```markdown
| `screen:list`     | -                                       | リモート画面一覧取得 |
| `screen:create`   | `ScreenInput`                           | リモート画面作成 |
| `screen:update`   | `{ id, ...ScreenPatch }`                | リモート画面更新 (vncPassword は指定時のみ) |
| `screen:delete`   | `{ id }`                                | リモート画面削除 |
| `screen:credentials` | `id, callback`                       | VNC の認証情報 (一覧には載せない) |
```

サーバ → クライアントの表に:

```markdown
| `screen:list`            | `Screen[]`                     | リモート画面一覧 (接続時にも送る) |
| `screen:created` / `screen:updated` | `Screen`            | リモート画面の作成・更新完了 |
| `screen:deleted`         | `{ id }`                       | リモート画面削除完了 |
| `screen:error`           | `{ message, code? }`           | リモート画面エラー |
```

- [ ] **Step 3: コミットして push、PR を作る**

```bash
git add CLAUDE.md
git commit -m "docs: リモート画面の機能とイベントを CLAUDE.md に追記"
git push -u origin feat/remote-screen-pane
```

PR 本文には設計文書と計画書へのパス、実機確認の結果 (スクリーンショットは貼らない。VM の情報を含むため) を書く。レビューは `/codex review` に出す (自己レビュー禁止)。CI と CodeRabbit の結果は `gh pr view <PR#> --json statusCheckRollup` で自分で確認する。
