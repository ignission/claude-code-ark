# 双方向ボード ↔ Claude（MCP）設計

日付: 2026-07-19
状態: 設計承認済み（ユーザーレビュー待ち）
先行 spec: `2026-07-16-session-whiteboard-design.md`（本 spec は「Claude に送る」ボタン方式を廃し、MCP による双方向インタラクティブ通信へ更新する）

## 目的

会話セッションの Claude とボード（Excalidraw）を **MCP ツールで双方向インタラクティブ**に接続する。

- **書き込み**: ユーザーが「図解して」と言えば Claude が**ボードに直接図を描く**（`board_write`）。
- **読み取り**: ユーザーがボードを編集したら、Claude が（送信ボタンなしで）**気づいて読む**（軽通知 → `board_read`）。

旧方式（「Claude に送る」ボタンで diff を手動送信）を廃止する。

## 設計判断（ユーザー承認済み）

| 論点 | 決定 |
|---|---|
| 通信モデル | **MCP ツールで Claude が能動に読み書き**（transcript 自動ブリッジや常時自動注入は不採用） |
| 対象 Claude | **per-worktree の会話セッション**（ユーザーがチャットしている claude）。Beacon ではない |
| 書き込み形式 | **Excalidraw 要素を直接**。Claude は簡略スキーマで形/位置/接続を指定し、**サーバが正規 Excalidraw 要素へ展開**する |
| 読み取り気づき | **軽通知 → `board_read`**。ボード編集を debounce し「[ボード更新: 追加X/変更Y/削除Z]」の件数のみをセッションへ注入。詳細は Claude が pull |
| MCP 配線 | **専用の session スコープ Board MCP（新規 `BoardMcpServer`）**。ArkMcpServer と同じ HTTP+bearer token パターン。司令塔ツールは混ぜない（最小権限） |
| 撤去 | 「Claude に送る」ボタン + `canvas:send-to-claude` 経路を撤去 |
| 維持 | 「キャンバスで開く」（手動 mermaid→board）は独立機能として残す。JSONL 正・画面パース禁止の原則を維持 |

## アーキテクチャ

```
[書き込み] ユーザー「図解して」→ 会話 claude が MCP board_write(elements) を呼ぶ
          → BoardMcpServer が token→worktree_path 解決 → 簡略要素を正規 Excalidraw 要素へ展開
          → canvas_boards.scene 保存 → canvas:updated push → CanvasPane 再描画（ボードタブ自動オープン）

[読み取り] ユーザーがボード編集 → canvas:save → debounce
          → 前回通知 scene との diff 件数を算出（canvas-diff-utils 流用）
          → セッションが非 busy なら tmux send-keys で「[ボード更新: 追加X/変更Y/削除Z]」を注入
          → 会話 claude が必要に応じて board_read() で全容取得
```

### コンポーネント / ファイル

- `packages/server/src/lib/board-mcp-server.ts`（新規）: HTTP MCP server（`BoardMcpServer` クラス + `createBoardMcpServer(deps, registry)`）。ArkMcpServer と同型（127.0.0.1・bearer token・Streamable HTTP・stateless per-request）。ツール `board_write` / `board_read`（+ `board_clear`）。
- `packages/server/src/lib/board-element-codec.ts`（新規・純ロジック）: 簡略スキーマ ⇔ 正規 Excalidraw 要素の相互変換（id/seed/version/矢印バインド生成、read 時の簡約化）。
- `packages/server/src/lib/session-orchestrator.ts`（変更）: セッション起動時に per-session token 生成 → registry 登録 → per-session mcp-config ファイル生成 → tmux 起動コマンドへ `--mcp-config` 追加。停止/復元時に registry 同期。
- `packages/server/src/lib/tmux-manager.ts`（変更）: 起動コマンドに `--mcp-config <path>` を追加（現状 `--settings` と同様の注入経路）。
- `packages/server/src/index.ts`（変更）: `canvas:save` 受信時の通知 debounce + busy 判定 + tmux 注入。`canvas:send-to-claude` ハンドラと関連イベントを撤去。
- `packages/server/src/lib/database.ts`（変更）: `canvas_boards.last_sent_scene` を通知 diff 基準として転用（意味変更、列追加なし。または `last_notified_scene` へ改名）。
- `packages/web/src/components/CanvasPane.tsx`（変更）: 「Claude に送る」ボタン撤去。`canvas:updated`（Claude 書き込み由来）受信時の再描画・競合退避を既存ロジックで処理。書き込み到着時にボードタブへ自動フォーカス。
- `packages/web/src/lib/canvas-diff-utils.ts`（流用）: 通知の件数算出（追加/変更/削除）に再利用。
- `packages/shared/src/types.ts`（変更）: `canvas:send-to-claude` 型を削除。必要なら通知系イベント型を追加。

### BoardMcpServer とスコープ

- ArkMcpServer と同じく **127.0.0.1 のみ listen + bearer token**。ただし token は **per-session**（各会話セッションに固有）。
- **registry**: `Map<token, { worktreePath: string; sessionId: string }>`。SessionOrchestrator が startSession で登録、stopSession で削除。ツールは request の bearer token から worktree を自動解決するため、**Claude は worktree を引数で渡さない**（誤指定・他 worktree 参照を構造的に排除）。
- **ポート永続化**（ArkMcpServer C-B3 と同型）: 稼働中セッションの mcp-config は URL(port) を焼き込むため、サーバ再起動後も**同じ port** に bind する必要がある。port を settings に永続化（`board_mcp_port`）。
- **token 永続化**: サーバ再起動時に既存 tmux セッションが持つ mcp-config の token で registry を復元できるよう、per-session token を sessions DB に保存し、`restoreExistingSessions()` で registry を再構築する。復元できない場合、そのセッションの board ツールは再起動（リセット）まで 401 になる（既知制約として明記）。

### MCP ツール仕様

`board_write`:
- 説明: 「ボードに図を描く。ユーザーが図解を求めたときに使う」
- input:
  - `elements`: 配列。各要素は簡略スキーマ:
    - `{ type: "rect"|"ellipse"|"diamond", id, x, y, w, h, text?, color? }`
    - `{ type: "text", id, x, y, text, color? }`
    - `{ type: "arrow", id, from, to, label? }`（from/to は要素 id。座標は端点解決）
  - `mode`: `"append"`（既存に追加）| `"replace"`（ボード全消去して置換）。既定 `append`
- 動作: codec で正規 Excalidraw 要素へ展開（seed/version/roundness/矢印 startBinding/endBinding 生成）→ 既存 scene とマージ（append）or 置換 → `canvas_boards` 保存（`updated_at` 更新）→ `canvas:updated` push。
- 返り: 追加/置換した要素数と現在の総要素数。

`board_read`:
- 説明: 「ボードの現在の内容を読む。ユーザーがボードに描いた/編集したものを確認するときに使う」
- input: なし（worktree は token から解決）
- 返り: 簡略要素リスト（write と対称: type/id/x/y/w/h/text/接続）+ 1 行サマリ（例「9 要素: 矩形3・テキスト4・矢印2」）。**座標は丸めて返す**（トークン節約）。scene が空なら「ボードは空です」。

`board_clear`（任意・Phase C）: ボードを空にする（確認は Claude の判断に委ねず、ユーザー明示要求時のみ使う旨を description に明記）。

### 読み取り通知の仕様

- `canvas:save`（ユーザー編集の保存）を worktree 単位で debounce（例 1.5s）。
- 直近通知時の scene（`last_notified_scene`）と現 scene の diff を canvas-diff-utils で算出し**件数のみ**（追加X/変更Y/削除Z）を得る。
- セッションが **busy でない**ときのみ（bridgeStatus の busy 判定を流用）、`sendMessage` 経路（tmux send-keys）で `[ボード更新: 追加X/変更Y/削除Z]（board_read で詳細確認可）` を注入。busy 中は保留し、次の非 busy 機会にまとめて通知。
- 注入成功時に `last_notified_scene` を現 scene へ更新。**Claude 自身の board_write に由来する canvas:updated は通知しない**（自己ループ防止。書き込み経路と保存経路を区別する）。
- 注入は**ユーザー可視のターン**として会話に残る（情報源分離を維持。画面パースはしない）。

## データモデル（SQLite）

`canvas_boards`（既存）:
- `worktree_path` TEXT PRIMARY KEY / `scene` TEXT / `updated_at` INTEGER
- `last_sent_scene` → **`last_notified_scene` に意味変更**（読み取り通知 diff の基準）。移行は列改名 or 既存列の再利用（既存データは通知基準として無害）。

セッション token 永続化（`sessions` テーブルに列追加 or 別テーブル）:
- `board_mcp_token` TEXT（per-session。復元時の registry 再構築用）

## エッジケース

- **Claude 書き込み中にユーザーも編集**: `canvas:updated` を受けた CanvasPane は既存の競合退避（dirty 維持・退避復元）ロジックで処理。Claude の append はユーザー編集を上書きしない（要素 id マージ）。replace はユーザーに破壊的なので description で「ユーザー明示要求時のみ」と誘導。
- **セッション未起動でボードだけ編集**: 通知先が無いので保留（保存は可能）。次回セッション起動時に通知はしない（古い編集の遡及通知はしない。board_read で取得可能）。
- **busy 中の連続編集**: 件数通知は最新 diff のみ（積算しない）。busy 明けに 1 回だけ注入。
- **未対応要素**（Claude が未知 type を渡す）: codec が検証し、無効要素はスキップ + 返り値で警告（scene は壊さない）。
- **サーバ再起動**: port 再 bind + token registry 復元（復元不能なら該当セッションの board ツールはリセットまで 401）。ArkMcpServer C-B1/C-B3 と同型の既知制約。
- **リモート/トンネル**: BoardMcpServer は 127.0.0.1 のみ。トンネル経由では到達不可（tmux 内 claude は同ホストなので問題なし）。

## 原則の維持（情報源分離）

- `board_read` は **DB（canvas_boards）を読む**。tmux 画面パースはしない。
- 読み取り通知は **`session:send` 経路の可視ターン**として注入（会話履歴に残る）。
- Claude の `board_write` は **MCP ツール呼び**として JSONL transcript に記録される。
- 会話内容は 100% JSONL、ボード内容は 100% SQLite、という分離を保つ。

## テスト方針

- `board-element-codec.ts`（簡略⇔正規変換・矢印バインド・read 簡約）を vitest で純ロジック網羅。
- BoardMcpServer のツール（board_write/read の scope 解決・append/replace・無効要素スキップ）を ark-mcp-server.test.ts と同様の手法でテスト。
- 通知 debounce + busy 判定 + 自己ループ防止をサーバ単体テスト。
- UI（自動オープン・競合退避）は headless chromium で E2E。
- `pnpm check`（tsc）必須。ルート vitest は env=node で `.tsx` 不可の既知制約に従い純ロジック中心。

## 段階導入

- **Phase A**: `BoardMcpServer` + `board_write` + session への `--mcp-config` 注入 + `canvas:updated` 再描画 + 自動オープン。→「図解して → Claude が描く」が成立。
- **Phase B**: `board_read` + 読み取り通知（debounce/busy/自己ループ防止）+ `last_notified_scene`。→ 双方向の read が成立。「Claude に送る」ボタン撤去。
- **Phase C**: `board_clear`・注釈 primitive の拡充・モバイル（MobileSessionView へ展開）・token registry 永続復元の堅牢化。

## スコープ外（将来）

- Beacon 会話へのボード展開（per-session スコープの外）
- 複数ボード・ボード間リンク
- 図の自動配置（Claude の mermaid 出力を transcript から自動でボード化する非 MCP 経路）
- リアルタイム共同編集（Excalidraw collaboration）
