# 設定同期（Settings Sync）設計

## 概要

localStorageに保存されているペイン情報・UI設定をサーバー側のSQLiteに移し、PC間でページリロード時に同期可能にする。汎用的なKVストアとして設計し、今後の設定追加にも対応する。

## 要件

- **同期対象**: UI設定全般（ペイン情報、サイドバー幅、選択リポジトリ等）
- **同期タイミング**: ページリロード時にサーバーからfetch（リアルタイム同期は不要）
- **拡張性**: 任意のキー/値を保存できる汎用KVストア
- **移行**: 既存localStorage → SQLiteへのマイグレーション

## データ層

### SQLite `settings` テーブル

既存の `data/sessions.db` に追加。

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

- `value`: JSON文字列で保存（`JSON.stringify` / `JSON.parse`）
- `updated_at`: ISO 8601形式

### 初期マイグレーション対象キー

| キー | 型 | 説明 |
|-----|-----|------|
| `activePanesPerRepo` | `[[string, string[]]]` | リポジトリごとのアクティブペイン |
| `maximizedPane` | `string \| null` | 最大化ペインのセッションID |
| `closedPanes` | `string[]` | ユーザーが閉じたペインのセッションID |
| `sidebar-width` | `number` | サイドバー幅（px） |

### DB操作関数（`server/lib/database.ts` に追加）

```typescript
getAllSettings(): Record<string, unknown>
getSetting(key: string): unknown | undefined
setSetting(key: string, value: unknown): void
setSettings(entries: Record<string, unknown>): void
deleteSetting(key: string): void
```

## サーバー API

### REST エンドポイント（`server/index.ts` にルート追加）

| メソッド | パス | 説明 |
|---------|------|------|
| `GET /api/settings` | 全設定を返す | レスポンス: `{ key1: val1, ... }` |
| `GET /api/settings/:key` | 特定キーの値を返す | 404 if not found |
| `PUT /api/settings` | 複数キーを一括更新 | body: `{ key1: val1, ... }` |
| `PUT /api/settings/:key` | 単一キーを更新 | body: `{ value: ... }` |
| `DELETE /api/settings/:key` | キーを削除 | |

## クライアント

### `useSettings` フック（`client/src/hooks/useSettings.ts`）

```typescript
export function useSettings() {
  // 初回マウント時にGET /api/settingsで全設定を取得
  // 設定変更時にPUT /api/settings/:keyでサーバーに保存（debounce 300ms）
  // localStorageは使わない（サーバーが真のソース）
  // ローディング状態を返す
}
```

### Dashboard.tsx の変更

1. localStorage読み書き → `useSettings` フックに置き換え
2. 初期化: `useState(() => localStorage...)` → `useEffect` でサーバーからfetch
3. 保存: `useEffect(() => localStorage.setItem(...))` → debounce付きPUT
4. ローディング中はスケルトンまたはデフォルト値で表示

### データフロー

```
ページロード → GET /api/settings → state初期化 → UI表示
設定変更 → state更新 → debounce(300ms) → PUT /api/settings/:key → DB保存
別PCでリロード → GET /api/settings → 最新設定で表示
```

## マイグレーション戦略

localStorageからの移行は不要。サーバーに設定がなければデフォルト値を使用し、ユーザーが操作した時点でサーバーに保存される。localStorageの既存データは放置（参照しない）。

## 影響範囲

| ファイル | 変更内容 |
|---------|---------|
| `server/lib/database.ts` | settingsテーブル作成 + CRUD関数追加 |
| `server/index.ts` | REST APIルート追加 |
| `client/src/hooks/useSettings.ts` | 新規作成 |
| `client/src/pages/Dashboard.tsx` | localStorage → useSettingsに置き換え |
| `shared/types.ts` | Settings関連の型定義追加（必要に応じて） |
