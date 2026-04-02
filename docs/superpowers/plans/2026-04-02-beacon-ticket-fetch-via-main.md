# Beacon「タスク着手」URL対応拡張 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Beaconの「タスク着手」コマンドフローを拡張し、ユーザーがチケット/IssueのURLを貼った場合にmainセッションのClaude Codeに内容取得とブランチ名提案を委譲するフローを追加する。

**Architecture:** 既存の`BEACON_SYSTEM_PROMPT`のみを変更するハイブリッド方式。専用MCPツールは追加せず、既存の`send_to_session` + `get_session_output`の組み合わせ手順をプロンプトで明文化する。

**Tech Stack:** TypeScript (beacon-manager.ts のシステムプロンプト文字列)

---

### Task 1: システムプロンプトの「タスク着手」セクションにURL分岐を追加

**Files:**
- Modify: `server/lib/beacon-manager.ts:75-112` (BEACON_SYSTEM_PROMPT内の「タスク着手」セクション)

- [ ] **Step 1: 現在の「タスク着手」セクション（行75-112）を以下のコードに置換する**

`server/lib/beacon-manager.ts` の `BEACON_SYSTEM_PROMPT` 内で、`### 「タスク着手」` セクション全体（行75の `### 「タスク着手」` から行112の `10. 「セッションを起動して...` まで）を以下に置換する:

```typescript
### 「タスク着手」

ユーザーが思いついたタスクを壁打ちし、Issue/チケットを作成してからworktreeで着手させるフロー。
ユーザーの入力にURL（http:// または https://）が含まれる場合は Phase 1b（URL経由）に進む。含まれない場合は Phase 1a（壁打ち）に進む。

#### Phase 1a: 壁打ち（URLなしの場合）
1. list_repositoriesで全リポジトリ一覧を取得
2. 番号付きリストでリポジトリを提示し、ユーザーに選ばせる
3. ユーザーがリポジトリを選択したら、タスクの内容をヒアリング
   - 「どんなタスクですか？」と聞く
   - ユーザーの説明を深掘り・整理する（目的、スコープ、受入条件など）
   - 壁打ちが十分と判断したら「この内容でIssue/チケットを作成しますか？」と要約を提示
4. → Phase 2へ進む

#### Phase 1b: URL経由（URLありの場合）
ユーザーがチケット/IssueのURLを貼って着手を依頼した場合のフロー。チケット内容の取得とブランチ名提案はmainセッションのClaude Codeに委譲する（mainはJira MCP、gh CLI等のフルツールアクセスを持つため）。

1. list_repositoriesで全リポジトリ一覧を取得
2. 番号付きリストでリポジトリを提示し、ユーザーに選ばせる
3. 選択されたリポジトリのmainワークツリーを特定する
   - list_worktreesでisMain=trueのworktreeを探す
4. mainのセッションを確認・起動する
   - list_sessionsで既存セッションを確認。mainのworktreeに紐づくセッションがあれば:
     - get_session_outputで状態を確認し、入力待ち/アイドルの場合のみそのセッションを流用する
     - 作業中や判断待ちの場合は「mainセッションが使用中です。中断してよいですか？」とユーザーに確認する
   - セッションがなければstart_sessionでmainのセッションを起動
5. mainセッションにチケット内容取得とブランチ名提案を指示する
   - send_to_sessionで以下を送信:
     「以下のURLのチケット/Issue内容を取得し、以下の形式で回答してください。\n\n## タスク要約\n- タイトル: ...\n- 説明: ...\n- 受入条件: ...（あれば）\n\n## ブランチ名提案\nfeat/xxx/slug の形式で1つ提案してください。\n\nURL: {ユーザーが貼ったURL}」
6. mainセッションの出力を監視する
   - get_session_outputを数回ポーリングし、タスク要約とブランチ名提案を検出する
   - 検出できない場合は「内容を取得できませんでした。mainセッションの状態を確認してください」と報告して終了
7. 取得した内容をユーザーに表示して確認する
   - タスク要約とブランチ名案を表示し、「この内容で着手しますか？」と確認
8. 確認OK → Phase 3へ進む（壁打ちで整理した要約の代わりに、mainから取得したタスク要約を使う。ブランチ名もmainの提案を使う）

#### Phase 2: Issue/チケット作成（mainセッション経由、Phase 1aからのみ）
4. 選択されたリポジトリのmainワークツリーを特定する
   - list_worktreesでisMain=trueのworktreeを探す
5. mainのセッションを確認・起動する
   - list_sessionsで既存セッションを確認。mainのworktreeに紐づくセッションがあれば:
     - get_session_outputで状態を確認し、入力待ち/アイドルの場合のみそのセッションを流用する
     - 作業中や判断待ちの場合は「mainセッションが使用中です。中断してよいですか？」とユーザーに確認する
   - セッションがなければstart_sessionでmainのセッションを起動
6. mainセッションにIssue/チケット作成を指示する
   - send_to_sessionで以下を送信:
     「以下のタスクのIssue（またはチケット）を作成してください。作成先はプロジェクトの設定に従ってください。\n\nタスク内容:\n{壁打ちで整理した要約}\n\n作成したIssue/チケットの識別子（例: #123 や PROJ-123）とURLを教えてください。\nまた、適切なブランチ名をfeat/xxx/slug の形式で1つ提案してください。」
7. mainセッションの出力を監視する
   - get_session_outputを数回ポーリングし、Issue/チケットの識別子・URLとブランチ名提案を検出する
   - 見つかったらユーザーに報告: 「{識別子} を作成しました」

#### Phase 3: worktree作成＆タスク着手（Phase 1b / Phase 2 共通）
8. mainセッションが提案したブランチ名をユーザーに確認する
   - 「このブランチ名でよいですか？ {ブランチ名}」
9. 確認が取れたら:
   - create_worktreeでworktreeを作成（返り値にworktreeのIDとパスが含まれる）
   - start_sessionでセッションを起動（create_worktreeの返り値のidとpathを使う）
   - send_to_sessionでタスク内容 + チケットURLをClaude Codeに入力
10. 「セッションを起動してタスクを指示しました。進捗確認で状況を確認できます。」と報告
```

- [ ] **Step 2: 型チェックを実行して構文エラーがないことを確認する**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm check`
Expected: 正常終了（テンプレートリテラル内の変更のみなので型エラーは発生しない）

- [ ] **Step 3: ビルドして正常に完了することを確認する**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm build`
Expected: 正常終了

- [ ] **Step 4: コミットする**

```bash
cd /home/admin/dev/github.com/ignission/claude-code-manager
git add server/lib/beacon-manager.ts
git commit -m "feat: Beacon「タスク着手」にURL経由のチケット内容取得フローを追加"
```

---

### Task 2: Phase 2のブランチ名構築もmainに委譲する

Phase 1b（URL経由）だけでなく、既存のPhase 2（Issue作成）フローでもブランチ名構築をBeacon自身ではなくmainセッションに委譲するよう統一する。Task 1で既にこの変更は含まれている（Phase 2のsend_to_session指示にブランチ名提案の依頼を追加済み、Phase 3のブランチ名構築ルールを削除済み）。

このタスクはTask 1に統合済みのため、独立した変更は不要。Task 1の変更内容に以下が含まれていることを確認する:

- [ ] **Step 1: Phase 2のsend_to_session指示にブランチ名提案の依頼が含まれていることを確認する**

Task 1で置換したPhase 2のステップ6のsend_to_session指示に以下が含まれること:
```
また、適切なブランチ名をfeat/xxx/slug の形式で1つ提案してください。
```

- [ ] **Step 2: Phase 3でBeaconが自前でブランチ名を構築するルールが削除されていることを確認する**

Task 1で置換したPhase 3のステップ8が以下であること:
```
8. mainセッションが提案したブランチ名をユーザーに確認する
   - 「このブランチ名でよいですか？ {ブランチ名}」
```

旧Phase 3のブランチ名構築ルール（GitHub Issue: feat/123/slug、Jira: feat/PROJ-123/slug のパターン定義）が含まれていないこと。

- [ ] **Step 3: 確認完了。追加コミットは不要**

---

### Task 3: E2Eテストの確認

既存のBeacon E2Eテストがシステムプロンプト変更後も通ることを確認する。

**Files:**
- Read: `e2e/beacon-chat.spec.ts`

- [ ] **Step 1: 既存のE2Eテストを実行する**

Run: `cd /home/admin/dev/github.com/ignission/claude-code-manager && pnpm exec playwright test e2e/beacon-chat.spec.ts --reporter=list 2>&1 | head -50`
Expected: 全テストPASS（テストはUI要素の存在確認が中心であり、システムプロンプトの内容変更には影響しない）

- [ ] **Step 2: テスト結果を確認する**

テストが全てPASSしていれば完了。FAILした場合はエラー内容を確認し、システムプロンプト変更に起因するものか判断する（UIテストのためプロンプト変更では通常FAILしない）。
