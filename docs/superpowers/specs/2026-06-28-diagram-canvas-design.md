# 図解キャンバス (Diagram Canvas) 設計

> ステータス: ドラフト / 2026-06-28 / superpowers:brainstorming 由来
> 注: 本ファイルは project 規約により git にコミットしない。

## 1. 背景と目的

テキスト主体の AI チャットは認知負荷が高い。Claude が要点を図にして専用キャンバスへ出し、
ユーザーが図に注釈ピンを置いてコメントを会話へ返すループで、「読む負荷の軽減」と
「図を介した双方向フィードバック」を両立する。

## 2. ゴール / 非ゴール

**ゴール**
- Claude の応答中の図（mermaid 等）を実チャットにリッチ描画する
- Claude が意図的に図をキャンバスへ出せる（MCP `canvas_render`）
- ユーザーが図に注釈を付け、会話へ戻せる（注釈→tmux→Claude→図更新）
- リロード・サーバー再起動後もキャンバス成果物が残る

**非ゴール (v1)**
- Excalidraw 風の共同編集（図は読む＋注釈のみ）
- HTML アーティファクトの直接描画（サンドボックス iframe が必要 → v2）
- KaTeX 数式（v1.1 候補）、モバイルでの注釈編集（v1 は閲覧のみ想定）

## 3. 全体アーキテクチャ

```
[Claude] --canvas_render(MCP)--> [ark MCP] --> [SQLite: canvas_artifacts]
                                      |
                                 Socket.IO: session:canvas-*
                                      v
[右ペイン "キャンバス" タブ] <-- 共有レンダラー(Mermaid + Markdown) -- 描画
        |
   ユーザー注釈ピン --> [SQLite: canvas_annotations]
        |
   「フィードバック送信」--> テキスト整形 --> 既存 session:send --> tmux --> [Claude]
```

**情報源分離の原則**: キャンバス内容は「Claude の MCP push」または「transcript の図ブロック昇格」
と「ユーザーの注釈」という明示ソースのみ。tmux capture-pane の画面テキストはパースしない。

## 4. 共有レンダラー（全 Phase 共通の基盤）

`DiagramRenderer` をチャット内インラインとキャンバスの両方で共用する。
- `mermaid`（`securityLevel: 'strict'`、クリック/スクリプト注入無効）でフロー/シーケンス/ER/状態図等
- コードブロックは既存 `shiki`（現在 `FileViewerPane` で使用）でハイライト
- Markdown は既存 `react-markdown` パイプライン（外部 img 遮断・`ark-file://` 対応は #212 のまま）
- mermaid 構文エラー時は生コードブロック＋エラーバッジへフォールバック（ペインを落とさない）
- **ストリーミング対策**: assistant text は JSONL tail で逐次更新されるため、未完成の
  mermaid を描画しない。フェンスが閉じた（```で閉端）コードブロックのみ描画、かつ
  300ms デバウンスで再描画を抑制する。

## 5. Phase 別設計（Phase 1 を最初に landing → 実セッションで即利用可能）

### Phase 1: チャット内インライン描画（MCP 不要・最小・即価値）
- `packages/web` に `mermaid` 依存追加
- `SplitChatPane` の markdown `code` コンポーネント分岐: 言語 `mermaid` → `MermaidBlock`、
  その他言語 → shiki ハイライト
- 受け入れ条件: Claude が ` ```mermaid ` を書くと実チャットに図が出る。リロード・再起動でも
  transcript から再現される（情報源分離と整合）。

### Phase 2: キャンバスタブ + push + 永続化
**2a — transcript 昇格（MCP 不要の踏み石）**
- `TerminalPane` の `ViewerTab` 判別共用体に `{ type: "canvas"; id; artifactId; ... }` を追加
- transcript 中の最新 mermaid/図ブロックを検出し「キャンバス」タブへ自動表示
- `useSessionJsonl` と同型の `useCanvasArtifacts` フック（`session:canvas-subscribe/snapshot/added`）
- これにより MCP 無しでもキャンバス体験が成立する

**2b — MCP `canvas_render`（意図的 push）**
- `ark-mcp-server.ts` に `canvas_render({ kind, title, content })` ツールを追加（artifactId を返す）
- **最大の地雷**: 通常 worktree セッションには現状 MCP が注入されていない（MCP は Beacon 専用、
  `beacon-cli-session.ts` の `--mcp-config`）。通常セッションへ `--mcp-config` + `--strict-mcp-config`
  を注入する経路を新設し、token→sessionId マップで呼び出しをセッションに紐付ける。
  C-B 制約（起動時固定 / リセットで会話文脈クリア）を踏襲する。
- 永続化: `canvas_artifacts` テーブル（§6）。Socket.IO で全クライアントへ broadcast
- 受け入れ条件: Claude が `canvas_render` を呼ぶとキャンバスタブが自動で開き図が出る。
  リロード・再起動後も SQLite から復元される。

### Phase 3: 注釈 + tmux 還流（双方向ループ完成）
- `AnnotationLayer`: 図の上をクリックして番号付きピン（座標%ベース、SVG ノード ID 依存は不採用）
- **アンカー検出**: ピン直下の SVG 要素ラベルを best-effort で取得。Mermaid v10 は HTML ラベル
  （`foreignObject` 内 `.nodeLabel`）で描画するため、`.nodeLabel`/`foreignObject` を優先し、
  無ければ `tspan`/`text` にフォールバックする（※デモ実機検証でこの不具合を発見・確認済み）
- 永続化: `canvas_annotations` テーブル（§6）
- 「フィードバック送信」→ サーバーで整形テキスト生成 → `tmuxManager.sendKeys`（既存 session:send 経路）
- 整形例:
  ```
  [図解フィードバック] 「認証フロー」図への注釈:
  - ノード"OAuth検証"付近(ピン1): ここはJWT検証では?
  - ノード"DB"付近(ピン2): トークンの寿命は?
  ```
- 受け入れ条件: 注釈→会話に整形テキスト→Claude 応答→`canvas_render` で図更新、のループが回る。

## 6. データモデル (SQLite, `database.ts` の流儀に倣う)

```sql
CREATE TABLE IF NOT EXISTS canvas_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'diagram' | 'document'
  title TEXT,
  content TEXT NOT NULL,          -- Markdown(mermaid ブロック可)
  created_at TEXT NOT NULL,       -- ISO (既存 sessions テーブルに合わせ TEXT)
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvas_artifacts_session ON canvas_artifacts(session_id);

CREATE TABLE IF NOT EXISTS canvas_annotations (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  pin_no INTEGER NOT NULL,
  x_pct REAL NOT NULL,
  y_pct REAL NOT NULL,
  anchor TEXT,                    -- 'ノード"OAuth検証"' / '(位置のみ)'
  comment TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES canvas_artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvas_annotations_artifact ON canvas_annotations(artifact_id);
```

## 7. インターフェース

**Socket.IO (server→client)**: `session:canvas-snapshot`（購読時）, `session:canvas-added`,
`session:canvas-updated`（注釈更新）
**Socket.IO (client→server)**: `session:canvas-subscribe`/`unsubscribe`,
`session:canvas-annotate`（ピン CRUD）, `session:canvas-feedback`（整形送信トリガー）
**MCP ツール**: `canvas_render({ kind: 'diagram'|'document', title: string, content: string }) -> { artifactId }`

## 8. セキュリティ
- mermaid `strict`、Markdown は raw HTML 不許可（既存設定踏襲）、外部 img 遮断は #212 のまま
- `canvas_render` の content は assistant 由来だが無条件信用せずサニタイズ
- MCP は Bearer token（`ark-mcp-server.ts` 既存方式）。通常セッション注入時も token をセッション固有に

## 9. エラー処理
- mermaid 構文エラー / 空 content / 巨大 content の各フォールバック
- MCP 起動失敗時は degraded（Phase 2a の transcript 昇格は動作継続）
- ストリーミング中の未完成 mermaid は描画しない（§4）

## 10. テスト戦略
- 単体: レンダラー(成功/構文エラー)、アンカー抽出(htmlLabels `.nodeLabel` 含む)、
  注釈整形シリアライズ、DB CRUD
- 結合: MCP→Socket.IO→描画、注釈→tmux 送信、リロード/再起動復元
- E2E: Playwright（デモで実証済みの headless chromium + `--no-sandbox` 方式）で実アプリを検証

## 11. リスクと地雷（eng-review 対象）
1. **通常セッションへの MCP 注入**（最大）。緩和: Phase 2a の transcript 昇格で
   キャンバスを MCP から分離し、MCP push は 2b に後置。C-B 制約を踏襲。
2. ストリーミング中の部分 mermaid 描画 → フェンス閉端 + デバウンス
3. 再描画をまたぐピン位置の安定性 → 座標%ベース、スワップ時はピンクリア許容
4. `ViewerTab` 統合 vs 独立ペイン → 既存タブ機構（`ViewerTabBar`）に `canvas` 追加で統合

## 12. 段階リリース方針
Phase 1 → 2a → 2b → 3 の順で各段を landing。Phase 1 だけでも実セッションで即使えるため、
「フル実装」と「早く使う」を両立する。
