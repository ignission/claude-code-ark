---
name: pr-lifecycle
description: PRのCI監視・CodeRabbit対応・マージ・クリーンアップを一括実行する
allowed-tools: Bash, Read, Agent, Skill, CronCreate
---

## PRライフサイクル自動化

現在のブランチに対応するPRについて、CI監視 → CodeRabbit指摘対応 → マージ → クリーンアップを一括実行する。

## 手順

以下の順序で実行すること:

### 1. PR特定

現在のブランチに対応するPRを特定し、PR番号を変数に保存する:

```bash
PR_NUMBER=$(gh pr view --json number -q .number)
gh pr view --json number,title,state,statusCheckRollup,url
```

PRが見つからない場合はエラーを報告して終了する。

### 2. CIステータス確認

CIの実行状況を確認する:

```bash
gh run list --branch $(git branch --show-current) --limit 5 --json status,conclusion,name,databaseId
```

- **失敗している場合**: ログを読み(`gh run view <id> --log-failed`)、根本原因を診断して修正をpushする
- **pendingの場合**: CronCreateで1分間隔の監視ジョブを起動する（hookの指示に従う）。CI完了を待ってから次のステップに進む
- **成功している場合**: 次のステップに進む

### 3. CodeRabbitレビュー確認・対応

PRのレビューコメントを確認する:

```bash
# 未解決スレッドをGraphQLで取得（既存ヘルパー使用）
source "$CLAUDE_PROJECT_DIR/.claude/hooks/fetch-unresolved-threads.sh"
fetch_unresolved_threads
```

また、REST APIでCodeRabbitのレビュー本体も確認する:

```bash
REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner')
gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" \
  --jq '.[] | select(.user.login == "coderabbitai[bot]") | {id, state, body}'
```

未解決のCodeRabbitコメントがある場合:

1. 全コメントを読み、各コメントの修正ポイントを箇条書きにする
2. 修正を実装する
3. git push する（**フォアグラウンドで実行すること**）
4. push後に各コメントに返信する（**この順序を厳守: push → 返信**）
5. ユーザーに修正内容を報告し、判断を仰ぐ（**勝手にresolveしない**）

### 4. CI green + CodeRabbit resolved 確認

以下の両方を満たすことを確認する:

- CIが全てグリーンであること
- CodeRabbitの未解決指摘がないこと

**CodeRabbitのstatusがerrorの場合は処理中の可能性があるため、監視を継続すること。**

どちらかが満たされていない場合はステップ2-3に戻る。

### 5. マージ・クリーンアップ

`/merge-and-cleanup` スキルを実行する:

```text
/merge-and-cleanup <PR番号>
```

### 6. 完了レポート

全ステップ完了後、以下を報告する:

- PR番号・タイトル・URL
- CI結果サマリ
- CodeRabbit指摘の対応内容（あれば）
- マージ結果

## 重要な注意事項

以下のルールを厳守すること:

- **CodeRabbitへの返信はpush後に行う**: 修正をpushしてから返信する。先に返信しない
- **`--no-verify` は使わない**: テスト失敗時はhookをスキップせず根本原因を解決する
- **`resolveReviewThread` でresolveしない**: resolveはユーザーが判断する
- **CodeRabbit指摘への「次回対応」返信は禁止**: このPRで対応するか、対応しない場合はGitHub Issueを作成してから返信する
- **git pushはフォアグラウンドで実行する**: バックグラウンドだとコメント返信が先行してしまう
- **CodeRabbit statusがerrorの場合は監視継続**: CI成功でもCodeRabbitが処理中なら停止しない
- **セルフレビュー禁止**: コードレビューは全て `/codex review`（Codex CLI）に委任すること
