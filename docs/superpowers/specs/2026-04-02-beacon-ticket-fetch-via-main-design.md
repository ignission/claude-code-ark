# Beacon「タスク着手」URL対応拡張

## 概要

Beaconの「タスク着手」コマンドフローを拡張し、ユーザーがチケット/IssueのURLを貼って実装着手を依頼した場合に、mainセッションのClaude Codeにチケット内容の取得とブランチ名提案を委譲する。

## 背景・動機

- BeaconのAgent SDKセッションは`gh_exec`（読み取り専用）しか外部アクセス手段がない
- mainセッションのClaude CodeはJira MCP、gh CLI等のフルツールアクセスを持つ
- チケット内容の取得をmainに委譲することで、GitHub Issue・Jira・その他任意のチケットシステムに汎用的に対応できる
- ブランチ名もmainに任せることで、リポジトリ固有のCLAUDE.mdや命名規則に従った名前を生成できる

## アプローチ

**ハイブリッド方式**: 専用MCPツールは作らず、既存の`send_to_session` + `get_session_output`の組み合わせ手順をシステムプロンプトで明文化する。コード変更なし。

## 変更対象

`server/lib/beacon-manager.ts` の `BEACON_SYSTEM_PROMPT` のみ。

## フロー設計

### 現在の「タスク着手」フロー

```
Phase 1: 壁打ち（ヒアリング → 要約確認）
Phase 2: Issue/チケット作成（mainセッション経由）
Phase 3: worktree作成＆タスク着手
```

### 拡張後のフロー

Phase 1でユーザーの入力にURLが含まれるかどうかで分岐する。

```
Phase 1: 壁打ち or URL指定
├── URLが含まれる場合 → Phase 1b（URL経由）
│   ※ Phase 2（Issue作成）はスキップ（既にチケットが存在するため）
│
└── URLが含まれない場合 → 既存フロー（変更なし）
    → Phase 2 → Phase 3
```

### Phase 1b: URL経由のフロー

1. リポジトリ選択（既存と同じ: `list_repositories` → 番号付きリストで提示）
2. mainワークツリーを特定する
   - `list_worktrees`で`isMain=true`のworktreeを探す
3. mainセッションを確認/起動する
   - `list_sessions`で既存セッションを確認
   - mainのworktreeに紐づくセッションがあれば`get_session_output`で状態確認
     - 入力待ち/アイドル → 流用
     - 作業中/判断待ち → ユーザーに中断確認
   - セッションがなければ`start_session`で起動
4. mainセッションにチケット内容取得 + ブランチ名提案を指示する
   - `send_to_session`で以下を送信:
     ```
     以下のURLのチケット/Issue内容を取得し、以下の形式で回答してください。

     ## タスク要約
     - タイトル: ...
     - 説明: ...
     - 受入条件: ...（あれば）

     ## ブランチ名提案
     feat/xxx/slug の形式で提案してください。

     URL: {url}
     ```
5. `get_session_output`でポーリングし、結果を検出する
   - 既存Phase 2のポーリングと同じパターン（数回ポーリング）
6. 取得した内容（タスク要約 + ブランチ名案）をユーザーに表示して確認する
   - 「この内容で着手しますか？ブランチ名: {提案されたブランチ名}」
7. 確認OK → Phase 3へ（worktree作成 → セッション起動 → タスク指示）
   - `create_worktree`でworktreeを作成
   - `start_session`でセッション起動
   - `send_to_session`でタスク内容 + チケットURLをClaude Codeに入力

### Phase 3への接続

- ブランチ名: mainセッションが提案した名前を使用
- タスク内容: mainセッションが取得した要約をそのまま使用
- チケットURL: ユーザーが貼ったURLを付与

## 対応チケットシステム

URL全般に汎用対応。Beaconはシステムの種類を判定せず、mainのClaude Codeに取得方法の判断を任せる。

- GitHub Issue (`github.com/...`)
- Jira (`*.atlassian.net/...`)
- その他（mainのClaude Codeがアクセス可能な任意のシステム）

## ポーリング方針

既存Phase 2（Issue作成）のポーリングパターンを再利用:

- `get_session_output`を数回ポーリング
- タスク要約 + ブランチ名提案が検出されたらユーザーに表示
- タイムアウト時は「内容を取得できませんでした。mainセッションの状態を確認してください」と報告
