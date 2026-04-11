---
name: pre-push-review
description: push前にコード品質とセキュリティのレビューを実施し、結果をまとめる
allowed-tools: Bash, Read, Grep, Glob, Skill
---

## 手順

1. `git diff --name-only origin/main...HEAD` で変更ファイル一覧を取得する（未コミットの場合は `git diff --name-only HEAD`）
2. `/codex review` スキルを実行する（Codex CLIによる独立したコードレビュー）
   - $ARGUMENTS が指定された場合、`/codex review $ARGUMENTS` として追加の観点を渡す
3. Codexのレビュー結果をテーブル形式に整形して報告する

## 出力形式

Codexのレビュー結果を **必ずテーブル形式** で統合する。リスト形式や箇条書きでの出力は禁止。

| # | 深刻度 | 対象ファイル | 指摘内容 | 対応方針案 |
|---|--------|-------------|----------|-----------|
| 1 | HIGH | src/foo.rs:42 | 具体的な指摘 | 具体的な対応案 |

- 深刻度は HIGH / MEDIUM / LOW の3段階（Codexの[P0]/[P1]はHIGH、[P2]はMEDIUM、[P3]およびマーカーなしの指摘��LOWにマッピング）
- 指摘が0件の場合も「指摘なし」の1行テーブルを出力する

## 判断基準

結果に基づき、以下のいずれかを推奨すること:

- **push可能**: HIGHの指摘がなく、MEDIUMも既知の課題（既存チケットで管理済み）のみ
- **修正後push**: このPRのスコープで対応すべきHIGH/MEDIUMの指摘がある
- **要相談**: ビジネス判断が必要な指摘がある

## 注意事項

- レビュー結果の報告のみ。勝手にコードを修正しないこと
- 「対応不要」と判断する場合は必ず理由を添えること
- 既存チケットで管理済みの指摘はチケット番号を付記すること

## 完了時

レビュー結果の報告後、フラグファイルを作成すること:
```
touch "$(git rev-parse --git-dir)/claude-pre-push-review-done"
```
このフラグファイルにより、後続のPR作成hookが実行を許可する。
