---
name: merge-and-cleanup
description: PRマージ→main最新化→Jiraチケット完了を一括実行
allowed-tools: Bash, Read, Agent
argument-hint: [PR番号] [Jiraチケット番号]
---

## PRマージ後のクリーンアップ

PR $0 をマージし、Jiraチケット $1 を完了にする。

## 手順

以下の順序で実行すること:

### 1. PRマージ

```bash
gh pr merge $0 --squash --delete-branch
```

### 2. ローカルブランチ最新化

```bash
git checkout main && git pull
```

マージ元のローカルブランチが残っている場合は削除:

```bash
git branch -vv | grep '\[origin/.*: gone\]' | awk '{print $$1}' | xargs -r git branch -d
```

### 3. Jiraチケット完了

チケット $1 のステータスを「完了」に遷移する。

1. `getTransitionsForJiraIssue` で利用可能な遷移を取得
2. 「完了」遷移のIDを特定
3. `transitionJiraIssue` で遷移を実行

cloudIdは `ignission.atlassian.net` を使用する。

## 完了報告

全ステップ完了後、以下を報告:

- PR #$0 マージ完了
- $1 → 完了
- ブランチ: main (最新)
