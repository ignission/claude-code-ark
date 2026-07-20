# セッション・ホワイトボード（思考整理キャンバス）設計

日付: 2026-07-16
状態: 設計承認済み（ユーザーレビュー待ち）
先行 spec: `2026-06-28-diagram-canvas-design.md`（本 spec は軸2・軸3の実現形を更新する。Phase 1 = チャット内 mermaid 描画は実装・デプロイ済みで変更なし）

## 目的

チャット（テキスト）だけでは認知しづらい思考整理を、**自由編集できるホワイトボード**で支援する。
Claude の出した図をボード上に置き、ユーザーが情報を書き足し・コメントし、その変更を Claude が
読み取ってチャットに戻す、という往復ループを作る。

## 設計判断（ユーザー承認済み）

| 論点 | 決定 |
|---|---|
| 操作モデル | **自由編集ホワイトボード**（旧設計の「ビューワー+注釈ピン」を正式変更） |
| 範囲 | **各セッション単位**（worktree ごとに1ボード）。Beacon への展開は将来検討 |
| 還流トリガー | **明示送信ボタン**「Claude に送る」。前回送信以降の差分のみ送る |
| 技術 | **Excalidraw**（MIT）埋め込み + Claude は従来どおり mermaid 出力 → `@excalidraw/mermaid-to-excalidraw` で編集可能要素に変換 |
| 還流経路 | テキスト整形 → 既存 `session:send`（tmux send-keys）。**画面パース禁止・JSONL 正の原則を維持** |

旧設計5軸との関係: 軸1（図の出所 = Claude の mermaid 出力基調）・軸4（右ペインタブ化・遅延ロード）・
軸5（段階導入）は維持。軸2（キャンバス型）と軸3（還流の具体形）を本 spec で更新。

## アーキテクチャ

```
チャット → ボード: mermaid ブロックの「キャンバスで開く」(既存ボタン流用)
                  → mermaid-to-excalidraw で編集可能要素に変換 → ボードの空き位置に追加配置
ボード → Claude:  「Claude に送る」ボタン → lastSentScene との diff 抽出
                  → テキスト整形（追加/変更/削除・テキスト内容・接続関係）
                  → session:send でユーザー発言として送信（チャット履歴に可視）
```

### 配置

- 右ペインを「🖥 ターミナル / 🎨 ボード」のタブに拡張（`SplitViewPane.tsx`）
- Excalidraw は mermaid と同様 `await import()` で遅延チャンク化（バンドルサイズ対策・必須）

### コンポーネント / ファイル

- `packages/web/src/components/CanvasPane.tsx`（新規）: Excalidraw ラッパー。自動保存（デバウンス）、
  「Claude に送る」ボタン、チャットからの要素追加受け口
- `packages/web/src/lib/canvas-diff-utils.ts`（新規・純ロジック）: scene diff 抽出 + テキスト整形
- `packages/web/src/lib/mermaid-to-board.ts`（新規・純ロジック寄り）: mermaid → Excalidraw 要素変換の
  ラッパー（未対応図種の SVG 画像フォールバック含む）
- `packages/web/src/components/MermaidBlock.tsx`（変更）: 「キャンバスで開く」をボードへの要素追加に接続
- `packages/server/src/lib/database.ts`（変更）: `canvas_boards` テーブル追加
- `packages/shared/src/types.ts`（変更): Socket.IO イベント型追加

### データモデル（SQLite）

`canvas_boards`:
- `worktree_id` TEXT PRIMARY KEY
- `scene` TEXT（Excalidraw scene JSON）
- `last_sent_scene` TEXT（前回送信時のスナップショット。diff の基準）
- `updated_at` INTEGER

**ボードは worktree 単位で1枚**。セッション再起動・`/clear` を跨いで生存する（思考の蓄積が目的の
ため会話より長寿命）。worktree 削除時は `worktree:delete` ハンドラ内で明示削除する
（worktrees の親テーブルは存在しないため CASCADE は使えない。`worktree_display_names` と同じ扱い）。

### Socket.IO イベント

- C→S: `canvas:load`（worktreeId → scene 返却）、`canvas:save`（デバウンス済み scene）、
  `canvas:send-to-claude`（sessionId, 整形済みテキスト。内部で session:send と同経路）
- S→C: `canvas:updated`（他クライアントの保存を反映。同一 worktree を開く複数クライアント向け）

## diff 整形の仕様

- 要素 id ベースで **追加 / 変更 / 削除** を検出
- 送る内容: 要素種別（カード/付箋/矢印/図形）、テキスト内容、接続関係（矢印の from 要素 → to 要素）、
  変更前後のテキスト
- **座標の生値は送らない**。空間関係は「〜の近くに」「同一グループ」程度の要約に留める
  （トークン節約と LLM の読解性のため）
- 整形例:
  ```
  [ボード更新]
  追加: 付箋「認証は Phase 2 に回す」（ノード「ログイン機能」の近く）
  追加: 矢印「セッション管理」→「Redis 検討」
  変更: カード「API 設計」のテキストを「API 設計 (REST で確定)」に変更
  削除: 付箋「GraphQL 案」
  ```
- 送信成功時に `last_sent_scene` を現 scene で更新

## エッジケース

- **未対応 mermaid 図種**（mermaid-to-excalidraw の対応は flowchart / sequence / class が中心）:
  SVG 画像要素としてボードに配置。要素編集は不可だが周囲に付箋・カードは置ける
- **セッション未起動でボードだけ編集**: 保存は可能。「Claude に送る」はセッション稼働中のみ活性
- **busy 中の送信**: 既存 session:send と同じ扱い（pending 表示に乗る）
- **Beacon**: v1 対象外。**モバイル**: v1 は PC のみ（Excalidraw 自体はタッチ対応なので後続で
  MobileSessionView へ展開可能）

## テスト方針

- ルート vitest は env=node で `.tsx` を扱えない既知制約に従い、`canvas-diff-utils.ts` /
  `mermaid-to-board.ts` を純ロジックとして vitest で網羅（diff 検出・整形文・フォールバック分岐）
- UI は headless chromium で E2E（demo 検証と同じ手法）
- `pnpm check`（tsc --noEmit）必須。esbuild は型チェックしない教訓を踏襲

## スコープ外（将来拡張）

- Beacon チャットへのボード展開 / モバイル対応
- 図の自動ボード追加（現状は「キャンバスで開く」ボタン経由のみ）
- 旧設計 Phase 2 の `canvas_render` MCP push（Beacon 展開時に再検討）
- ボードの複数枚化・ボード間リンク
