# B-1 Excalidraw 撤去 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Excalidraw ベースのボード機能を撤去し、右ペインを B-0a の図ペイン（`DiagramPane`）に置き換える。

**Architecture:** 先に右ペインを差し替えて動く状態を作り（Task 1）、そのあとクライアント（Task 2）とサーバー（Task 3）の Excalidraw 資産を削除する。各タスクの終わりで `tsc -b` と全テストが通る状態を保つ。

**Tech Stack:** TypeScript / React 19 / Express / Socket.IO / vitest

## Global Constraints

- spec は `docs/superpowers/specs/2026-07-20-html-diagram-harness-design.md`。判断5「B-0 完了と同時に Excalidraw 撤去。共存期間を置かない」に従う
- 失われる機能は受容済み（spec §8）: 画像の貼り付け / 自由図形と自由描画 / mermaid の対応図種
- **引き継ぐもの（消さない）**: `BoardMcpServer` の HTTP / registry / 認証、`session-orchestrator` の board 配線と `append-system-prompt`、`managed-worktree.ts`、`HtmlViewerPane` 系、B-0a の `diagram-*` 一式
- server 側の相対 import には `.js` 拡張子。web 側は不要
- 型チェック `pnpm --dir . exec tsc -b`、テスト `pnpm --dir . exec vitest run` を各タスクの最後で通す
- コメントとコミットメッセージは日本語。Co-Authored-By は付けない
- `git add -A` / `git add .` を使わない

---

### Task 1: 右ペインを図ペインに差し替える

**Files:**
- Modify: `packages/web/src/components/SplitViewPane.tsx`
- Modify: `packages/web/src/components/TerminalPane.tsx`
- Modify: `packages/web/src/hooks/useViewerTabs.ts`

**Interfaces:**
- Consumes: `DiagramPane`（B-0a）、`ViewerTab` の `diagram` バリアント
- Produces: 右ペインに図が出る状態

このタスクでは Excalidraw をまだ消さない。右ペインの主が `CanvasPane` から `DiagramPane` に変わるだけにして、動く状態を保つ。

- [ ] **Step 1: diagram タブを右ペイン専属にする**

`useViewerTabs.ts` の `openDiagramTab` を、`openBoardTab` と同じく**アクティブタブを変更しない**形にする。理由は `openBoardTab` のコメント（L155-160）と同じで、右ペイン専属のタブをアクティブにすると左ペインが空白になるため。

`setSessionActiveTab` の呼び出しを削り、`setSessionTabs` だけにする。

- [ ] **Step 2: タブバーから diagram を除外する**

`TerminalPane.tsx` の `visibleTabIndexMap` を作る箇所（`tab.type === "board"` を弾いている行）で、`diagram` も弾く。

```ts
    if (tab.type === "board" || tab.type === "diagram") return;
```

あわせて `TerminalPane.tsx` の描画分岐から `diagram` の分岐を削除する（右ペインで描くため）。

- [ ] **Step 3: 右ペインで図を描く**

`SplitViewPane.tsx` で、`props.tabs` から最後の diagram タブを取り出す。

```ts
  // 右ペインに出す図（最後に開かれたもの）。diagram タブはタブバーから
  // 除外されており、ここでのみ描画される。
  const diagramTab = [...props.tabs].reverse().find(t => t.type === "diagram");
```

右ペインの中身を差し替える。`diagramTab` があれば `DiagramPane`、無ければ従来どおり `CanvasPane`。

```tsx
              {diagramTab && diagramTab.type === "diagram" ? (
                <DiagramPane
                  socket={props.socket}
                  worktreePath={diagramTab.worktreePath}
                  relPath={diagramTab.relPath}
                />
              ) : (
                <CanvasPane
                  socket={props.socket}
                  sessionId={props.session.id}
                  worktreePath={props.session.worktreePath}
                />
              )}
```

`DiagramPane` の import を足す。

- [ ] **Step 4: 図を開いたら右ペインを自動表示する**

自動表示の effect（`prevBoardCountRef` を使っている箇所）の数え上げに `diagram` を含める。

```ts
    const boardCount = props.tabs.filter(
      t => t.type === "board" || t.type === "canvas" || t.type === "diagram"
    ).length;
```

- [ ] **Step 5: 上部バーのラベルを実態に合わせる**

ボタンの文言が「ボード」固定だと、図を出しているときに実態と合わない。`diagramTab` の有無でラベルを変える。

```tsx
          title={showBoard ? "右ペインを閉じる" : diagramTab ? "図を開く" : "ボードを開く"}
        >
          <span>{diagramTab ? "📐" : "🎨"}</span>
          <span>{showBoard ? "閉じる" : diagramTab ? "図" : "ボード"}</span>
```

- [ ] **Step 6: 型チェックとテスト**

Run: `pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec tsc -b && pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec vitest run`
Expected: tsc は無出力、テスト全件 PASS

- [ ] **Step 7: コミット**

```bash
git add packages/web/src/components/SplitViewPane.tsx packages/web/src/components/TerminalPane.tsx packages/web/src/hooks/useViewerTabs.ts
git commit -m "feat(diagram): 図を右ペインに表示する"
```

---

### Task 2: クライアント側の Excalidraw 資産を削除する

**Files:**
- Delete: `packages/web/src/components/CanvasPane.tsx`（551行）
- Delete: `packages/web/src/components/CanvasViewerPane.tsx`（64行）
- Delete: `packages/web/src/lib/mermaid-to-board.ts`（132行）+ そのテスト
- Delete: `packages/web/src/lib/board-bus.ts`（125行）+ そのテスト
- Delete: `packages/web/src/lib/canvas-tabs.ts`（35行）+ そのテスト
- Delete: `packages/web/src/lib/canvas-diff-utils.ts`（168行）+ そのテスト
- Modify: `packages/web/src/components/SplitViewPane.tsx`、`TerminalPane.tsx`、`ViewerTabBar.tsx`、`MobileSessionView.tsx`、`MermaidBlock.tsx`、`useViewerTabs.ts`、`packages/web/package.json`、`packages/web/vite.config.ts`

- [ ] **Step 1: `ViewerTab` から board / canvas バリアントを削除する**

`TerminalPane.tsx` の `ViewerTab` から `{ type: "canvas"; ... }` と `{ type: "board"; ... }` を削除する。`tsc -b` を走らせ、壊れた箇所を列挙する。以降の Step はその列挙を潰していく作業になる。

- [ ] **Step 2: 「キャンバスで開く」導線を削除する**

`MermaidBlock.tsx` の `⤢ キャンバスで開く` ボタンと `ark:open-canvas` の postMessage を削除する。**mermaid のインライン描画自体は残す**（チャット内で図が見えること自体は失わない）。

`useViewerTabs.ts` から `ark:open-canvas` の受信、`openCanvasTab`、`openBoardTab`、`publishBoardInsert` の呼び出しを削除する。

- [ ] **Step 3: ファイルを削除する**

```bash
git rm packages/web/src/components/CanvasPane.tsx \
       packages/web/src/components/CanvasViewerPane.tsx \
       packages/web/src/lib/mermaid-to-board.ts packages/web/src/lib/mermaid-to-board.test.ts \
       packages/web/src/lib/board-bus.ts packages/web/src/lib/board-bus.test.ts \
       packages/web/src/lib/canvas-tabs.ts packages/web/src/lib/canvas-tabs.test.ts \
       packages/web/src/lib/canvas-diff-utils.ts packages/web/src/lib/canvas-diff-utils.test.ts
```

- [ ] **Step 4: 依存とビルド設定を削除する**

`packages/web/package.json` から `@excalidraw/excalidraw` と `@excalidraw/mermaid-to-excalidraw` を削除する。**`mermaid` は残す**（チャット内のインライン描画で使う）。

`packages/web/vite.config.ts` の Excalidraw 向け `define`（`process.env.IS_PREACT`）を削除する。

Run: `pnpm install`

- [ ] **Step 5: 型チェックとテスト**

Run: `pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec tsc -b && pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec vitest run`
Expected: tsc は無出力、テスト全件 PASS（削除したテストの分だけ件数が減る）

- [ ] **Step 6: コミット**

```bash
git add -u && git add packages/web/package.json pnpm-lock.yaml
git commit -m "refactor(board): クライアント側の Excalidraw 資産を削除"
```

---

### Task 3: サーバー側の Excalidraw 資産を削除する

**Files:**
- Delete: `packages/server/src/lib/board-element-codec.ts`（282行）+ そのテスト
- Modify: `packages/server/src/lib/board-mcp-server.ts`（`board_write` の削除）+ そのテスト
- Modify: `packages/server/src/index.ts`（`canvas:*` ハンドラ、`boardDeps` の scene 系）
- Modify: `packages/server/src/lib/database.ts`（`canvas_boards` の CRUD）+ `database.canvas.test.ts`
- Modify: `packages/shared/src/types.ts`（`canvas:*` イベント型）

- [ ] **Step 1: `board_write` ツールを削除する**

`board-mcp-server.ts` から `board_write` の `registerTool`、`handleBoardWrite`、`BoardWriteInput` / `BoardWriteResult`、`simpleElementSchema`、`board-element-codec` の import を削除する。

`BoardMcpDeps` から `getBoardScene` / `saveBoardScene` / `notifyUpdated` を削除し、`openDiagram` だけ残す。

**`BoardSessionRegistry` と `BoardMcpServer` クラス（HTTP / 認証 / registry）は消さない。** `board_open` がこれに乗っている。

`board-mcp-server.test.ts` から `handleBoardWrite` のテストを削除する（`handleBoardOpen` のテストは残す）。

- [ ] **Step 2: `canvas:*` ハンドラと board deps を削除する**

`index.ts` から `canvas:load` / `canvas:save` / `canvas:send-to-claude` のハンドラ、`canvasRoom`、`CANVAS_SCENE_MAX_BYTES` / `CANVAS_TEXT_MAX_BYTES` / `isValidSceneJson` / `isValidBaseRevision`、`boardDeps` の `getBoardScene` / `saveBoardScene` / `notifyUpdated` を削除する。

`worktree:delete` と `session:stop` にある `db.deleteCanvasBoard` の呼び出しも削除する。

- [ ] **Step 3: `canvas_boards` テーブルと CRUD を削除する**

`database.ts` から `canvas_boards` の `CREATE TABLE`、`getCanvasBoard` / `saveCanvasBoardScene` / `markCanvasBoardSent` / `deleteCanvasBoard` / `nextCanvasRevision` を削除する。

**既存 DB のテーブルは `DROP TABLE` しない。** 使われなくなるだけで害はなく、誤って落とすリスクの方が大きい。その旨をコメントに残す。

`git rm packages/server/src/lib/database.canvas.test.ts`

- [ ] **Step 4: shared の型を削除する**

`packages/shared/src/types.ts` から `canvas:load` / `canvas:save` / `canvas:send-to-claude` / `canvas:updated` を削除する。

- [ ] **Step 5: ファイルを削除する**

```bash
git rm packages/server/src/lib/board-element-codec.ts packages/server/src/lib/board-element-codec.test.ts
```

- [ ] **Step 6: 型チェックとテスト**

Run: `pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec tsc -b && pnpm --dir /home/admin/dev/github.com/ignission/claude-code-manager exec vitest run`
Expected: tsc は無出力、テスト全件 PASS

- [ ] **Step 7: コミット**

```bash
git add -u
git commit -m "refactor(board): サーバー側の Excalidraw 資産を削除"
```

---

### Task 4: ドキュメントの更新

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: ボード機能の記述を実装に合わせる**

`CLAUDE.md` の次を直す。

- 実装済み機能表の「セッションボード」の行を、Excalidraw ではなく `.diagram.html` ベースの記述にする
- Socket.IO イベント一覧から `canvas:load` / `canvas:save` / `canvas:send-to-claude` / `canvas:updated` を削除し、`diagram:open` / `diagram:updated` / `diagram:subscribe` / `diagram:unsubscribe` を追加する
- 技術スタック表に Excalidraw があれば削除する

- [ ] **Step 2: PC の UI 構成の記述を実態に合わせる**

**これは B-0a の受け入れ確認時に実害が出た箇所。** CLAUDE.md は「PC のデフォルト UI はチャットビュー (`SplitViewPane`)」「ttyd の生ターミナルは『🖥 ターミナル』トグルで on-demand 表示」と書いているが、実装は違う。

`SplitViewPane.tsx:6` に「会話ビュー（`SplitChatPane`）は使わない」と明記されており、実際は次のとおり。

- PC の左ペインは `TerminalPane`（ttyd + タブバー）が常時表示
- `SplitChatPane`（チャット）はモバイル専用（`MobileSessionView` からのみ使用）
- ターミナルのトグルは存在せず、上部バーのボタンは右ペインの開閉のみ

実装を読んで確認したうえで、記述を実態に合わせる。

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: ボード機能と PC の UI 構成の記述を実装に合わせる"
```

---

## B-1 の完了条件

1. `@excalidraw/*` への依存がリポジトリから消えている
2. 図が右ペインに表示され、ファイル更新で再投影される
3. `tsc -b` が無出力、全テストが PASS
4. ビルドとデプロイが通り、実機で図が表示される
