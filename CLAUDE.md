# Ark - 開発引き継ぎ資料

このドキュメントはClaude Codeが開発を引き継ぐための資料です。

## プロジェクト概要

**Ark** は、ローカルで稼働する複数のClaude Codeインスタンスを管理するWebUIアプリケーションです。ユーザーがgitリポジトリとworktreeを選択し、各worktreeに対してClaude Codeセッション（tmux + ttyd）を起動・管理できます。

## アーキテクチャ

### tmux + ttyd によるターミナル転送方式

Claude Codeとの対話は **Agent SDK経由ではなく、tmux + ttyd によるターミナル転送** で実現している。

```
ブラウザ(iframe) ←→ ttyd(WebSocket) ←→ tmux(セッション) ←→ claude CLI
```

1. **tmux**: Claude CLIプロセスをdetachedセッションで管理。サーバー再起動後もセッションが永続化される
2. **ttyd**: tmuxセッションにWebターミナルアクセスを提供。各セッションに独立したttydプロセスが起動する
3. **SessionOrchestrator**: tmuxとttydを統合管理し、セッションのライフサイクルを制御する
4. **クライアント**: ttydが提供するWebターミナルをiframeで表示。メッセージ送信はSocket.IO経由でtmux send-keysを使用

### メッセージ送信の流れ

1. クライアントが `session:send` イベントでメッセージを送信
2. サーバーの `SessionOrchestrator.sendMessage()` が `tmuxManager.sendKeys()` を呼び出す
3. tmuxの `send-keys -l` でリテラル入力 + `Enter` キーを送信
4. Claude CLIが入力を受け取り、ttyd経由でブラウザのiframeにリアルタイム表示

### セッション永続化

- **tmuxセッション**: サーバー再起動後も維持される（`cleanup()`でttydのみ停止、tmuxは残す）
- **SQLite (data/sessions.db)**: セッションのメタデータ（worktreeId、status等）を永続化
- **サーバー起動時の自動復元**: 既存のtmuxセッション（`ark-` プレフィックス）を検出し、ttydを再起動

## 実装済み機能

| 機能                   | 説明                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| リポジトリスキャン     | 指定パス配下のGitリポジトリを探索（fd/findコマンド使用）                    |
| Git Worktree管理       | 一覧表示、作成、削除                                                        |
| セッション管理         | tmux + ttydベースの起動、停止、復元、状態管理                               |
| Webターミナル          | ttyd iframeによるフルターミナル体験                                         |
| マルチペインビュー     | 複数セッションの同時表示（1列 / 2x2グリッド切り替え）                       |
| モバイル対応           | セッション一覧/詳細の画面遷移、Quick Keys、スクロールモード、キーボード対応 |
| 特殊キー送信           | Enter, Ctrl+C, Ctrl+D, y, n, S-Tab, Escape, スクロール等                    |
| ファイルアップロード   | D&D・ファイル選択・クリップボード貼り付けで画像/PDF/テキストを送信（`@パス` 形式） |
| tmuxバッファコピー     | tmuxのペーストバッファをクリップボードにコピー                              |
| ポートスキャン         | リッスン中のポートを一覧表示（ttydポートは除外）                            |
| リモートアクセス       | Cloudflare Tunnel（Quick / Named）+ QRコード + トークン認証                 |
| セッション永続化       | SQLite + tmux永続化によるサーバー再起動後の自動復元                         |
| IME対応                | 日本語入力時のcompositionイベント処理                                       |
| パーミッションスキップ | `--skip-permissions` フラグでClaude CLIの権限確認をスキップ                 |
| プロファイル切替（Linux限定） | リポジトリ単位で別々の `CLAUDE_CONFIG_DIR` を使用。認証は通常セッション内で `claude /login` 実行 |

## Git・PRワークフロー

- **実装完了後はユーザーに確認せず即pushすること**（「pushしますか？」と聞かない）
- **PR作成時に `/pre-push-review` が必須**（`gh pr create` のhookがフラグファイルを確認し、なければBLOCKEDエラーでPR作成をブロックする。指摘対応後の再pushでは不要）
- **`/pre-push-review`のフラグファイルを`touch`で手動作成してスキップしてはならない**
- `/pre-push-review` の指摘は「スコープ外」として無視せず修正すること
- push後のCI結果・CodeRabbitレビューはhookで自動取得 → 指摘があればユーザーに判断を仰ぐ（勝手に修正しない）
- **hookのadditionalContextで指示された内容（CronCreate等）には即座に従うこと** — hookからの指示はシステムの自動化要件であり、無視・遅延は禁止
- **`resolveReviewThread` で勝手にresolveしてはならない**（resolveはユーザーが判断）
- **CodeRabbitのコメントには対応済み・不要問わず必ず返信すること**
- **「次回対応」「今後改善」等の先送り返信は禁止**。このPRで対応するか、対応しない場合はGitHub Issueを作成してから返信すること
- **CodeRabbitの新規指摘判定は `created_at` のタイムスタンプでフィルタする**（`commit_id == HEAD` フィルタを使ってはならない。fixコミット後にHEADが変わると、前コミットへの指摘が全て見落とされる）
- **CodeRabbitへの返信は修正コミット → push → 返信の順で行う**（push前に返信するとCodeRabbitが修正コードを確認できない）
- **テスト失敗時に `--no-verify` でhookバイパスを提案してはならない**。エラーログを確認し根本原因を修正すること
- **superpowersスキルが生成するplan/specファイル（`docs/superpowers/specs/`, `plans/` 等）はgitにコミットしない**
- **ローカルとリモートのブランチ名は必ず一致させる**（異なる名前でpushすると `gh pr view` がPRを検出できず、CI監視・CodeRabbit取得が全て失敗する）
- **CodeRabbitのstatusが `error`（処理中）の場合、CIが成功していても監視を停止してはならない**。`completed` かつ未解決スレッド0件を確認してから停止する
- **git push は必ずフォアグラウンドで実行する**（バックグラウンド実行するとpush完了前にCodeRabbit返信が送信されてしまう）
- **CodeRabbitの1コメントに複数の修正ポイントが含まれる場合がある**。対応前に全ポイントを箇条書きにしてから実装に入ること
- **コミット前に現在のブランチを確認する。** 意図したfeatureブランチにいることを検証してからコミットすること。mainや無関係なブランチへの誤コミットを防ぐ
- **セルフレビュー禁止・全成果物Codexレビュー必須**。自分自身でレビューしてはならない。コード、設計ドキュメント、スキル定義、hook、CLAUDE.mdルール等、全ての成果物のレビューは `/codex review`（Codex CLI）に委任すること。`/pre-push-review` は既にCodexに委任済み

## デプロイ手順

mainブランチをpullした後は、以下の手順で **順番通りに** ビルド・再起動する：

```bash
# 1. 古いttydプロセスをkill
#    ttydは各セッションごとに独立プロセスで起動しており、
#    サーバー再起動時に同じポートを確保できずEADDRINUSEになるため、
#    必ず先にkillする
pkill -f ttyd

# 2. ビルド
pnpm build

# 3. pm2で再起動（サーバー起動時にttydも自動で再起動される）
pm2 restart claude-code-ark
```

**注意**: `pkill -f ttyd` を省略するとttydのポート(7680〜)が競合し、ターミナルが表示されなくなる。

## 一般規約

- **コマンド実行を依頼されたら即実行する。** コマンドの説明や注意点だけ述べて実行しない、という振る舞いは禁止。「実行しますか？」の確認も不要（CLAUDE.mdで明示的に確認を求めている場合を除く）
- **曖昧な指示（「リファクタリングして」「修正して」「改善して」等）を受けた場合、実装前にやることを2文で要約しユーザーの確認を得ること。** 明確な指示（具体的な修正内容記載）の場合は確認不要

## 既知の制約

### プロファイル切替（Linux限定）

- **C-1: プロファイル変更は新規セッションにのみ適用される**。tmuxセッションは起動時に確定したenvを保持する。リポジトリのプロファイル紐付けを変えても、稼働中のセッションは元のプロファイルで動作し続ける。UIは`staleProfile`バッジ + 「再起動」ボタンを表示する（再起動はClaude会話履歴を破壊するので確認ダイアログ必須）
- **C-2: 同一プロファイルの並行セッションは非推奨**。1プロファイル=1`.credentials.json`を共有するため、複数セッション同時稼働でリフレッシュトークン競合が発生する可能性あり（[claude-code#24317](https://github.com/anthropics/claude-code/issues/24317) 等）
- **C-3: macOS / Windows非対応**。macOSはOAuth credentialsをKeychainに保存するため、`CLAUDE_CONFIG_DIR`分離だけではプロファイル切替できない。`multiProfileSupported=false`でUIを完全非表示

## 開発原則

### クロスレイヤー変更の検証

- ある機能がレイヤー境界（クライアント/サーバー、永続化/メモリ等）をまたいで依存する場合、依存先の供給フローまで検証すること
- 特にリロード・再接続・再起動など状態がリセットされるタイミングで依存関係が満たされるか確認する
- レビュー時はPR差分のスコープ外に暗黙の前提がないか確認する
  - 例: クライアント側の永続化実装だけでなく、サーバー側のデータ供給経路も検証対象に含める

---

## リモートアクセス機能

### 概要

Cloudflare Tunnelを使用したリモートアクセス機能。スマートフォンや外部デバイスからArkにアクセスできる。

### 使用方法

```bash
# ローカルのみ（デフォルト）
pnpm dev:server

# Quick Tunnel（一時URL + トークン認証）
pnpm dev:quick

# Named Tunnel（Cloudflare Access認証、固定URL）
pnpm dev:remote

# 本番環境
pnpm start:quick
pnpm start:remote
```

### 前提条件

`cloudflared` がインストールされている必要がある:

```bash
# macOS
brew install cloudflared

# Linux
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

### 仕組み

1. `--quick` フラグで起動するとトークン認証が有効化され、Quick Tunnelが自動起動
2. `--remote` + `ARK_PUBLIC_DOMAIN` 環境変数で Named Tunnel を起動（Cloudflare Access認証）
3. ターミナルにQRコードとURLが表示される
4. スマホでQRコードをスキャン、または URLをブラウザで開く

### セキュリティ

- **Quick Tunnel**: ランダム生成されたトークンがURLに含まれる。`*.trycloudflare.com` ドメイン（一時的）
- **Named Tunnel**: Cloudflare Accessによる認証。固定ドメイン使用
- **HTTPS**: Cloudflare Tunnelが自動的にHTTPSを提供
- **ローカルアクセス**: localhost/プライベートIPからのアクセスは認証スキップ

### トンネル自動復旧

サーバー再起動時、前回トンネルが有効だった場合は自動的に再起動する（`/tmp/ark-tunnel-state.json` で状態管理）

### 関連ファイル

```
server/lib/
├── tunnel.ts   # Cloudflare Tunnel管理（Quick / Named）
├── auth.ts     # トークン認証（Quick Tunnel用）
└── qrcode.ts   # QRコード生成
```

### 参考

- [claude-code-remote](https://github.com/yazinsai/claude-code-remote) - 同様のリモートアクセス実装

---

## 技術スタック

| レイヤー         | 技術                                                       |
| ---------------- | ---------------------------------------------------------- |
| フロントエンド   | React 19, TailwindCSS 4, shadcn/ui, wouter（ルーティング） |
| バックエンド     | Express, Socket.IO, http-proxy（ttydプロキシ）             |
| ターミナル管理   | tmux（セッション永続化）, ttyd（Webターミナル）            |
| 永続化           | better-sqlite3 (`data/sessions.db`)                        |
| リモートアクセス | cloudflared（Cloudflare Tunnel）, qrcode                   |
| ビルド           | Vite（フロントエンド）, esbuild（サーバー）                |
| パッケージ管理   | pnpm                                                       |

## ディレクトリ構造

```
claude-code-ark/
├── client/
│   └── src/
│       ├── components/
│       │   ├── TerminalPane.tsx        # ttyd iframe + 入力バー（PC用）
│       │   ├── MultiPaneLayout.tsx     # PC向けグリッドレイアウト
│       │   ├── MobileLayout.tsx        # モバイル用ルートコンポーネント
│       │   ├── MobileSessionList.tsx   # モバイル用セッション一覧
│       │   ├── MobileSessionView.tsx   # モバイル用セッション詳細
│       │   ├── SessionDashboard.tsx    # セッション管理ダッシュボード
│       │   ├── RepoSelectDialog.tsx    # リポジトリ選択ダイアログ
│       │   ├── CreateWorktreeDialog.tsx # Worktree作成ダイアログ
│       │   ├── WorktreeContextMenu.tsx # Worktreeコンテキストメニュー
│       │   ├── ProfileManagerDialog.tsx # プロファイル管理ダイアログ（Linux限定）
│       │   ├── RepoProfileMenu.tsx     # リポジトリのプロファイル切替サブメニュー
│       │   ├── ErrorBoundary.tsx       # エラーバウンダリ
│       │   └── ui/                     # shadcn/ui コンポーネント群
│       ├── hooks/
│       │   ├── useSocket.ts            # Socket.IO通信（全イベント管理）
│       │   ├── useVisualViewport.ts    # モバイルキーボード対応
│       │   ├── useComposition.ts       # IME入力対応
│       │   ├── useMobile.tsx           # モバイル判定
│       │   └── usePersistFn.ts         # コールバック安定化
│       └── pages/
│           ├── Dashboard.tsx           # メインページ
│           └── NotFound.tsx            # 404ページ
├── server/
│   ├── index.ts                        # Expressサーバー + Socket.IOハンドラー
│   └── lib/
│       ├── session-orchestrator.ts     # tmux + ttyd 統合管理
│       ├── tmux-manager.ts             # tmuxセッション管理
│       ├── ttyd-manager.ts             # ttyd Webターミナル管理
│       ├── system.ts                   # 実行環境の機能判定（multiProfileSupported等）
│       ├── database.ts                 # SQLite永続化
│       ├── git.ts                      # Git worktree操作
│       ├── tunnel.ts                   # Cloudflare Tunnel管理
│       ├── auth.ts                     # トークン認証
│       ├── qrcode.ts                   # QRコード生成
│       ├── port-scanner.ts             # ポートスキャン
│       ├── file-manager.ts             # ファイル管理
│       ├── file-upload-manager.ts      # ファイルアップロード管理
│       ├── constants.ts                # 定数定義
│       └── errors.ts                   # エラーユーティリティ
├── shared/
│   └── types.ts                        # クライアント/サーバー共通型定義
├── data/
│   └── sessions.db                     # SQLiteデータベース（自動生成）
└── package.json
```

---

## Socket.IOイベント一覧

### クライアント → サーバー

| イベント          | データ                                  | 説明                             |
| ----------------- | --------------------------------------- | -------------------------------- |
| `repo:scan`       | `basePath: string`                      | リポジトリスキャン               |
| `repo:select`     | `path: string`                          | リポジトリ選択                   |
| `worktree:list`   | `repoPath: string`                      | Worktree一覧取得                 |
| `worktree:create` | `{ repoPath, branchName, baseBranch? }` | Worktree作成                     |
| `worktree:delete` | `{ repoPath, worktreePath }`            | Worktree削除                     |
| `session:start`   | `{ worktreeId, worktreePath }`          | セッション開始                   |
| `session:stop`    | `sessionId: string`                     | セッション停止                   |
| `session:send`    | `{ sessionId, message }`                | メッセージ送信（tmux send-keys） |
| `session:key`     | `{ sessionId, key: SpecialKey }`        | 特殊キー送信                     |
| `session:copy`    | `sessionId, callback`                   | tmuxバッファ取得（コールバック） |
| `session:restore` | `worktreePath: string`                  | セッション復元                   |
| `tunnel:start`    | `{ port? }`                             | Quick Tunnel起動                 |
| `tunnel:stop`     | -                                       | トンネル停止                     |
| `ports:scan`      | -                                       | ポートスキャン                   |
| `file-upload:upload` | `{ sessionId, base64Data, mimeType, originalFilename?, requestId }` | ファイルアップロード |
| `profile:list`    | -                                       | プロファイル一覧取得（Linux限定） |
| `profile:create`  | `{ name, configDir }`                   | プロファイル作成 |
| `profile:update`  | `{ id, name?, configDir? }`             | プロファイル更新 |
| `profile:delete`  | `{ id }`                                | プロファイル削除（CASCADEで紐付けも削除） |
| `repo:set-profile` | `{ repoPath, profileId \| null }` | リポジトリにプロファイルを紐付け（nullで解除） |
| `session:restart-with-profile` | `{ sessionId }`            | セッションをkill→新envで再起動 |

### サーバー → クライアント

| イベント                 | データ                         | 説明                             |
| ------------------------ | ------------------------------ | -------------------------------- |
| `repos:list`             | `string[]`                     | 許可リポジトリ一覧               |
| `repos:scanned`          | `RepoInfo[]`                   | スキャン結果                     |
| `repos:scanning`         | `{ basePath, status, error? }` | スキャン状態                     |
| `repo:set`               | `path: string`                 | リポジトリ選択完了               |
| `repo:error`             | `string`                       | リポジトリエラー                 |
| `worktree:list`          | `Worktree[]`                   | Worktree一覧                     |
| `worktree:created`       | `Worktree`                     | Worktree作成完了                 |
| `worktree:deleted`       | `worktreeId: string`           | Worktree削除完了                 |
| `worktree:error`         | `string`                       | Worktreeエラー                   |
| `session:list`           | `ManagedSession[]`             | 既存セッション一覧               |
| `session:created`        | `ManagedSession`               | セッション作成完了               |
| `session:updated`        | `ManagedSession`               | セッション更新（ttyd起動完了等） |
| `session:stopped`        | `sessionId: string`            | セッション停止                   |
| `session:restored`       | `ManagedSession`               | セッション復元完了               |
| `session:restore_failed` | `{ worktreePath, error }`      | セッション復元失敗               |
| `session:error`          | `{ sessionId, error }`         | セッションエラー                 |
| `tunnel:started`         | `{ url, token }`               | トンネル開始                     |
| `tunnel:stopped`         | -                              | トンネル停止                     |
| `tunnel:status`          | `{ active, url?, token? }`     | トンネル状態                     |
| `tunnel:error`           | `{ message }`                  | トンネルエラー                   |
| `ports:list`             | `{ ports }`                    | ポート一覧                       |
| `file-upload:uploaded`   | `{ requestId, path, filename, originalFilename? }` | ファイルアップロード完了 |
| `file-upload:error`      | `{ requestId, message, code? }`           | ファイルアップロードエラー       |
| `system:capabilities`    | `{ multiProfileSupported }`               | 機能フラグ（接続時に1回emit） |
| `profile:list`           | `Profile[]`                        | プロファイル一覧 |
| `profile:created`        | `Profile`                          | プロファイル作成完了 |
| `profile:updated`        | `Profile`                          | プロファイル更新完了 |
| `profile:deleted`        | `{ id }`                                  | プロファイル削除完了 |
| `profile:error`          | `{ message, code? }`                      | プロファイル操作エラー |
| `repo:profile-changed`   | `{ repoPath, profileId \| null }`  | 紐付け変更通知（バッジ更新用） |

---

## サーバー起動オプション

| オプション              | 環境変数                | 説明                                                     |
| ----------------------- | ----------------------- | -------------------------------------------------------- |
| `--quick` / `-q`        | -                       | Quick Tunnel（一時URL + トークン認証）を起動             |
| `--remote` / `-r`       | `ARK_PUBLIC_DOMAIN`     | Named Tunnel（固定URL + Cloudflare Access）を起動        |
| `--skip-permissions`    | `SKIP_PERMISSIONS=true` | Claude CLIを `--dangerously-skip-permissions` 付きで起動 |
| `--repos /path1,/path2` | -                       | 許可するリポジトリパスを制限                             |
| -                       | `PORT`                  | サーバーポート（デフォルト: 4001）                       |
| -                       | `ARK_TUNNEL_NAME`       | Named Tunnel名（デフォルト: `claude-code-ark`）          |

---

## 前提条件

以下がインストールされている必要がある：

- **Node.js** >= 20.6.0
- **pnpm**
- **tmux**
- **ttyd**
- **cloudflared**（リモートアクセス使用時のみ）
