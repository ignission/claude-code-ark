# Claude Code Manager

ローカルで稼働する複数のClaude Codeインスタンスを管理するWebUIアプリケーション。
git worktreeを選択し、各worktreeに対してClaude Codeセッションを起動・管理できます。

## 機能

- **Git Worktree管理**: WebUI上でgit worktreeの一覧表示・作成・削除
- **セッション管理**: 起動・停止・復元（サーバー再起動後もtmuxセッション継続）
- **Webターミナル**: tmux + ttyd ベースの埋め込みターミナル（iframe）
- **マルチペイン**: 最大4分割グリッド表示（PC）、最大化機能
- **モバイル対応**: レスポンシブUI、IME/日本語入力対応、スワイプスクロール
- **リモートアクセス**: Cloudflare Tunnel（Quick/Named）+ QRコード + トークン認証
- **データ永続化**: SQLiteでセッション・メッセージ情報を保存

## 前提条件

- Node.js >= 20.6.0
- pnpm
- Git
- [tmux](https://github.com/tmux/tmux)（セッション管理基盤）
- [ttyd](https://github.com/tsl0922/ttyd)（Webターミナル提供）
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)（リモートアクセス時のみ。オプション）

## インストール

```bash
# リポジトリをクローン
git clone https://github.com/ignission/claude-code-manager.git
cd claude-code-manager

# 依存関係をインストール
pnpm install
```

## 開発

### フロントエンドのみ（UIプレビュー）

```bash
pnpm dev
```

### バックエンドのみ

```bash
pnpm dev:server
```

### フルスタック開発（フロントエンド + バックエンド）

```bash
pnpm dev:full
```

これにより、以下が同時に起動します：
- Vite開発サーバー（フロントエンド）: http://localhost:5173
- Express + Socket.IOサーバー（バックエンド）: http://localhost:3001

### スクリプト一覧

| コマンド | 説明 |
|---------|------|
| `pnpm dev` | Vite開発サーバー（フロントエンドのみ） |
| `pnpm dev:server` | バックエンド開発サーバー |
| `pnpm dev:full` | フルスタック開発 |
| `pnpm dev:remote` | Named Tunnel付きバックエンド開発 |
| `pnpm dev:full:remote` | フルスタック + Named Tunnel |
| `pnpm dev:quick` | Quick Tunnel付きバックエンド開発 |
| `pnpm build` | 本番ビルド |
| `pnpm start` | 本番起動 |
| `pnpm start:remote` | Named Tunnel付き本番起動 |
| `pnpm start:quick` | Quick Tunnel付き本番起動 |

## 本番環境での実行

```bash
pnpm build
pnpm start
```

ブラウザで http://localhost:3001 にアクセスしてください。

## リモートアクセス

Cloudflare Tunnelを使用して、スマートフォンや外部デバイスからアクセスできます。

### Quick Tunnel（一時URL）

```bash
# 開発環境
pnpm dev:quick

# 本番環境
pnpm start:quick
```

サーバー起動後、ターミナルにQRコードとURLが表示されます。`*.trycloudflare.com` ドメインの一時URLが発行されます（サーバー再起動でURL変更）。

### Named Tunnel（固定ドメイン）

環境変数 `CCM_PUBLIC_DOMAIN` に公開ドメインを設定した上で起動します。

```bash
# 開発環境
pnpm dev:remote

# 本番環境
pnpm start:remote
```

### セキュリティ

- **トークン認証**: ランダム生成されたトークンがURLに含まれる
- **HTTPS**: Cloudflare Tunnelが自動的にHTTPSを提供

### コマンドラインオプション

| オプション | 説明 |
|-----------|------|
| `--remote` / `-r` | Named Tunnelモード |
| `--quick` / `-q` | Quick Tunnelモード |
| `--skip-permissions` | パーミッションスキップ |
| `--repos /path1,/path2` | 許可リポジトリを制限 |

## 使い方

### PC

1. ブラウザで http://localhost:3001 にアクセス
2. サイドバーのフォルダボタンからリポジトリを追加（パススキャンまたは直接入力）
3. 「+」ボタンで新しいWorktreeを作成、または既存のWorktreeを選択
4. Worktreeをクリックしてセッション開始（自動でPanesタブに切り替わる）
5. マルチペイン表示で複数セッションを同時管理（単一/4分割切替可能）

### モバイル

1. ハンバーガーメニューからリポジトリ/Worktreeを選択
2. セッション一覧からWorktreeをタップして開始
3. 全画面ターミナルで操作（Quick Keys: Ctrl+C, Tab, 矢印キー等）
4. 入力フォームから日本語入力も可能（IME対応）

### リモート

1. Quick Tunnelボタンをクリック（またはコマンドラインで `--quick` 指定）
2. QRコードとURLが表示される
3. スマホでQRスキャンしてアクセス（トークン認証付き）

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                       ブラウザ                                    │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                    React Frontend                            ││
│  │  ┌─────────────────┐  ┌────────────────────────────────────┐││
│  │  │    Sidebar       │  │      MultiPane / Mobile Layout    │││
│  │  │  - Repositories  │  │  ┌──────────────────────────────┐ │││
│  │  │  - Worktrees     │  │  │  TerminalPane (ttyd iframe)  │ │││
│  │  │  - Sessions      │  │  │  + 入力フォーム              │ │││
│  │  │                  │  │  │  + Quick Keys                │ │││
│  │  └─────────────────┘  │  └──────────────────────────────┘ │││
│  │                        └────────────────────────────────────┘││
│  └──────────────────────────────────────────────────────────────┘│
│           │ Socket.IO                    │ HTTP Proxy             │
└───────────┼──────────────────────────────┼───────────────────────┘
            │                              │
┌───────────┼──────────────────────────────┼───────────────────────┐
│           │     Express Server (:3001)   │                       │
│  ┌────────┴──────────────────────────────┴─────────────────────┐ │
│  │ Session Orchestrator                                        │ │
│  │  ├── Tmux Manager → tmux sessions (ccm-*)                  │ │
│  │  ├── Ttyd Manager → ttyd processes (:7680-7780)             │ │
│  │  └── Database → SQLite (data/sessions.db)                   │ │
│  ├── Git Module → git worktree 操作                            │ │
│  ├── Auth → トークン認証（リモート時）                          │ │
│  └── Tunnel → Cloudflare Tunnel（オプション）                   │ │
└──────────────────────────────────────────────────────────────────┘
            │
┌───────────┼──────────────────────────────────────────────────────┐
│           │     外部プロセス                                      │
│  ├── tmux: Claude Code セッション管理                            │
│  ├── ttyd: Webターミナル UI 提供                                 │
│  └── cloudflared: リモートアクセス（オプション）                 │
└──────────────────────────────────────────────────────────────────┘
```

### 技術スタック

| レイヤー | 技術 |
|---------|------|
| Frontend | React 19, TailwindCSS 4, shadcn/ui, wouter |
| Backend | Express, Socket.IO |
| ターミナル | tmux + ttyd |
| データベース | SQLite (better-sqlite3) |
| リモートアクセス | Cloudflare Tunnel |
| ビルドツール | Vite, esbuild |

## ディレクトリ構造

```
claude-code-manager/
├── client/src/
│   ├── components/
│   │   ├── MultiPaneLayout.tsx    # マルチペイングリッド
│   │   ├── TerminalPane.tsx       # ターミナルペイン
│   │   ├── SessionDashboard.tsx   # セッション概要
│   │   ├── MobileLayout.tsx       # モバイルレイアウト
│   │   ├── MobileSessionList.tsx  # モバイルセッション一覧
│   │   ├── MobileSessionView.tsx  # モバイルセッション詳細
│   │   ├── RepoSelectDialog.tsx   # リポジトリ選択
│   │   ├── CreateWorktreeDialog.tsx # Worktree作成
│   │   ├── WorktreeContextMenu.tsx # コンテキストメニュー
│   │   └── ui/                    # shadcn/uiコンポーネント
│   ├── hooks/
│   │   ├── useSocket.ts           # Socket.IO通信
│   │   ├── useMobile.tsx          # モバイル判定
│   │   ├── useVisualViewport.ts   # キーボード検知
│   │   └── useComposition.ts      # IME入力対応
│   ├── contexts/
│   │   └── ThemeContext.tsx        # テーマ管理
│   └── pages/
│       └── Dashboard.tsx          # メインページ
├── server/
│   ├── index.ts                   # エントリーポイント
│   └── lib/
│       ├── session-orchestrator.ts # セッション統合管理
│       ├── tmux-manager.ts        # tmuxセッション管理
│       ├── ttyd-manager.ts        # Webターミナル管理
│       ├── database.ts            # SQLite永続化
│       ├── git.ts                 # Git Worktree操作
│       ├── tunnel.ts              # Cloudflare Tunnel
│       ├── auth.ts                # トークン認証
│       ├── qrcode.ts              # QRコード生成
│       ├── port-scanner.ts        # ポート監視
│       └── image-manager.ts       # 画像管理
└── data/
    └── sessions.db                # SQLiteデータベース
```

## 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `PORT` | サーバーポート | `3001` |
| `NODE_ENV` | 実行環境 | - |
| `CCM_PUBLIC_DOMAIN` | Named Tunnel用の公開ドメイン | - |
| `SKIP_PERMISSIONS` | Claude に `--dangerously-skip-permissions` を付与 | - |
| `ANTHROPIC_API_KEY` | Claude API認証キー | - |

## デプロイ（pm2）

```bash
# 1. ttydプロセスをkill（ポート競合防止）
pkill -f ttyd

# 2. ビルド
pnpm build

# 3. pm2で再起動
pm2 restart claude-code-manager
```

> **注意**: `pkill -f ttyd` を省略するとttydのポート(7680〜)が競合し、ターミナルが表示されなくなります。

## 開発者向け情報

開発を引き継ぐ場合は、[CLAUDE.md](./CLAUDE.md)を参照してください。

## ライセンス

MIT
