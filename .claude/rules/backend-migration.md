---
paths:
  - "server/lib/database.ts"
  - "data/**"
---

# データベース管理ルール

## SQLite (better-sqlite3)

- データベースファイル: `data/sessions.db`（自動生成、gitignore対象）
- スキーマ定義: `server/lib/database.ts` 内で CREATE TABLE IF NOT EXISTS で管理
- マイグレーションツールは使用しない（スキーマ変更はコード内で直接実行）

## スキーマ変更時の注意

- `database.ts` の CREATE TABLE 文を更新
- 既存データとの互換性を考慮すること（ALTER TABLE等）
- 外部キー制約を有効にすること（`PRAGMA foreign_keys = ON`）
- インデックスは必要に応じて作成

## テスト

- テスト用にはインメモリSQLite（`:memory:`）を使用可能
- テスト後のクリーンアップを忘れないこと
