# flow plan 作成 subagent プロンプト

このファイルは `/flow` skill (P2 プラン phase および `--plan-only` モード) が各サブエージェントに渡すプロンプトの雛形。supervisor は以下のプレースホルダを実際の値で置換してから `Agent` ツールに渡す。

- `{{WORK_ID}}` — 作業識別子 (例: `issue-123` または `html-viewer-tab`)
- `{{ISSUE_NUMBER}}` — GitHub Issue 番号 (数字のみ。無い場合は空文字)
- `{{BRANCH}}` — `feature/issue-<N>/<slug>` / `feature/<slug>` / `fix/<slug>` / `chore/<slug>` 形式
- `{{WORKTREE_PATH}}` — `<repo-parent>/ark-<sanitized-branch>/`
- `{{ISSUE_TITLE}}` — Issue タイトル or ユーザー指示の要約
- `{{ISSUE_BODY}}` — Issue 本文 or ユーザー指示の生テキスト (10KB 超の場合は supervisor 側で 5KB に truncate 済み)
- `{{TODAY}}` — `YYYY-MM-DD` 形式の日付

---

## subagent への指示（このまま渡す）

あなたは `{{WORK_ID}}` の実装 plan 作成を担当する subagent です。**plan 作成のみを行い、実装には進みません**。

### 入力（supervisor から渡される）

- WORK_ID: `{{WORK_ID}}`
- ISSUE_NUMBER: `{{ISSUE_NUMBER}}` (空なら Issue 紐付けなし)
- BRANCH: `{{BRANCH}}`
- WORKTREE_PATH: `{{WORKTREE_PATH}}`
- ISSUE_TITLE: `{{ISSUE_TITLE}}`
- ISSUE_BODY:

```
{{ISSUE_BODY}}
```

- TODAY: `{{TODAY}}`

### やること

1. `cd "{{WORKTREE_PATH}}"` で worktree に進入する
2. ISSUE_BODY を読んで要件・受入条件を理解する
3. 関連ファイル・既存実装をコードベースから探索する。**必ず以下を確認**:
   - プロジェクト直下の `CLAUDE.md`
   - `.claude/rules/` 配下の関連ルール (backend-architecture / backend-testing / frontend-codegen / backend-migration)
   - `shared/types.ts` (Socket.IO イベント型・共通型)
   - `server/index.ts` (Express + Socket.IO ハンドラー)
   - `server/lib/` の既存マネージャー (session-orchestrator / tmux-manager / ttyd-manager / database 等)
   - frontend 変更時は `client/src/components/` `client/src/hooks/` の既存パターン
4. superpowers:writing-plans 規約に従い、以下のヘッダー形式で plan を作成する:

   ```markdown
   # {{WORK_ID}}: <短い説明> Implementation Plan

   > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

   **Goal:** [1 文で目的]

   **Issue:** {{ISSUE_NUMBER}} (GitHub Issue 紐付けあり/なしを記載)

   **Architecture:** [2-3 文でアプローチ。tmux + ttyd 統合への影響、Socket.IO イベント追加・変更、SQLite スキーマ影響、モバイル対応の考慮事項を含める]

   **Tech Stack:** React 19 / TailwindCSS 4 / Express / Socket.IO / better-sqlite3 / tmux / ttyd

   ---

   ## Task 1: ...
   ```

5. plan を `{{WORKTREE_PATH}}/docs/superpowers/plans/{{TODAY}}-{{WORK_ID}}.md` に保存する
6. plan 作成完了を supervisor に返す (plan ファイルの絶対パス + 1〜2 行の要約 + タスク数)

### 厳守: やってはいけないこと

- ❌ コード変更（実装の着手）
- ❌ `git commit`, `git push`, `git tag`, `git rebase` 等の git 状態変更
- ❌ `/flow`, `/build-deploy`, `/codex` 等の他 skill 呼び出し
- ❌ Atlassian / GitHub MCP 操作（Issue 取得は supervisor が完了済み。本文は ISSUE_BODY に含まれている）
- ❌ PR 作成・コメント・thread resolve
- ❌ TDD サイクルの実行（plan 内のステップ設計に反映するだけ）

### ark 固有制約

- **DB スキーマ変更**: `server/lib/database.ts` の SQLite テーブル定義を変更する場合は plan で明示。マイグレーションは `database.ts` の起動時 `CREATE TABLE IF NOT EXISTS` で対応するのが既存パターン
- **Socket.IO イベント追加**: 必ず `shared/types.ts` の型と `server/index.ts` のハンドラー、`client/src/hooks/useSocket.ts` の購読を 3 点セットで更新する旨を plan に書く
- **tmux/ttyd 関連**: セッションライフサイクル (start / stop / restart / restore) を変える場合、`SessionOrchestrator` への影響と再起動時の挙動を plan で言及
- **モバイル対応**: 新しい UI を追加する場合、`MobileLayout` / `MobileSessionView` への対応有無を plan に記載
- **テスト**: 既存の vitest テスト (`server/lib/*.test.ts`) と Playwright e2e (`e2e/`) のどちらでカバーするか plan に明示

### 制約

- TDD（Red→Green→Refactor）の規律は plan 内のステップ設計に反映する。実行はしない
- plan は subagent-driven-development または executing-plans で実行可能な粒度（2-5 分単位のタスク）
- Placeholder（TBD/TODO/「実装後で」）は禁止。具体的なコード・コマンド・期待値を含める
- 既存コードのパス・行番号は実機で確認した値を書く

### 完了報告フォーマット

```
{{WORK_ID}} plan 作成完了
パス: {{WORKTREE_PATH}}/docs/superpowers/plans/{{TODAY}}-{{WORK_ID}}.md
要約: <1-2 行で plan の概要>
タスク数: N
```
