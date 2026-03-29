---
name: review-pr
description: 現在のブランチに対応するPRのレビューコメントを確認し、修正対応方針をまとめる
allowed-tools: Bash, Read, Grep
---

## 手順

1. `gh pr view --json number,url` で現在のブランチのPR番号を取得する
2. 以下のコマンドでPRのレビューコメントとコメントを全て取得する:
   - `gh api repos/ignission/claude-code-ark/pulls/{PR番号}/reviews` — レビュー本文
   - `gh api repos/ignission/claude-code-ark/pulls/{PR番号}/comments` — インラインレビューコメント
   - `gh api repos/ignission/claude-code-ark/issues/{PR番号}/comments` — 一般コメント（CodeRabbit等）
3. bot（CodeRabbit等）と人間のレビューを分類する
4. 各指摘を以下の形式でリスト化する:
   - 指摘元（CodeRabbit / レビュアー名）
   - 対象ファイル・行番号（あれば）
   - 指摘内容の要約
   - 対応方針案（修正する / 対応不要の理由 / 要確認）
   - 優先度（高 / 中 / 低）

## 出力形式

指摘がある場合は、以下のようにテーブル形式でまとめること:

| #   | 指摘元 | 対象 | 指摘内容 | 対応方針案 | 優先度 |
| --- | ------ | ---- | -------- | ---------- | ------ |

指摘がない場合、またはレビューがまだ届いていない場合はその旨を報告すること。

## 注意事項

- 対応方針はあくまで「案」であり、最終判断はユーザーに委ねること
- 「対応不要」と判断する場合は必ず理由を添えること
- 勝手に修正コードを書かないこと。方針の確認が先
- $ARGUMENTS が指定された場合、そのPR番号を使用する
