---
name: db-connect
description: ローカルSQLiteデータベースへの接続と操作
allowed-tools: Bash, Read
---

## 概要

このプロジェクトはSQLite（better-sqlite3）を使用。データベースファイルは `data/sessions.db` に自動生成される。

## 接続方法

```bash
# SQLite CLIで接続
sqlite3 data/sessions.db

# テーブル一覧
sqlite3 data/sessions.db ".tables"

# スキーマ確認
sqlite3 data/sessions.db ".schema"

# セッション一覧
sqlite3 data/sessions.db "SELECT * FROM sessions;"
```

## 注意事項

- サーバー起動時にテーブルが自動作成される（`server/lib/database.ts` 参照）
- SQLiteファイルはgitignoreに含まれている
- サーバー稼働中にSQLite CLIで書き込むとロック競合の可能性がある
