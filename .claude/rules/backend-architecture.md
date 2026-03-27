---
paths:
  - "server/**"
---

# バックエンドアーキテクチャ実装パターン

## ディレクトリ構成

```
server/
├── index.ts                    # Express + Socket.IO サーバー（ハンドラー定義含む）
└── lib/
    ├── session-orchestrator.ts # tmux + ttyd 統合管理（Orchestratorパターン）
    ├── tmux-manager.ts         # tmuxセッション管理（EventEmitter）
    ├── ttyd-manager.ts         # ttyd Webターミナル管理（EventEmitter）
    ├── database.ts             # SQLite永続化（better-sqlite3、同期API）
    ├── git.ts                  # Git worktree操作（コマンドインジェクション対策あり）
    ├── tunnel.ts               # Cloudflare Tunnel管理
    ├── auth.ts                 # トークン認証（timingSafeEqual）
    ├── port-scanner.ts         # ポートスキャン（macOS: lsof / Linux: ss）
    ├── image-manager.ts        # 画像アップロード・保存
    └── constants.ts            # 定数（TTYDポート範囲等）
```

## 設計パターン

### EventEmitterベースのマネージャーパターン

`TmuxManager` と `TtydManager` はそれぞれ `EventEmitter` を継承する。外部との結合はイベント経由で行い、直接の依存を避ける。

- イベント名は `noun:verb` 形式（例: `session:created`, `instance:stopped`）
- マネージャーはシングルトンとしてエクスポートする（`export const tmuxManager = new TmuxManager()`）

### Orchestratorパターン（SessionOrchestrator）

`SessionOrchestrator` は `TmuxManager` + `TtydManager` + `SessionDatabase` を統合し、セッションのライフサイクルを一元管理する。

- 下位マネージャーのイベントを `setupEventForwarding()` でリッスンし、上位イベントに変換して再emitする
- サーバー起動時に `restoreExistingSessions()` で前回のtmuxセッションを復元し、対応するttydインスタンスも自動起動する
- `ManagedSession` 型（`shared/types.ts`）を返すことで、クライアントに統一的な情報を提供する

### ttydのポート管理と重複起動防止

- ポート範囲は `constants.ts` で定義（`TTYD_PORT_START` 〜 `TTYD_PORT_END`）
- `findAvailablePort()` で使用中ポートを避けて割り当て
- `pendingStarts: Map<string, Promise<TtydInstance>>` で同一セッションへの並行起動を防ぐ。起動中のPromiseがあればそれを返す

## セキュリティ

### パスの検証（コマンドインジェクション対策）

`git.ts` の `validatePath()` を参照。外部入力のパスは必ず検証する。

- `path.resolve()` で正規化
- 危険な文字（`; & | ` $ ( ) { } [ ] < > ! " '`）を拒否
- ブランチ名も `validateBranchName()` で許可文字パターン（`/^[a-zA-Z0-9._\-/]+$/`）を検証し、`-` 始まりや `..` を拒否

### 認証（auth.ts）

- `timingSafeEqual` でトークン比較（タイミング攻撃対策）
- `Buffer.from()` でバイト長を揃えてから比較
- Quick Tunnel（`*.trycloudflare.com`）経由のみ認証を要求し、ローカルアクセスはスキップ
- Express HTTPミドルウェアとSocket.IOミドルウェアの両方を提供

## Socket.IOイベント設計

`shared/types.ts` の `ServerToClientEvents` / `ClientToServerEvents` インターフェースで型安全に定義する。

- サーバー → クライアント: `namespace:verb` 形式（例: `session:created`, `worktree:list`）
- クライアント → サーバー: `namespace:verb` 形式（例: `session:start`, `repo:select`）
- コールバック付きイベント: `session:copy` のように第2引数で `callback` を受け取るパターン

イベントを追加・変更する場合は `shared/types.ts` の型定義を必ず更新すること。型定義とハンドラーの不一致はコンパイルエラーで検出される。

## エラーハンドリング

- `child_process` 系のエラーは `getErrorMessage()` ヘルパーで安全に文字列化する（`unknown` 型対応）
- Socket.IOハンドラー内では `try/catch` で囲み、`session:error` や `worktree:error` イベントでクライアントに通知する
- プロセス終了時は `process.on('SIGTERM', ...)` でttydプロセスをクリーンアップする

## データベース（database.ts）

- `better-sqlite3` の同期APIを使用（Node.jsイベントループをブロックするが、ローカルSQLiteでは実用上問題ない）
- スキーマは `initialize()` メソッド内で `CREATE TABLE IF NOT EXISTS` で定義
- 外部キー制約を有効化（`PRAGMA foreign_keys = ON`）
- `data/sessions.db` に保存（`data/` ディレクトリは自動作成）

## コード修正時の注意事項

- プラットフォーム差異（macOS / Linux）がある処理は `process.platform` で分岐する（例: `port-scanner.ts`, `ttyd-manager.ts` のループバックインターフェース名）
- `pkill -f ttyd` を忘れるとポート競合（`EADDRINUSE`）が発生する。デプロイ手順を遵守すること
- `execSync` / `exec` に外部入力を渡す場合は必ず `validatePath()` / `validateBranchName()` を通す
