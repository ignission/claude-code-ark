---
name: check-coderabbit
description: push後にCodeRabbitの新規レビュー指摘を正確に検出・報告する
allowed-tools: Bash, Read
---

## 概要

push後のCodeRabbitレビュー完了を待ち、**未解決スレッド**を報告する。
未解決スレッド（`reviewThreads` の `isResolved == false`）をGraphQL APIで取得する。

## 手順

1. PR番号とHEAD SHAを取得する
2. CodeRabbitのレビュー完了を待つ（最大10分、30秒間隔でポーリング）
3. 完了したら、**未解決のレビュースレッド**を取得して報告する
4. 結果を報告する

## ポーリングコマンド

```bash
# PR番号・HEAD SHA取得
PR_NUM=$(gh pr view --json number -q '.number')
HEAD_SHA=$(gh pr view --json headRefOid -q '.headRefOid')

# CodeRabbit完了チェック
gh pr checks $PR_NUM 2>&1 | grep CodeRabbit

# 未解決スレッドの取得（GraphQL API）
gh api graphql -f query='
{
  repository(owner: "ignission", name: "claude-code-ark") {
    pullRequest(number: '$PR_NUM') {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              databaseId
              author { login }
              body
              path
              line
            }
          }
        }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | .comments.nodes[0] | {id: .databaseId, author: .author.login, path: .path, line: .line, body: .body[:150]}'
```

## 重要: 指摘判定方法

**判定基準は未解決スレッド（`isResolved == false`）。PUSH_TIMEベースのフィルタは使用しない。**

理由:

- PUSH_TIMEベースだとpush前のコメント返信で不整合が生じる
- 修正済みのコメントはCodeRabbitが `review_comment_addressed` タグを付けて自動resolveする
- 未解決スレッドだけを見れば、対応が必要な指摘を正確に把握できる

## 出力形式

```
CodeRabbit Review Complete (PR #NNN)
- 未解決スレッド: N件
  - [ファイル:行] 指摘内容の先頭100文字
  - ...
- 解決済み: M件
```

## 注意事項

- このスキルはレビュー結果の報告のみ。コードを修正しないこと
- 指摘があった場合は対応方針をまとめ、ユーザーに判断を仰ぐこと
