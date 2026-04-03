# 設定同期（Settings Sync）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** localStorageのUI設定をSQLiteに移し、PC間でページリロード時に同期できるようにする

**Architecture:** SQLiteに汎用KVストア（settingsテーブル）を追加し、REST API（Express）で読み書き。クライアントはページロード時にGET、変更時にdebounce付きPUTでサーバーに保存。localStorageは使用しない。

**Tech Stack:** better-sqlite3, Express REST API, React hooks, fetch API

---

### Task 1: SQLite settingsテーブルとCRUD関数

**Files:**
- Modify: `server/lib/database.ts:116-150` (initialize内にテーブル追加)
- Modify: `server/lib/database.ts:318-355` (CRUD関数追加)

- [ ] **Step 1: settingsテーブルをinitialize()に追加**

`server/lib/database.ts` の `initialize()` メソッド末尾（インデックス作成の後）に追加:

```typescript
    // 設定テーブルの作成（汎用KVストア）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
```

- [ ] **Step 2: CRUD関数を追加**

`server/lib/database.ts` の `close()` メソッドの直前に以下のセクションを追加:

```typescript
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
```

- [ ] **Step 3: 型チェック**

Run: `pnpm check`
Expected: 型エラーなし

- [ ] **Step 4: コミット**

```bash
git add server/lib/database.ts
git commit -m "feat: settingsテーブルとCRUD関数を追加"
```

---

### Task 2: REST APIエンドポイント

**Files:**
- Modify: `server/index.ts:159-168` (express.json()ミドルウェア追加)
- Modify: `server/index.ts:352-386` (ttyd proxyルートの前にsettings APIを追加)

- [ ] **Step 1: express.json()ミドルウェアを追加**

`server/index.ts` のセキュリティヘッダーミドルウェア（行159）の直前に追加:

```typescript
  // JSON body parser（Settings API用）
  app.use(express.json());
```

- [ ] **Step 2: Settings APIルートを追加**

`server/index.ts` の ttyd proxyルート（`// ===== ttyd Proxy Routes =====` コメント）の直前に追加:

```typescript
  // ===== Settings API =====

  // 全設定を取得
  app.get("/api/settings", (_req, res) => {
    try {
      const settings = db.getAllSettings();
      res.json(settings);
    } catch (e) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  // 特定キーの設定を取得
  app.get("/api/settings/:key", (req, res) => {
    try {
      const value = db.getSetting(req.params.key);
      if (value === undefined) {
        res.status(404).json({ error: "Setting not found" });
        return;
      }
      res.json({ value });
    } catch (e) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  // 複数キーを一括更新
  app.put("/api/settings", (req, res) => {
    try {
      const entries = req.body;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        res.status(400).json({ error: "Body must be a JSON object" });
        return;
      }
      db.setSettings(entries);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  // 単一キーを更新
  app.put("/api/settings/:key", (req, res) => {
    try {
      const { value } = req.body;
      if (value === undefined) {
        res.status(400).json({ error: "Body must have a 'value' field" });
        return;
      }
      db.setSetting(req.params.key, value);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });

  // 設定を削除
  app.delete("/api/settings/:key", (req, res) => {
    try {
      db.deleteSetting(req.params.key);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: getErrorMessage(e) });
    }
  });
```

- [ ] **Step 3: dbのインポート確認**

`server/index.ts` の既存インポートに `db` が含まれているか確認。なければ追加:

```typescript
import { db } from "./lib/database.js";
```

`getErrorMessage` は既に `server/lib/errors.ts` からインポート済みであることを確認。

- [ ] **Step 4: 型チェック**

Run: `pnpm check`
Expected: 型エラーなし

- [ ] **Step 5: コミット**

```bash
git add server/index.ts
git commit -m "feat: Settings REST APIエンドポイントを追加"
```

---

### Task 3: useSettingsフック

**Files:**
- Create: `client/src/hooks/useSettings.ts`

- [ ] **Step 1: useSettingsフックを作成**

`client/src/hooks/useSettings.ts` を新規作成:

```typescript
import { useCallback, useEffect, useRef, useState } from "react";

type SettingsState = Record<string, unknown>;

const API_BASE = "/api/settings";
const DEBOUNCE_MS = 300;

/**
 * サーバー側のsettingsテーブルと同期するフック
 *
 * - 初回マウント時にGET /api/settingsで全設定を取得
 * - setSetting()で変更するとdebounce付きでサーバーに保存
 * - localStorageは使用しない
 */
export function useSettings() {
  const [settings, setSettings] = useState<SettingsState>({});
  const [isLoading, setIsLoading] = useState(true);
  const pendingRef = useRef<Map<string, unknown>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 初回マウント時に全設定を取得
  useEffect(() => {
    fetch(API_BASE)
      .then(res => res.json())
      .then((data: SettingsState) => {
        setSettings(data);
        setIsLoading(false);
      })
      .catch(() => {
        setIsLoading(false);
      });
  }, []);

  // debounce付きでサーバーに保存
  const flushToServer = useCallback(() => {
    const entries = Object.fromEntries(pendingRef.current);
    pendingRef.current.clear();
    if (Object.keys(entries).length === 0) return;

    fetch(API_BASE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entries),
    }).catch(() => {
      // サーバーエラー時はサイレントに失敗（次回リロード時にサーバーの値を使用）
    });
  }, []);

  const setSetting = useCallback(
    (key: string, value: unknown) => {
      setSettings(prev => ({ ...prev, [key]: value }));
      pendingRef.current.set(key, value);

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(flushToServer, DEBOUNCE_MS);
    },
    [flushToServer]
  );

  const getSetting = useCallback(
    <T>(key: string, defaultValue: T): T => {
      const value = settings[key];
      return value !== undefined ? (value as T) : defaultValue;
    },
    [settings]
  );

  // アンマウント時にpending分をフラッシュ
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (pendingRef.current.size > 0) {
        const entries = Object.fromEntries(pendingRef.current);
        // sendBeaconでページ離脱時にも確実に送信
        navigator.sendBeacon(
          API_BASE,
          new Blob([JSON.stringify(entries)], { type: "application/json" })
        );
      }
    };
  }, []);

  return { settings, isLoading, getSetting, setSetting };
}
```

- [ ] **Step 2: 型チェック**

Run: `pnpm check`
Expected: 型エラーなし

- [ ] **Step 3: コミット**

```bash
git add client/src/hooks/useSettings.ts
git commit -m "feat: useSettingsフックを作成"
```

---

### Task 4: Dashboard.tsxのlocalStorage → useSettingsへの移行

**Files:**
- Modify: `client/src/pages/Dashboard.tsx:61-240`

- [ ] **Step 1: useSettingsをインポートしlocalStorageの定数・関数を削除**

`client/src/pages/Dashboard.tsx` で以下の変更を行う。

まず、useSettingsのインポートを追加:

```typescript
import { useSettings } from "@/hooks/useSettings";
```

次に、以下のlocalStorage関連コードを削除:
- 行65-68: `SIDEBAR_WIDTH_STORAGE_KEY`, `ACTIVE_PANES_STORAGE_KEY`, `MAXIMIZED_PANE_STORAGE_KEY`, `CLOSED_PANES_STORAGE_KEY` の定数
- 行70-83: `loadClosedPanes()` 関数

`SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH`, `SIDEBAR_DEFAULT_WIDTH` は残す。

- [ ] **Step 2: Dashboard関数の冒頭にuseSettingsを追加し、state初期化を変更**

`Dashboard()` 関数内、`useSocket()` の直後に `useSettings()` を追加:

```typescript
  const { isLoading: isSettingsLoading, getSetting, setSetting } = useSettings();
```

以下のstate初期化を変更:

**sidebarWidth（行136-149）** を置き換え:
```typescript
  const sidebarWidthSetting = getSetting<number>("sidebar-width", SIDEBAR_DEFAULT_WIDTH);
  const [localSidebarWidth, setLocalSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
```

サーバーからの初期値をlocalStateに反映するuseEffect追加:
```typescript
  const sidebarInitializedRef = useRef(false);
  useEffect(() => {
    if (!isSettingsLoading && !sidebarInitializedRef.current) {
      sidebarInitializedRef.current = true;
      setLocalSidebarWidth(sidebarWidthSetting);
    }
  }, [isSettingsLoading, sidebarWidthSetting]);
```

リサイズ中のマウス移動処理で `setSidebarWidth` → `setLocalSidebarWidth` に変更。
`handleMouseUp` 内の `localStorage.setItem(...)` を `setSetting("sidebar-width", localSidebarWidth)` に変更。

**activePanesPerRepo（行189-202）** を置き換え:
```typescript
  const [activePanesPerRepo, setActivePanesPerRepo] = useState<Map<string, string[]>>(
    () => new Map()
  );
```

isSettingsLoading完了時にサーバーの値を反映するuseEffect:
```typescript
  const panesInitializedRef = useRef(false);
  useEffect(() => {
    if (!isSettingsLoading && !panesInitializedRef.current) {
      panesInitializedRef.current = true;
      const saved = getSetting<Array<[string, string[]]>>("activePanesPerRepo", []);
      if (saved.length > 0) {
        setActivePanesPerRepo(new Map(saved));
      }
    }
  }, [isSettingsLoading, getSetting]);
```

**maximizedPane（行203-211）** を置き換え:
```typescript
  const [maximizedPane, setMaximizedPane] = useState<string | null>(null);
```

isSettingsLoading完了時に反映:
```typescript
  useEffect(() => {
    if (!isSettingsLoading && !panesInitializedRef.current) {
      setMaximizedPane(getSetting<string | null>("maximizedPane", null));
    }
  }, [isSettingsLoading, getSetting]);
```
（注: panesInitializedRefと同じタイミングで初期化するため、同じrefを共有。もしくはmaximizedPaneのuseEffectはpanesInitializedRefのuseEffect内にまとめる）

**closedPanesRef（行214）** を置き換え:
```typescript
  const closedPanesRef = useRef<Set<string>>(new Set());
```

isSettingsLoading完了時に反映（panesInitializedRefのuseEffect内にまとめる）:
```typescript
  const panesInitializedRef = useRef(false);
  useEffect(() => {
    if (!isSettingsLoading && !panesInitializedRef.current) {
      panesInitializedRef.current = true;
      const savedPanes = getSetting<Array<[string, string[]]>>("activePanesPerRepo", []);
      if (savedPanes.length > 0) {
        setActivePanesPerRepo(new Map(savedPanes));
      }
      setMaximizedPane(getSetting<string | null>("maximizedPane", null));
      const savedClosed = getSetting<string[]>("closedPanes", []);
      closedPanesRef.current = new Set(savedClosed);
    }
  }, [isSettingsLoading, getSetting]);
```

- [ ] **Step 3: localStorage書き込みのuseEffectをuseSettings経由に変更**

**saveClosedPanes（行215-222）** を置き換え:
```typescript
  const saveClosedPanes = useCallback(() => {
    setSetting("closedPanes", Array.from(closedPanesRef.current));
  }, [setSetting]);
```

**activePanesPerRepoの保存useEffect（行224-231）** を置き換え:
```typescript
  useEffect(() => {
    if (panesInitializedRef.current) {
      setSetting("activePanesPerRepo", Array.from(activePanesPerRepo.entries()));
    }
  }, [activePanesPerRepo, setSetting]);
```

**maximizedPaneの保存useEffect（行233-240）** を置き換え:
```typescript
  useEffect(() => {
    if (panesInitializedRef.current) {
      setSetting("maximizedPane", maximizedPane);
    }
  }, [maximizedPane, setSetting]);
```

**handleMouseUp（行171-173）** のlocalStorage.setItemを置き換え:
```typescript
    const handleMouseUp = () => {
      setIsResizing(false);
      setSetting("sidebar-width", localSidebarWidth);
    };
```

- [ ] **Step 4: sidebarWidthの参照をlocalSidebarWidthに変更**

Dashboard.tsx内で `sidebarWidth` を参照している箇所を `localSidebarWidth` に変更する。JSX内でのstyleやprop渡しが対象。

- [ ] **Step 5: 型チェック**

Run: `pnpm check`
Expected: 型エラーなし

- [ ] **Step 6: コミット**

```bash
git add client/src/pages/Dashboard.tsx
git commit -m "feat: Dashboard.tsxのlocalStorageをuseSettingsに移行"
```

---

### Task 5: useSocket.tsのlocalStorage → useSettings連携

**Files:**
- Modify: `client/src/hooks/useSocket.ts:111-117, 171, 197, 203, 416, 424`
- Modify: `client/src/pages/Dashboard.tsx` (useSettingsの値をuseSocketに渡す)

- [ ] **Step 1: useSocket.tsからlocalStorage読み込みを除去**

`client/src/hooks/useSocket.ts` の以下を変更。

useSocketの引数にオプションを追加:

```typescript
interface UseSocketOptions {
  initialRepoList?: string[];
  initialRepoPath?: string | null;
  onRepoListChange?: (list: string[]) => void;
  onRepoPathChange?: (path: string | null) => void;
}

export function useSocket(options: UseSocketOptions = {}) {
```

optionsをrefで保持（useEffectの依存配列に入れないため）:
```typescript
  const optionsRef = useRef(options);
  optionsRef.current = options;
```

state初期化を変更:
```typescript
  const [repoList, setRepoList] = useState<string[]>(options.initialRepoList ?? []);
  const [repoPath, setRepoPath] = useState<string | null>(options.initialRepoPath ?? null);
```

- [ ] **Step 2: localStorage書き込みをコールバックに変更**

`useSocket.ts` 内の以下のlocalStorage操作をコールバック経由に変更:

行197（`localStorage.setItem("selectedRepoPath", path)`）:
```typescript
      setRepoPath(path);
      optionsRef.current.onRepoPathChange?.(path);
```

行203（`localStorage.setItem("repoList", ...)`）:
```typescript
      setRepoList(newList);
      optionsRef.current.onRepoListChange?.(newList);
```

行416（`localStorage.setItem("repoList", ...)`）:
```typescript
      setRepoList(newList);
      optionsRef.current.onRepoListChange?.(newList);
```

行424（`localStorage.removeItem("selectedRepoPath")`）:
```typescript
      setRepoPath(null);
      optionsRef.current.onRepoPathChange?.(null);
```

行171-173の自動復元（`localStorage.getItem("selectedRepoPath")`）:
```typescript
      // 保存されたリポジトリを自動復元（optionsから取得）
      if (options.initialRepoPath) {
        socket.emit("repo:select", options.initialRepoPath);
      }
```

- [ ] **Step 3: Dashboard.tsxからuseSocketにsettings値を渡す**

`client/src/pages/Dashboard.tsx` の `useSocket()` 呼び出しを変更:

```typescript
  const savedRepoList = getSetting<string[]>("repoList", []);
  const savedRepoPath = getSetting<string | null>("selectedRepoPath", null);

  const {
    // ...既存の分割代入
  } = useSocket({
    initialRepoList: savedRepoList,
    initialRepoPath: savedRepoPath,
    onRepoListChange: (list) => setSetting("repoList", list),
    onRepoPathChange: (path) => setSetting("selectedRepoPath", path),
  });
```

- [ ] **Step 4: 型チェック**

Run: `pnpm check`
Expected: 型エラーなし

- [ ] **Step 5: コミット**

```bash
git add client/src/hooks/useSocket.ts client/src/pages/Dashboard.tsx
git commit -m "feat: useSocket.tsのlocalStorageをuseSettings連携に移行"
```

---

### Task 6: ビルド確認と最終検証

**Files:** なし（ビルドと動作確認のみ）

- [ ] **Step 1: フルビルド**

Run: `pnpm build`
Expected: エラーなしでビルド完了

- [ ] **Step 2: biome check**

Run: `pnpm check`
Expected: エラーなし

- [ ] **Step 3: サーバー起動してAPI動作確認**

サーバーを起動して `/api/settings` のCRUDをcurlで確認:

```bash
# 全設定取得（初回は空）
curl -s http://localhost:3001/api/settings | jq .
# Expected: {}

# 設定保存
curl -s -X PUT http://localhost:3001/api/settings/test-key \
  -H 'Content-Type: application/json' \
  -d '{"value": "hello"}' | jq .
# Expected: {"ok": true}

# 設定取得
curl -s http://localhost:3001/api/settings/test-key | jq .
# Expected: {"value": "hello"}

# 一括更新
curl -s -X PUT http://localhost:3001/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"key1": 1, "key2": [1,2,3]}' | jq .
# Expected: {"ok": true}

# 全設定取得
curl -s http://localhost:3001/api/settings | jq .
# Expected: {"test-key": "hello", "key1": 1, "key2": [1,2,3]}

# テストデータ削除
curl -s -X DELETE http://localhost:3001/api/settings/test-key | jq .
curl -s -X DELETE http://localhost:3001/api/settings/key1 | jq .
curl -s -X DELETE http://localhost:3001/api/settings/key2 | jq .
```

- [ ] **Step 4: コミット（ビルド修正が必要な場合のみ）**

ビルド/lint修正が必要な場合のみコミット。
