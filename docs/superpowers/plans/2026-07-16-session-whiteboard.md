# セッション・ホワイトボード Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** セッションごと（worktree 単位）の Excalidraw 自由編集ホワイトボードを右ペインタブに追加し、Claude の mermaid 図を編集可能要素として配置し、ユーザーのボード編集を diff テキストとして Claude に還流する。

**Architecture:** 既存の ViewerTab 機構に `board` タブ型を追加し、`ark:open-canvas` postMessage をデスクトップではボードへの要素挿入にルーティングする。ボード scene は SQLite `canvas_boards`（worktree_path キー）に自動保存。還流は前回送信スナップショットとの diff を自然文整形し、既存 `session:send` と同じ `sessionOrchestrator.sendMessage()` で送る。

**Tech Stack:** `@excalidraw/excalidraw@0.18.1`（MIT, React 19 対応）、`@excalidraw/mermaid-to-excalidraw@2.2.2`、better-sqlite3、Socket.IO、vitest

**Spec:** `docs/superpowers/specs/2026-07-16-session-whiteboard-design.md`

## Global Constraints

- コードコメント・コミットメッセージは日本語。コミットに Co-Authored-By を付けない
- `docs/superpowers/` 配下（この plan / spec）は git にコミットしない
- 作業ブランチは `feat/diagram-canvas`（現ブランチ）。コミット前に `git branch --show-current` で確認
- 各タスク完了時に `pnpm check`（tsc --noEmit）を実行。**既知のベースライン**: `packages/web/src/components/ui/input-otp.tsx` の TS エラー（#178 由来）は既存。自分の変更起因のエラーが 0 であることを確認する
- テストはルート `vitest.config.ts`（environment: "node"）で実行される。**`.tsx` はテスト不可**。テスト対象ロジックは必ず `.ts` の純ロジックに分離する
- Excalidraw は mermaid と同様 `await import()` で遅延チャンク化（メインバンドル肥大化の禁止）
- diff 整形で**座標の生値を Claude に送らない**（空間関係は「〜の近く」要約のみ）
- 情報源分離の原則: 還流は `session:send` 経路のみ。tmux 画面パースをしない
- spec の「worktree_id」キーは、実装ではコードベース規約（`worktree_display_names` と同じ）に合わせ **`worktree_path` キー**とする

---

## File Structure

```
packages/shared/src/types.ts                     # 変更: canvas:* イベント型 4 種
packages/server/src/lib/database.ts              # 変更: canvas_boards テーブル + CRUD 4 メソッド
packages/server/src/lib/database.canvas.test.ts  # 新規: DB テスト
packages/server/src/index.ts                     # 変更: canvas:* ハンドラー 3 種 + worktree:delete 連動
packages/web/src/lib/canvas-diff-utils.ts        # 新規: scene diff 抽出 + 自然文整形（純ロジック）
packages/web/src/lib/canvas-diff-utils.test.ts   # 新規
packages/web/src/lib/board-bus.ts                # 新規: mermaid 挿入の publish/subscribe（純ロジック）
packages/web/src/lib/board-bus.test.ts           # 新規
packages/web/src/lib/mermaid-to-board.ts         # 新規: mermaid→Excalidraw 要素変換（DI でテスト可能に）
packages/web/src/lib/mermaid-to-board.test.ts    # 新規
packages/web/src/lib/canvas-tabs.ts              # 変更: addOrFocusBoardTab 追加
packages/web/src/lib/canvas-tabs.test.ts         # 変更: board タブのテスト追加
packages/web/src/components/TerminalPane.tsx     # 変更: ViewerTab に board 型 + 描画分岐 + socket prop
packages/web/src/components/ViewerTabBar.tsx     # 変更: board ラベル
packages/web/src/components/CanvasPane.tsx       # 新規: Excalidraw ラッパー本体
packages/web/src/components/SplitViewPane.tsx    # 変更: socket 受け渡し + board タブでの自動表示
packages/web/src/hooks/useViewerTabs.ts          # 変更: boardMode ルーティング + openBoardTab
packages/web/src/pages/Dashboard.tsx             # 変更: boardMode=true を渡す
packages/web/vite.config.ts                      # 変更: Excalidraw 用 define 追加
CLAUDE.md                                        # 変更: 実装済み機能表に 1 行追加
```

---

### Task 1: DB 層 — canvas_boards テーブルと CRUD

**Files:**
- Modify: `packages/server/src/lib/database.ts`（`worktree_display_names` の CREATE TABLE 直後、約 315 行目）
- Test: `packages/server/src/lib/database.canvas.test.ts`

**Interfaces:**
- Consumes: 既存 `SessionDatabase`（`new SessionDatabase(":memory:")` / `close()`）
- Produces: `getCanvasBoard(worktreePath: string): { scene: string; lastSentScene: string | null } | null` / `saveCanvasBoardScene(worktreePath: string, scene: string): void` / `markCanvasBoardSent(worktreePath: string, scene: string): void` / `deleteCanvasBoard(worktreePath: string): void`

- [ ] **Step 1: 失敗するテストを書く**

`packages/server/src/lib/database.canvas.test.ts` を新規作成:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionDatabase } from "./database.js";

describe("SessionDatabase: canvas boards", () => {
  let db: SessionDatabase;

  beforeEach(() => {
    db = new SessionDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("未保存の worktree は null を返す", () => {
    expect(db.getCanvasBoard("/tmp/wt-a")).toBeNull();
  });

  it("saveCanvasBoardScene で保存し getCanvasBoard で取得できる", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", '{"elements":[]}');
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[]}');
    expect(board?.lastSentScene).toBeNull();
  });

  it("saveCanvasBoardScene は upsert（2回目は上書き・lastSentScene 維持）", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", '{"elements":[1]}');
    db.markCanvasBoardSent("/tmp/wt-a", '{"elements":[1]}');
    db.saveCanvasBoardScene("/tmp/wt-a", '{"elements":[1,2]}');
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[1,2]}');
    expect(board?.lastSentScene).toBe('{"elements":[1]}');
  });

  it("markCanvasBoardSent は scene と lastSentScene の両方を更新する", () => {
    db.markCanvasBoardSent("/tmp/wt-a", '{"elements":[9]}');
    const board = db.getCanvasBoard("/tmp/wt-a");
    expect(board?.scene).toBe('{"elements":[9]}');
    expect(board?.lastSentScene).toBe('{"elements":[9]}');
  });

  it("deleteCanvasBoard で削除される（未存在でもエラーにならない）", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", "{}");
    db.deleteCanvasBoard("/tmp/wt-a");
    expect(db.getCanvasBoard("/tmp/wt-a")).toBeNull();
    db.deleteCanvasBoard("/tmp/never-existed");
  });

  it("worktree ごとに独立している", () => {
    db.saveCanvasBoardScene("/tmp/wt-a", '{"a":1}');
    db.saveCanvasBoardScene("/tmp/wt-b", '{"b":2}');
    expect(db.getCanvasBoard("/tmp/wt-a")?.scene).toBe('{"a":1}');
    expect(db.getCanvasBoard("/tmp/wt-b")?.scene).toBe('{"b":2}');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run packages/server/src/lib/database.canvas.test.ts`
Expected: FAIL（`getCanvasBoard is not a function`）

- [ ] **Step 3: 実装**

`packages/server/src/lib/database.ts` の `worktree_display_names` CREATE TABLE ブロック（約 311-315 行）の直後、同じ `this.db.exec` テンプレート文字列内に追加:

```sql
      CREATE TABLE IF NOT EXISTS canvas_boards (
        worktree_path TEXT PRIMARY KEY,
        scene TEXT NOT NULL,
        last_sent_scene TEXT,
        updated_at INTEGER NOT NULL
      );
```

クラス末尾（`listWorktreeDisplayNames` 等の近く）にメソッド追加:

```typescript
  /** ボード scene を取得する（未保存なら null） */
  getCanvasBoard(
    worktreePath: string
  ): { scene: string; lastSentScene: string | null } | null {
    const row = this.db
      .prepare("SELECT * FROM canvas_boards WHERE worktree_path = ?")
      .get(worktreePath) as
      | { scene: string; last_sent_scene: string | null }
      | undefined;
    if (!row) return null;
    return { scene: row.scene, lastSentScene: row.last_sent_scene };
  }

  /** ボード scene を upsert する（last_sent_scene は維持） */
  saveCanvasBoardScene(worktreePath: string, scene: string): void {
    this.db
      .prepare(
        `INSERT INTO canvas_boards (worktree_path, scene, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worktree_path)
         DO UPDATE SET scene = excluded.scene, updated_at = excluded.updated_at`
      )
      .run(worktreePath, scene, Date.now());
  }

  /** 送信成功時: scene と last_sent_scene の両方を現 scene で更新する */
  markCanvasBoardSent(worktreePath: string, scene: string): void {
    this.db
      .prepare(
        `INSERT INTO canvas_boards (worktree_path, scene, last_sent_scene, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(worktree_path)
         DO UPDATE SET scene = excluded.scene,
                       last_sent_scene = excluded.last_sent_scene,
                       updated_at = excluded.updated_at`
      )
      .run(worktreePath, scene, scene, Date.now());
  }

  /** worktree 削除時にボードも削除する */
  deleteCanvasBoard(worktreePath: string): void {
    this.db
      .prepare("DELETE FROM canvas_boards WHERE worktree_path = ?")
      .run(worktreePath);
  }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run packages/server/src/lib/database.canvas.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 型チェックとコミット**

```bash
pnpm check   # 自分の変更起因のエラーが 0 であること（input-otp.tsx は既知）
git branch --show-current   # feat/diagram-canvas であること
git add packages/server/src/lib/database.ts packages/server/src/lib/database.canvas.test.ts
git commit -m "feat(board): canvas_boards テーブルと CRUD を追加"
```

---

### Task 2: Socket.IO イベント型とサーバーハンドラー

**Files:**
- Modify: `packages/shared/src/types.ts`（`"session:send-literal"` 定義（596 行付近）の後に C2S、S2C は `worktree:deleted` 系の近く）
- Modify: `packages/server/src/index.ts`（`session:send` ハンドラー（1892 行付近）の後 + `worktree:delete` ハンドラー（1779 行付近））

**Interfaces:**
- Consumes: Task 1 の `db.getCanvasBoard` / `saveCanvasBoardScene` / `markCanvasBoardSent` / `deleteCanvasBoard`、既存 `sessionOrchestrator.sendMessage(sessionId, message)`、`getErrorMessage(error)`
- Produces: Socket.IO イベント `canvas:load` / `canvas:save` / `canvas:send-to-claude`（C2S）、`canvas:updated`（S2C）。クライアント（Task 7）はこの型で通信する

- [ ] **Step 1: shared/types.ts に型を追加**

`ClientToServerEvents` 内（`"session:send-literal"` の直後）:

```typescript
  /** ボード scene の読込（callback 応答）。scene は Excalidraw scene の JSON 文字列 */
  "canvas:load": (
    worktreePath: string,
    callback: (response: {
      scene: string | null;
      lastSentScene: string | null;
      error?: string;
    }) => void
  ) => void;
  /** ボード scene の保存（デバウンス済みで呼ぶ） */
  "canvas:save": (data: { worktreePath: string; scene: string }) => void;
  /** ボード diff テキストをセッションの Claude に送信し、last_sent_scene を更新する */
  "canvas:send-to-claude": (
    data: {
      sessionId: string;
      worktreePath: string;
      text: string;
      scene: string;
    },
    callback: (response: { ok: boolean; error?: string }) => void
  ) => void;
```

`ServerToClientEvents` 内（worktree 系イベントの近く）:

```typescript
  /** 他クライアントがボードを保存した通知（受信側は未編集なら再読込する） */
  "canvas:updated": (data: { worktreePath: string }) => void;
```

- [ ] **Step 2: サーバーハンドラーを実装**

`packages/server/src/index.ts` の `session:send` ハンドラーの直後に追加:

```typescript
    socket.on("canvas:load", (worktreePath, callback) => {
      try {
        const board = db.getCanvasBoard(worktreePath);
        callback({
          scene: board?.scene ?? null,
          lastSentScene: board?.lastSentScene ?? null,
        });
      } catch (error) {
        callback({
          scene: null,
          lastSentScene: null,
          error: getErrorMessage(error),
        });
      }
    });

    socket.on("canvas:save", ({ worktreePath, scene }) => {
      try {
        db.saveCanvasBoardScene(worktreePath, scene);
        // 同じボードを開いている他クライアントへ（送信元は除く）
        socket.broadcast.emit("canvas:updated", { worktreePath });
      } catch (error) {
        console.error("canvas:save failed:", getErrorMessage(error));
      }
    });

    socket.on(
      "canvas:send-to-claude",
      ({ sessionId, worktreePath, text, scene }, callback) => {
        try {
          sessionOrchestrator.sendMessage(sessionId, text);
          db.markCanvasBoardSent(worktreePath, scene);
          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: getErrorMessage(error) });
        }
      }
    );
```

`worktree:delete` ハンドラー内、`await deleteWorktree(repoPath, worktreePath);` の直後に 1 行追加:

```typescript
        db.deleteCanvasBoard(worktreePath);
```

- [ ] **Step 3: 型チェックとコミット**

```bash
pnpm check
pnpm vitest run   # 既存テストの回帰がないこと
git add packages/shared/src/types.ts packages/server/src/index.ts
git commit -m "feat(board): canvas:* Socket.IO イベントとサーバーハンドラーを追加"
```

---

### Task 3: canvas-diff-utils — scene diff 抽出と自然文整形

**Files:**
- Create: `packages/web/src/lib/canvas-diff-utils.ts`
- Test: `packages/web/src/lib/canvas-diff-utils.test.ts`

**Interfaces:**
- Consumes: なし（純ロジック）
- Produces:
  - `interface BoardElementLike { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; containerId?: string | null; isDeleted?: boolean; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null; groupIds?: string[] }`
  - `buildBoardDiffText(prevElements: BoardElementLike[], nextElements: BoardElementLike[]): string` — 変更がなければ `""`、あれば `[ボード更新]` で始まる複数行テキスト

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/lib/canvas-diff-utils.test.ts` を新規作成:

```typescript
import { describe, expect, it } from "vitest";
import {
  type BoardElementLike,
  buildBoardDiffText,
} from "./canvas-diff-utils";

function rect(
  id: string,
  x: number,
  y: number,
  overrides: Partial<BoardElementLike> = {}
): BoardElementLike {
  return { id, type: "rectangle", x, y, width: 120, height: 60, ...overrides };
}

/** container に紐づくラベルテキスト要素 */
function boundText(
  id: string,
  containerId: string,
  text: string
): BoardElementLike {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    text,
    containerId,
  };
}

/** 独立した付箋テキスト */
function note(
  id: string,
  x: number,
  y: number,
  text: string
): BoardElementLike {
  return { id, type: "text", x, y, width: 150, height: 24, text };
}

describe("buildBoardDiffText", () => {
  it("変更なしなら空文字列を返す", () => {
    const els = [rect("a", 0, 0), boundText("a-t", "a", "ログイン機能")];
    expect(buildBoardDiffText(els, els)).toBe("");
  });

  it("付箋の追加を近接要素つきで整形する", () => {
    const prev = [rect("a", 0, 0), boundText("a-t", "a", "ログイン機能")];
    const next = [...prev, note("n1", 150, 30, "認証は Phase 2 に回す")];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("[ボード更新]");
    expect(text).toContain(
      "追加: 付箋「認証は Phase 2 に回す」（「ログイン機能」の近く）"
    );
  });

  it("遠い要素は近接表記なしで整形する", () => {
    const prev = [rect("a", 0, 0), boundText("a-t", "a", "ログイン機能")];
    const next = [...prev, note("n1", 5000, 5000, "遠い付箋")];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("追加: 付箋「遠い付箋」");
    expect(text).not.toContain("遠い付箋」（");
  });

  it("矢印の追加を接続先ラベルで整形する", () => {
    const a = rect("a", 0, 0);
    const b = rect("b", 400, 0);
    const prev = [
      a,
      b,
      boundText("a-t", "a", "セッション管理"),
      boundText("b-t", "b", "Redis 検討"),
    ];
    const arrow: BoardElementLike = {
      id: "ar1",
      type: "arrow",
      x: 120,
      y: 30,
      width: 280,
      height: 0,
      startBinding: { elementId: "a" },
      endBinding: { elementId: "b" },
    };
    const text = buildBoardDiffText(prev, [...prev, arrow]);
    expect(text).toContain("追加: 矢印「セッション管理」→「Redis 検討」");
  });

  it("テキスト変更を before → after で整形する", () => {
    const prev = [rect("a", 0, 0), boundText("a-t", "a", "API 設計")];
    const next = [rect("a", 0, 0), boundText("a-t", "a", "API 設計 (REST で確定)")];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain(
      "変更: カード「API 設計」→「API 設計 (REST で確定)」"
    );
  });

  it("削除を整形する", () => {
    const prev = [rect("a", 0, 0), boundText("a-t", "a", "x"), note("n1", 0, 200, "GraphQL 案")];
    const next = [rect("a", 0, 0), boundText("a-t", "a", "x")];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("削除: 付箋「GraphQL 案」");
  });

  it("isDeleted=true の要素は削除扱いになる", () => {
    const prev = [note("n1", 0, 0, "消える付箋")];
    const next = [{ ...note("n1", 0, 0, "消える付箋"), isDeleted: true }];
    const text = buildBoardDiffText(prev, next);
    expect(text).toContain("削除: 付箋「消える付箋」");
  });

  it("座標の生値を出力に含めない", () => {
    const prev: BoardElementLike[] = [];
    const next = [note("n1", 1234, 5678, "付箋A")];
    const text = buildBoardDiffText(prev, next);
    expect(text).not.toContain("1234");
    expect(text).not.toContain("5678");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run packages/web/src/lib/canvas-diff-utils.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`packages/web/src/lib/canvas-diff-utils.ts` を新規作成:

```typescript
/**
 * ボード（Excalidraw scene）の diff 抽出と Claude 向け自然文整形。
 *
 * 設計原則（spec: 2026-07-16-session-whiteboard-design.md）:
 * - 要素 id ベースで追加 / 変更 / 削除を検出する
 * - 座標の生値は出力しない（「〜の近く」の空間要約のみ）
 * - container に紐づく text 要素は container のラベルとして扱い、単独では列挙しない
 */

export interface BoardElementLike {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  containerId?: string | null;
  isDeleted?: boolean;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  groupIds?: string[];
}

/** ラベル付きの論理要素（bound text を container に吸収した後の単位） */
interface LogicalElement {
  id: string;
  type: string;
  cx: number;
  cy: number;
  label: string | null;
  startId: string | null;
  endId: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  arrow: "矢印",
  line: "線",
  text: "付箋",
  rectangle: "カード",
  ellipse: "図形",
  diamond: "図形",
  image: "画像",
  freedraw: "手描き",
};

/** 「近く」とみなす中心間距離の閾値 (px) */
const NEAR_THRESHOLD = 400;

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? "図形";
}

/** bound text を container に吸収し、論理要素の配列に変換する */
function toLogical(elements: BoardElementLike[]): LogicalElement[] {
  const alive = elements.filter(el => !el.isDeleted);
  const labelByContainer = new Map<string, string>();
  for (const el of alive) {
    if (el.type === "text" && el.containerId && el.text) {
      labelByContainer.set(el.containerId, el.text);
    }
  }
  const result: LogicalElement[] = [];
  for (const el of alive) {
    if (el.type === "text" && el.containerId) continue; // container 側で表現
    result.push({
      id: el.id,
      type: el.type,
      cx: el.x + el.width / 2,
      cy: el.y + el.height / 2,
      label: el.text ?? labelByContainer.get(el.id) ?? null,
      startId: el.startBinding?.elementId ?? null,
      endId: el.endBinding?.elementId ?? null,
    });
  }
  return result;
}

/** 要素の表示名: 種別「ラベル」または種別のみ */
function describe(el: LogicalElement, all: Map<string, LogicalElement>): string {
  if (el.type === "arrow" || el.type === "line") {
    const from = el.startId ? all.get(el.startId)?.label : null;
    const to = el.endId ? all.get(el.endId)?.label : null;
    if (from && to) return `${typeLabel(el.type)}「${from}」→「${to}」`;
  }
  return el.label
    ? `${typeLabel(el.type)}「${el.label}」`
    : typeLabel(el.type);
}

/** 最も近いラベル付き要素を探す（閾値内のみ） */
function nearestLabel(
  el: LogicalElement,
  others: LogicalElement[]
): string | null {
  let best: { label: string; d: number } | null = null;
  for (const o of others) {
    if (o.id === el.id || !o.label) continue;
    const d = Math.hypot(o.cx - el.cx, o.cy - el.cy);
    if (d <= NEAR_THRESHOLD && (best === null || d < best.d)) {
      best = { label: o.label, d };
    }
  }
  return best?.label ?? null;
}

/**
 * 前回送信時と現在の scene 要素を比較し、Claude に送る diff テキストを生成する。
 * 変更がなければ空文字列を返す。
 */
export function buildBoardDiffText(
  prevElements: BoardElementLike[],
  nextElements: BoardElementLike[]
): string {
  const prev = toLogical(prevElements);
  const next = toLogical(nextElements);
  const prevById = new Map(prev.map(el => [el.id, el]));
  const nextById = new Map(next.map(el => [el.id, el]));

  const lines: string[] = [];

  for (const el of next) {
    const before = prevById.get(el.id);
    if (!before) {
      const near = nearestLabel(el, next);
      const suffix = near && near !== el.label ? `（「${near}」の近く）` : "";
      lines.push(`追加: ${describe(el, nextById)}${suffix}`);
    } else if (before.label !== el.label && el.label) {
      lines.push(
        `変更: ${typeLabel(el.type)}「${before.label ?? ""}」→「${el.label}」`
      );
    }
  }
  for (const el of prev) {
    if (!nextById.has(el.id)) {
      lines.push(`削除: ${describe(el, prevById)}`);
    }
  }

  if (lines.length === 0) return "";
  return `[ボード更新]\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run packages/web/src/lib/canvas-diff-utils.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: 型チェックとコミット**

```bash
pnpm check
git add packages/web/src/lib/canvas-diff-utils.ts packages/web/src/lib/canvas-diff-utils.test.ts
git commit -m "feat(board): scene diff 抽出と自然文整形 (canvas-diff-utils) を追加"
```

---

### Task 4: board-bus — mermaid 挿入の publish/subscribe

**Files:**
- Create: `packages/web/src/lib/board-bus.ts`
- Test: `packages/web/src/lib/board-bus.test.ts`

**Interfaces:**
- Consumes: なし（純ロジック）
- Produces:
  - `interface BoardInsert { code: string; title?: string }`
  - `publishBoardInsert(worktreePath: string, insert: BoardInsert): void`
  - `subscribeBoardInserts(worktreePath: string, handler: (insert: BoardInsert) => void): () => void`（購読開始時に滞留分を flush。戻り値は unsubscribe）

背景: 「キャンバスで開く」クリック時、ボード（CanvasPane）が未マウントのことがある（タブを初めて開く瞬間）。挿入依頼をキューに積み、CanvasPane がマウント後に購読して受け取るためのモジュール。

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/lib/board-bus.test.ts` を新規作成:

```typescript
import { describe, expect, it } from "vitest";
import { publishBoardInsert, subscribeBoardInserts } from "./board-bus";

describe("board-bus", () => {
  it("購読中の handler に即時配送する", () => {
    const got: string[] = [];
    const unsub = subscribeBoardInserts("/tmp/wt-1", i => got.push(i.code));
    publishBoardInsert("/tmp/wt-1", { code: "graph TD; A-->B" });
    expect(got).toEqual(["graph TD; A-->B"]);
    unsub();
  });

  it("購読前の publish はキューされ、購読開始時に flush される", () => {
    publishBoardInsert("/tmp/wt-2", { code: "c1" });
    publishBoardInsert("/tmp/wt-2", { code: "c2" });
    const got: string[] = [];
    const unsub = subscribeBoardInserts("/tmp/wt-2", i => got.push(i.code));
    expect(got).toEqual(["c1", "c2"]);
    unsub();
  });

  it("unsubscribe 後の publish は再度キューされる", () => {
    const got: string[] = [];
    const unsub = subscribeBoardInserts("/tmp/wt-3", i => got.push(i.code));
    unsub();
    publishBoardInsert("/tmp/wt-3", { code: "after" });
    expect(got).toEqual([]);
    const got2: string[] = [];
    const unsub2 = subscribeBoardInserts("/tmp/wt-3", i => got2.push(i.code));
    expect(got2).toEqual(["after"]);
    unsub2();
  });

  it("worktree ごとに独立している", () => {
    const gotA: string[] = [];
    const unsubA = subscribeBoardInserts("/tmp/wt-a", i => gotA.push(i.code));
    publishBoardInsert("/tmp/wt-b", { code: "for-b" });
    expect(gotA).toEqual([]);
    unsubA();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run packages/web/src/lib/board-bus.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`packages/web/src/lib/board-bus.ts` を新規作成:

```typescript
/**
 * 「キャンバスで開く」→ ボードへの mermaid 挿入依頼を運ぶ軽量バス。
 *
 * CanvasPane（購読側）はタブが開かれて初めてマウントされるため、
 * 未購読時の依頼は worktree ごとのキューに滞留させ、購読開始時に flush する。
 */

export interface BoardInsert {
  code: string;
  title?: string;
}

const queues = new Map<string, BoardInsert[]>();
const handlers = new Map<string, (insert: BoardInsert) => void>();

export function publishBoardInsert(
  worktreePath: string,
  insert: BoardInsert
): void {
  const handler = handlers.get(worktreePath);
  if (handler) {
    handler(insert);
    return;
  }
  const queue = queues.get(worktreePath) ?? [];
  queue.push(insert);
  queues.set(worktreePath, queue);
}

export function subscribeBoardInserts(
  worktreePath: string,
  handler: (insert: BoardInsert) => void
): () => void {
  handlers.set(worktreePath, handler);
  const queued = queues.get(worktreePath);
  if (queued) {
    queues.delete(worktreePath);
    for (const insert of queued) handler(insert);
  }
  return () => {
    if (handlers.get(worktreePath) === handler) {
      handlers.delete(worktreePath);
    }
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run packages/web/src/lib/board-bus.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 型チェックとコミット**

```bash
pnpm check
git add packages/web/src/lib/board-bus.ts packages/web/src/lib/board-bus.test.ts
git commit -m "feat(board): ボード挿入依頼の publish/subscribe バスを追加"
```

---

### Task 5: board タブ型とルーティング

**Files:**
- Modify: `packages/web/src/components/TerminalPane.tsx:68-97`（ViewerTab union）
- Modify: `packages/web/src/lib/canvas-tabs.ts`
- Modify: `packages/web/src/lib/canvas-tabs.test.ts`
- Modify: `packages/web/src/components/ViewerTabBar.tsx:10-15`（getTabLabel）
- Modify: `packages/web/src/hooks/useViewerTabs.ts`
- Modify: `packages/web/src/pages/Dashboard.tsx:236-243`（useViewerTabs 呼び出し）
- Modify: `packages/web/src/components/SplitViewPane.tsx:97-106`（自動表示 effect）

**Interfaces:**
- Consumes: Task 4 の `publishBoardInsert(worktreePath, { code, title })`
- Produces:
  - `ViewerTab` union に `{ type: "board"; id: string }` を追加
  - `addOrFocusBoardTab(tabs: ViewerTab[]): { tabs: ViewerTab[]; activeIndex: number }`
  - `useViewerTabs(..., enabled = true, boardMode = false)` — boardMode=true のとき `ark:open-canvas` をボード挿入にルーティング

- [ ] **Step 1: 失敗するテストを書く**

`packages/web/src/lib/canvas-tabs.test.ts` に追記:

```typescript
import { addOrFocusBoardTab } from "./canvas-tabs";

describe("addOrFocusBoardTab", () => {
  it("board タブがなければ追加して active にする", () => {
    const { tabs, activeIndex } = addOrFocusBoardTab([term]);
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toEqual({ type: "board", id: "board" });
    expect(activeIndex).toBe(1);
  });

  it("既に board タブがあれば追加せずフォーカスする", () => {
    const first = addOrFocusBoardTab([term]);
    const second = addOrFocusBoardTab(first.tabs);
    expect(second.tabs).toHaveLength(2);
    expect(second.activeIndex).toBe(1);
  });
});
```

（既存テストの import 形式に合わせること。`term` は既存の `const term: ViewerTab = { type: "terminal", id: "terminal" }` を再利用）

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run packages/web/src/lib/canvas-tabs.test.ts`
Expected: FAIL（`addOrFocusBoardTab` が存在しない）

- [ ] **Step 3: 型とロジックを実装**

`packages/web/src/components/TerminalPane.tsx` の `ViewerTab` union に追加（`canvas` variant の後）:

```typescript
  | {
      type: "board";
      id: string;
    };
```

`packages/web/src/lib/canvas-tabs.ts` に追加:

```typescript
/** ホワイトボードタブを開く/フォーカスする純関数。board タブはセッションに 1 枚。 */
export function addOrFocusBoardTab(tabs: ViewerTab[]): {
  tabs: ViewerTab[];
  activeIndex: number;
} {
  const existing = tabs.findIndex(t => t.type === "board");
  if (existing >= 0) {
    return { tabs, activeIndex: existing };
  }
  const next: ViewerTab[] = [...tabs, { type: "board", id: "board" }];
  return { tabs: next, activeIndex: next.length - 1 };
}
```

`packages/web/src/components/ViewerTabBar.tsx` の `getTabLabel` に追加（`canvas` 分岐の後）:

```typescript
  if (tab.type === "board") return "🎨 ボード";
```

- [ ] **Step 4: useViewerTabs にルーティングを追加**

`packages/web/src/hooks/useViewerTabs.ts`:

import に追加:

```typescript
import { publishBoardInsert } from "../lib/board-bus";
import { addOrFocusBoardTab, addOrFocusCanvasTab } from "../lib/canvas-tabs";
```

（`addOrFocusCanvasTab` の既存 import 行を置き換える）

シグネチャ末尾にパラメータ追加:

```typescript
export function useViewerTabs(
  selectedSessionId: string | null,
  sessions: Map<string, { worktreePath: string }>,
  readFile: (sessionId: string, filePath: string) => void,
  fileContent: { /* 既存のまま */ } | null,
  onOpenUrl?: (url: string) => void,
  enabled = true,
  boardMode = false
) {
```

`openCanvasTab` の直後に `openBoardTab` を追加:

```typescript
  const openBoardTab = useCallback((sessionId: string) => {
    setSessionTabs(prev => {
      const current = prev[sessionId] ?? [
        { type: "terminal" as const, id: "terminal" },
      ];
      const { tabs, activeIndex } = addOrFocusBoardTab(current);
      setSessionActiveTab(p => ({ ...p, [sessionId]: activeIndex }));
      return { ...prev, [sessionId]: tabs };
    });
  }, []);
```

`ark:open-canvas` 分岐（203 行付近）を boardMode で分岐:

```typescript
      if (type === "ark:open-canvas") {
        const { code, title } = event.data;
        if (typeof code !== "string" || !code) return;
        const canvasTitle = typeof title === "string" ? title : undefined;
        if (boardMode) {
          // デスクトップ: ボードに要素として挿入し、ボードタブを開く
          publishBoardInsert(session.worktreePath, {
            code,
            title: canvasTitle,
          });
          openBoardTab(selectedSessionId);
        } else {
          // モバイル: 従来の図解ビューワータブ
          openCanvasTab(selectedSessionId, code, canvasTitle);
        }
      }
```

useEffect の依存配列に `boardMode` と `openBoardTab` を追加。return に `openBoardTab` を追加。

`packages/web/src/pages/Dashboard.tsx` の `useViewerTabs(...)` 呼び出しの最終引数に `true` を追加:

```typescript
  } = useViewerTabs(
    selectedSessionId,
    sessions,
    readFile,
    fileContent,
    handleOpenUrl,
    !isMobile,
    true // boardMode: デスクトップはボードに挿入
  );
```

（`MobileLayout.tsx` は変更しない = boardMode デフォルト false のまま）

`packages/web/src/components/SplitViewPane.tsx` の自動表示 effect（101 行付近）を board も対象に:

```typescript
    const canvasCount = props.tabs.filter(
      t => t.type === "canvas" || t.type === "board"
    ).length;
```

- [ ] **Step 5: テストと型チェック**

Run: `pnpm vitest run packages/web/src/lib/canvas-tabs.test.ts`
Expected: PASS

```bash
pnpm check
```

Expected: 自分の変更起因のエラー 0（TerminalPane の board タブ描画は Task 7 で追加するが、描画分岐がなくても union 追加だけでは型エラーにならない）

- [ ] **Step 6: コミット**

```bash
git add packages/web/src/components/TerminalPane.tsx packages/web/src/lib/canvas-tabs.ts packages/web/src/lib/canvas-tabs.test.ts packages/web/src/components/ViewerTabBar.tsx packages/web/src/hooks/useViewerTabs.ts packages/web/src/pages/Dashboard.tsx packages/web/src/components/SplitViewPane.tsx
git commit -m "feat(board): board タブ型と ark:open-canvas のボードルーティングを追加"
```

---

### Task 6: 依存導入と mermaid-to-board 変換

**Files:**
- Modify: `packages/web/package.json`（依存追加）
- Modify: `packages/web/vite.config.ts`
- Create: `packages/web/src/lib/mermaid-to-board.ts`
- Test: `packages/web/src/lib/mermaid-to-board.test.ts`

**Interfaces:**
- Consumes: 既存 `renderMermaidToSvg(code, id): Promise<{ ok: true; svg: string } | { ok: false; error: string }>`（`packages/web/src/lib/mermaid-block-utils.ts`）
- Produces:
  - `interface BoardConversionDeps { parse(code: string): Promise<{ elements: unknown[]; files?: Record<string, unknown> }>; convert(skeleton: unknown[]): unknown[]; renderSvg(code: string, id: string): Promise<{ ok: true; svg: string } | { ok: false; error: string }> }`
  - `convertMermaidForBoard(code: string, deps?: BoardConversionDeps): Promise<{ elements: unknown[]; files: Record<string, unknown>; fallback: boolean }>`
  - `computeInsertOffset(existing: Array<{ x: number; width: number }>, padding?: number): number`

- [ ] **Step 1: 依存をインストール**

```bash
pnpm --filter @ark/web add @excalidraw/excalidraw@0.18.1 @excalidraw/mermaid-to-excalidraw@2.2.2
```

Expected: `packages/web/package.json` の dependencies に 2 パッケージが追加される

- [ ] **Step 2: vite.config.ts に Excalidraw 用 define を追加**

`packages/web/vite.config.ts` の `defineConfig({ ... })` に追加（`plugins` と同階層）:

```typescript
  // Excalidraw が参照する process.env をブラウザ向けに固定する（公式 Vite 手順）
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
```

- [ ] **Step 3: 失敗するテストを書く**

`packages/web/src/lib/mermaid-to-board.test.ts` を新規作成:

```typescript
import { describe, expect, it } from "vitest";
import {
  type BoardConversionDeps,
  computeInsertOffset,
  convertMermaidForBoard,
} from "./mermaid-to-board";

const okDeps: BoardConversionDeps = {
  parse: async () => ({ elements: [{ kind: "skeleton" }] }),
  convert: skeleton => skeleton.map(s => ({ ...(s as object), full: true })),
  renderSvg: async () => ({ ok: true, svg: "<svg/>" }),
};

describe("convertMermaidForBoard", () => {
  it("変換成功時は convert した要素を返す（fallback=false）", async () => {
    const result = await convertMermaidForBoard("graph TD; A-->B", okDeps);
    expect(result.fallback).toBe(false);
    expect(result.elements).toEqual([{ kind: "skeleton", full: true }]);
    expect(result.files).toEqual({});
  });

  it("parse が throw したら SVG 画像フォールバックする（fallback=true）", async () => {
    const deps: BoardConversionDeps = {
      ...okDeps,
      parse: async () => {
        throw new Error("Unsupported diagram type");
      },
      renderSvg: async () => ({
        ok: true,
        svg: '<svg width="600" height="400"><rect/></svg>',
      }),
    };
    const result = await convertMermaidForBoard("stateDiagram-v2", deps);
    expect(result.fallback).toBe(true);
    // 画像要素が 1 つ生成され、fileId が files に登録されている
    expect(result.elements).toHaveLength(1);
    const fileIds = Object.keys(result.files);
    expect(fileIds).toHaveLength(1);
    const file = result.files[fileIds[0]] as { mimeType: string; dataURL: string };
    expect(file.mimeType).toBe("image/svg+xml");
    expect(file.dataURL.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("parse も renderSvg も失敗したら throw する", async () => {
    const deps: BoardConversionDeps = {
      ...okDeps,
      parse: async () => {
        throw new Error("unsupported");
      },
      renderSvg: async () => ({ ok: false, error: "syntax error" }),
    };
    await expect(convertMermaidForBoard("broken", deps)).rejects.toThrow(
      "syntax error"
    );
  });
});

describe("computeInsertOffset", () => {
  it("既存要素がなければ 0", () => {
    expect(computeInsertOffset([])).toBe(0);
  });

  it("既存要素の右端 + padding を返す", () => {
    const existing = [
      { x: 0, width: 100 },
      { x: 200, width: 150 }, // 右端 350
    ];
    expect(computeInsertOffset(existing, 80)).toBe(430);
  });
});
```

- [ ] **Step 4: テストが失敗することを確認**

Run: `pnpm vitest run packages/web/src/lib/mermaid-to-board.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 5: 実装**

`packages/web/src/lib/mermaid-to-board.ts` を新規作成:

```typescript
/**
 * mermaid コード → Excalidraw 要素への変換。
 *
 * - 対応図種 (flowchart / sequence / class): parseMermaidToExcalidraw で
 *   skeleton を得て convertToExcalidrawElements で実要素化する（編集可能）
 * - 未対応図種: 既存の renderMermaidToSvg で SVG に描画し、画像要素として
 *   ボードに置く（編集不可だが周囲に付箋は置ける）
 *
 * ライブラリ関数は DI（BoardConversionDeps）で注入する。env=node の vitest
 * では DOM 依存の実ライブラリが動かないため、テストは fake deps で行い、
 * 実配線（defaultDeps）は E2E で検証する。
 */
import { renderMermaidToSvg } from "./mermaid-block-utils";

export interface BoardConversionDeps {
  parse(code: string): Promise<{
    elements: unknown[];
    files?: Record<string, unknown>;
  }>;
  convert(skeleton: unknown[]): unknown[];
  renderSvg(
    code: string,
    id: string
  ): Promise<{ ok: true; svg: string } | { ok: false; error: string }>;
}

let convSeq = 0;

async function loadDefaultDeps(): Promise<BoardConversionDeps> {
  const [{ parseMermaidToExcalidraw }, { convertToExcalidrawElements }] =
    await Promise.all([
      import("@excalidraw/mermaid-to-excalidraw"),
      import("@excalidraw/excalidraw"),
    ]);
  return {
    parse: code => parseMermaidToExcalidraw(code),
    convert: skeleton =>
      // ライブラリの skeleton 型はここでは不問（実要素化のみ担う）
      convertToExcalidrawElements(
        skeleton as Parameters<typeof convertToExcalidrawElements>[0]
      ) as unknown[],
    renderSvg: renderMermaidToSvg,
  };
}

/** SVG 文字列から width/height を抽出（無ければ既定値） */
function svgSize(svg: string): { width: number; height: number } {
  const w = /\bwidth="([\d.]+)/.exec(svg);
  const h = /\bheight="([\d.]+)/.exec(svg);
  return {
    width: w ? Math.min(Number(w[1]), 800) : 600,
    height: h ? Math.min(Number(h[1]), 800) : 400,
  };
}

export async function convertMermaidForBoard(
  code: string,
  deps?: BoardConversionDeps
): Promise<{
  elements: unknown[];
  files: Record<string, unknown>;
  fallback: boolean;
}> {
  const d = deps ?? (await loadDefaultDeps());
  try {
    const parsed = await d.parse(code);
    return {
      elements: d.convert(parsed.elements),
      files: parsed.files ?? {},
      fallback: false,
    };
  } catch {
    // 未対応図種: SVG 画像フォールバック
    const rendered = await d.renderSvg(code, `mmd-board-${(convSeq += 1)}`);
    if (!rendered.ok) {
      throw new Error(rendered.error);
    }
    const { width, height } = svgSize(rendered.svg);
    const fileId = `board-svg-${Date.now()}-${convSeq}`;
    // btoa は Latin-1 のみ対応のため UTF-8 を安全にエンコードする
    const base64 = btoa(
      String.fromCharCode(...new TextEncoder().encode(rendered.svg))
    );
    const files: Record<string, unknown> = {
      [fileId]: {
        id: fileId,
        mimeType: "image/svg+xml",
        dataURL: `data:image/svg+xml;base64,${base64}`,
        created: Date.now(),
      },
    };
    const elements: unknown[] = [
      {
        type: "image",
        fileId,
        x: 0,
        y: 0,
        width,
        height,
      },
    ];
    return { elements, files, fallback: true };
  }
}

/** 既存要素の右端 + padding を新規挿入の X オフセットとして返す */
export function computeInsertOffset(
  existing: Array<{ x: number; width: number }>,
  padding = 80
): number {
  if (existing.length === 0) return 0;
  const rightEdge = Math.max(...existing.map(el => el.x + el.width));
  return rightEdge + padding;
}
```

注意: `btoa` は vitest の env=node（Node 20+）でもグローバルに存在する。

- [ ] **Step 6: テストが通ることを確認**

Run: `pnpm vitest run packages/web/src/lib/mermaid-to-board.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 7: 型チェックとコミット**

```bash
pnpm check
git add packages/web/package.json pnpm-lock.yaml packages/web/vite.config.ts packages/web/src/lib/mermaid-to-board.ts packages/web/src/lib/mermaid-to-board.test.ts
git commit -m "feat(board): Excalidraw 依存導入と mermaid→ボード要素変換を追加"
```

---

### Task 7: CanvasPane 本体と右ペイン組み込み

**Files:**
- Create: `packages/web/src/components/CanvasPane.tsx`
- Modify: `packages/web/src/components/TerminalPane.tsx`（props に socket 追加 + board 描画分岐）
- Modify: `packages/web/src/components/SplitViewPane.tsx:216-233`（socket を TerminalPane に渡す）

**Interfaces:**
- Consumes: Task 2 の `canvas:load` / `canvas:save` / `canvas:send-to-claude` / `canvas:updated`、Task 3 の `buildBoardDiffText` / `BoardElementLike`、Task 4 の `subscribeBoardInserts`、Task 6 の `convertMermaidForBoard` / `computeInsertOffset`
- Produces: `CanvasPane({ socket, sessionId, worktreePath })` コンポーネント。`TerminalPane` に `socket?: TypedSocket | null` prop 追加

- [ ] **Step 1: CanvasPane を実装**

`packages/web/src/components/CanvasPane.tsx` を新規作成:

```tsx
/**
 * CanvasPane - セッション・ホワイトボード（worktree 単位で 1 枚）
 *
 * - Excalidraw は遅延チャンク（await import）でロードする
 * - scene は canvas:save でデバウンス自動保存（サーバー側 SQLite が正）
 * - 「Claude に送る」で前回送信時との diff を自然文整形し session:send 経路で送信
 * - board-bus 経由でチャットの mermaid 図を編集可能要素として受け入れる
 */
import type { ClientToServerEvents, ServerToClientEvents } from "@ark/shared";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Socket } from "socket.io-client";
import { subscribeBoardInserts } from "../lib/board-bus";
import {
  type BoardElementLike,
  buildBoardDiffText,
} from "../lib/canvas-diff-utils";
import {
  computeInsertOffset,
  convertMermaidForBoard,
} from "../lib/mermaid-to-board";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 使用する Excalidraw API の最小面（バージョン固有の型 export 経路に依存しない） */
interface ExcalidrawApiLike {
  getSceneElements(): readonly BoardElementLike[];
  getFiles(): Record<string, unknown>;
  updateScene(scene: { elements: unknown[] }): void;
  addFiles(files: unknown[]): void;
}

const ExcalidrawLazy = lazy(async () => {
  const mod = await import("@excalidraw/excalidraw");
  await import("@excalidraw/excalidraw/index.css");
  return { default: mod.Excalidraw };
});

const SAVE_DEBOUNCE_MS = 1000;

interface CanvasPaneProps {
  socket: TypedSocket | null;
  sessionId: string;
  worktreePath: string;
}

export function CanvasPane({
  socket,
  sessionId,
  worktreePath,
}: CanvasPaneProps) {
  const apiRef = useRef<ExcalidrawApiLike | null>(null);
  const lastSentElementsRef = useRef<BoardElementLike[]>([]);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [initialData, setInitialData] = useState<{
    elements: unknown[];
    files?: Record<string, unknown>;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sendState, setSendState] = useState<
    "idle" | "sending" | "sent" | "no-change" | "error"
  >("idle");

  /** 現 scene を JSON 文字列化する（保存・送信共通） */
  const serializeScene = useCallback((): string | null => {
    const api = apiRef.current;
    if (!api) return null;
    return JSON.stringify({
      elements: api.getSceneElements(),
      files: api.getFiles(),
    });
  }, []);

  // 初期ロード（worktree ごとに 1 回）
  useEffect(() => {
    if (!socket) return;
    setLoaded(false);
    socket.emit("canvas:load", worktreePath, response => {
      try {
        const scene = response.scene
          ? (JSON.parse(response.scene) as {
              elements?: unknown[];
              files?: Record<string, unknown>;
            })
          : null;
        setInitialData({
          elements: scene?.elements ?? [],
          files: scene?.files,
        });
        const lastSent = response.lastSentScene
          ? (JSON.parse(response.lastSentScene) as {
              elements?: BoardElementLike[];
            })
          : null;
        lastSentElementsRef.current = lastSent?.elements ?? [];
      } catch {
        // 壊れた scene は空ボードとして開く（保存で上書きされる）
        setInitialData({ elements: [] });
        lastSentElementsRef.current = [];
      }
      setLoaded(true);
    });
  }, [socket, worktreePath]);

  // デバウンス保存
  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const scene = serializeScene();
      if (!scene || !socket) return;
      socket.emit("canvas:save", { worktreePath, scene });
      dirtyRef.current = false;
    }, SAVE_DEBOUNCE_MS);
  }, [socket, worktreePath, serializeScene]);

  useEffect(() => {
    return () => {
      // アンマウント時: 未保存分を即時 flush
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (dirtyRef.current && socket) {
        const scene = serializeScene();
        if (scene) socket.emit("canvas:save", { worktreePath, scene });
      }
    };
  }, [socket, worktreePath, serializeScene]);

  // board-bus: mermaid 挿入依頼を購読
  useEffect(() => {
    return subscribeBoardInserts(worktreePath, async insert => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const { elements, files } = await convertMermaidForBoard(insert.code);
        const existing = api.getSceneElements();
        const offsetX = computeInsertOffset(
          existing.map(el => ({ x: el.x, width: el.width }))
        );
        const shifted = (elements as Array<Record<string, unknown>>).map(
          el => ({
            ...el,
            x: ((el.x as number) ?? 0) + offsetX,
          })
        );
        const fileList = Object.values(files);
        if (fileList.length > 0) api.addFiles(fileList);
        api.updateScene({ elements: [...existing, ...shifted] });
        scheduleSave();
      } catch (error) {
        console.error("ボードへの図の挿入に失敗:", error);
      }
    });
  }, [worktreePath, scheduleSave]);

  // 他クライアントの保存: 自分が未編集なら再読込
  useEffect(() => {
    if (!socket) return;
    const handler = ({ worktreePath: updated }: { worktreePath: string }) => {
      if (updated !== worktreePath || dirtyRef.current) return;
      socket.emit("canvas:load", worktreePath, response => {
        const api = apiRef.current;
        if (!api || !response.scene) return;
        try {
          const scene = JSON.parse(response.scene) as {
            elements?: unknown[];
            files?: Record<string, unknown>;
          };
          if (scene.files) api.addFiles(Object.values(scene.files));
          api.updateScene({ elements: scene.elements ?? [] });
        } catch {
          // 壊れた scene は無視
        }
      });
    };
    socket.on("canvas:updated", handler);
    return () => {
      socket.off("canvas:updated", handler);
    };
  }, [socket, worktreePath]);

  // Claude に送る
  const handleSend = useCallback(() => {
    const api = apiRef.current;
    if (!api || !socket) return;
    const current = [...api.getSceneElements()];
    const text = buildBoardDiffText(lastSentElementsRef.current, current);
    if (!text) {
      setSendState("no-change");
      setTimeout(() => setSendState("idle"), 2000);
      return;
    }
    const scene = serializeScene();
    if (!scene) return;
    setSendState("sending");
    socket.emit(
      "canvas:send-to-claude",
      { sessionId, worktreePath, text, scene },
      response => {
        if (response.ok) {
          lastSentElementsRef.current = current;
          setSendState("sent");
        } else {
          console.error("ボード送信に失敗:", response.error);
          setSendState("error");
        }
        setTimeout(() => setSendState("idle"), 2000);
      }
    );
  }, [socket, sessionId, worktreePath, serializeScene]);

  if (!loaded || !initialData) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        ボードを読み込み中...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-border border-b px-3 py-1.5">
        <span className="font-medium text-foreground text-sm">
          🎨 ボード
        </span>
        <div className="flex items-center gap-2">
          {sendState === "no-change" && (
            <span className="text-muted-foreground text-xs">変更なし</span>
          )}
          {sendState === "sent" && (
            <span className="text-muted-foreground text-xs">送信しました</span>
          )}
          {sendState === "error" && (
            <span className="text-destructive text-xs">送信に失敗しました</span>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={sendState === "sending"}
            className="rounded bg-primary px-2 py-1 text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50"
            title="前回送信以降のボード変更を Claude に伝える"
          >
            {sendState === "sending" ? "送信中..." : "Claude に送る"}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              エディタを読み込み中...
            </div>
          }
        >
          <ExcalidrawLazy
            // biome-ignore lint/suspicious/noExplicitAny: バージョン固有の型 export 経路に依存しないため最小面へ cast
            excalidrawAPI={(api: any) => {
              apiRef.current = api as ExcalidrawApiLike;
            }}
            initialData={initialData as never}
            onChange={scheduleSave}
          />
        </Suspense>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TerminalPane に socket prop と board 描画分岐を追加**

`packages/web/src/components/TerminalPane.tsx`:

import に追加:

```typescript
import type { Socket } from "socket.io-client";
import { CanvasPane } from "./CanvasPane";
```

`TerminalPaneProps` に追加（`session: ManagedSession;` の後）:

```typescript
  /** ボードタブ用（未指定ならボードタブは案内表示のみ） */
  socket?: Socket<ServerToClientEvents, ClientToServerEvents> | null;
```

（`ServerToClientEvents, ClientToServerEvents` が未 import なら `@ark/shared` からの既存 import に追加する）

canvas タブ描画分岐（587 行付近）の直後に追加:

```tsx
      {tabs[activeTabIndex]?.type === "board" && (
        <div className="flex-1 min-h-0">
          {props.socket !== undefined ? (
            <CanvasPane
              socket={props.socket}
              sessionId={session.id}
              worktreePath={session.worktreePath}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              ボードはこのビューでは利用できません
            </div>
          )}
        </div>
      )}
```

注意: このファイル内で props を分割代入している場合は既存の記法に合わせること（`session` は既に分割代入されている前提で `props.socket` / `session.id` の参照を調整する）。`ManagedSession` に `worktreePath` フィールドが存在することは `useViewerTabs` の `sessions: Map<string, { worktreePath: string }>` で確認済み。

- [ ] **Step 3: SplitViewPane から socket を渡す**

`packages/web/src/components/SplitViewPane.tsx` の `<TerminalPane` に prop 追加:

```tsx
          <TerminalPane
            socket={props.socket}
            session={props.session}
            ...（既存のまま）
```

- [ ] **Step 4: 型チェックとテスト**

```bash
pnpm check          # 自分の変更起因のエラー 0
pnpm vitest run     # 全テスト PASS
```

- [ ] **Step 5: コミット**

```bash
git add packages/web/src/components/CanvasPane.tsx packages/web/src/components/TerminalPane.tsx packages/web/src/components/SplitViewPane.tsx
git commit -m "feat(board): Excalidraw ホワイトボード CanvasPane を右ペインに組み込み"
```

---

### Task 8: 統合検証と CLAUDE.md 更新

**Files:**
- Modify: `CLAUDE.md`（実装済み機能テーブル）
- 検証のみ: ビルド + 実機 E2E

- [ ] **Step 1: フルビルドとテスト**

```bash
pnpm check        # 自分の変更起因のエラー 0（input-otp.tsx は既知ベースライン）
pnpm vitest run   # 全テスト PASS（既存 355+ / 新規 25 前後）
pnpm build        # ビルド成功。Excalidraw が独立チャンクになっていることを dist の chunk 一覧で確認
```

Expected: すべて成功。`packages/web/dist/assets/` に excalidraw を含む遅延チャンクが生成される

- [ ] **Step 2: 実機 E2E（dev サーバー）**

```bash
pnpm dev:server   # localhost:4001（別ターミナル or run_in_background）
```

agent-browser / headless chromium で以下を検証する:

1. セッションを開く → チャットで `mermaidの図で何か説明して` 等を送り、mermaid ブロックを出させる
2. 「⤢ キャンバスで開く」をクリック → 右ペインが自動表示され「🎨 ボード」タブが開く
3. 図が**編集可能な要素**として配置されている（ノードをドラッグで動かせる）
4. テキストツールで付箋を追加 → 1 秒後に自動保存（サーバーログ or リロードで残存確認）
5. ページをリロード → ボード内容が復元される（SQLite 永続化の確認）
6. 「Claude に送る」をクリック → チャット入力欄経路で `[ボード更新]` で始まるメッセージがユーザー発言として送信され、Claude が反応する
7. 変更せずもう一度「Claude に送る」→「変更なし」表示で送信されない
8. `stateDiagram-v2` など未対応図種で「キャンバスで開く」→ SVG 画像として配置される（フォールバック確認）
9. モバイル幅（MobileLayout）では従来どおり図解ビューワータブが開く（回帰確認）

- [ ] **Step 3: CLAUDE.md の実装済み機能テーブルに 1 行追加**

「チャットビュー (PC デフォルト)」行の下に追加:

```markdown
| セッションボード       | worktree 単位の Excalidraw ホワイトボード（右ペインタブ）。mermaid 図の編集可能配置 + ボード変更の diff を Claude へ還流 |
```

- [ ] **Step 4: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: セッションボード機能を CLAUDE.md に追記"
```

- [ ] **Step 5: 完了確認**

- 全タスクのテストが PASS していること
- `docs/superpowers/` 配下がコミットされていないこと（`git status` で確認）
- PR 作成時は `/pre-push-review` が必須（このリポジトリの規約）

---

## Self-Review 結果（作成時に実施済み）

- **Spec coverage**: 設計判断 5 点（操作モデル/範囲/還流トリガー/技術/還流経路）→ Task 5-7 / 1 / 7 / 6 / 2。データモデル → Task 1。Socket.IO 4 イベント → Task 2。diff 仕様（id ベース・座標なし・接続関係）→ Task 3。未対応図種フォールバック → Task 6。セッション未起動時の送信不活性は v1 では CanvasPane が socket 経由で送るため、セッション停止中はサーバー側 `sendMessage` が throw し「送信に失敗しました」表示になる（許容。ボタン不活性化は将来改善）
- **Placeholder scan**: なし
- **Type consistency**: `BoardElementLike` は Task 3 定義を Task 7 が import。`convertMermaidForBoard` / `computeInsertOffset` は Task 6 定義を Task 7 が import。DB メソッド 4 種は Task 1 定義を Task 2 が使用
