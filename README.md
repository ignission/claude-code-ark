# Ark

**複数のClaude Codeセッションを、ひとつのWebUIから。**

<!-- スクリーンショットやGIFをここに追加 -->

> [!WARNING]
> このプロジェクトは実験的なものです。Cloudflare Tunnelなどを利用してリモートからアクセスする場合は、セキュリティに十分注意してください。信頼できないネットワーク上での公開は推奨しません。

## なぜ必要か

Claude Codeで本格的に開発を始めると、すぐにターミナルのタブが爆発する。

worktreeごとにClaude Codeを起動して、featureブランチ用、bugfix用、実験用...と増えていく。どのタブでどのセッションが動いているか見失い、外出先からは進捗すら確認できない。サーバーを再起動すればセッションは消え、コンテキストも失われる。

Arkは、そういった問題をまとめて解決する。ブラウザを開けば、すべてのセッションが一覧でき、どこからでも操作できる。

## Features

- **セッション管理** -- worktreeごとにClaude Codeセッションを起動・停止。サーバー再起動後も自動復元
- **ブラウザ操作** -- Webターミナルから直接Claude Codeを操作。ローカルにターミナルを開く必要なし
- **マルチペイン** -- 最大4つのセッションを同時に表示・監視（PC）
- **モバイル対応** -- スマホからフル操作可能。IME / 日本語入力にも対応
- **リモートアクセス** -- Cloudflare Tunnelで外出先からセッションにアクセス。QRコードですぐ接続
- **Git Worktree統合** -- WebUIからworktreeの作成・削除・一覧表示
- **Beacon（AIアシスタント）** -- Agent SDKベースのチャットUIで、「進捗確認」「タスク着手」「判断」などの高レベル操作を自然言語で実行。MCPツール経由でセッション管理やGitHub操作を自動化
- **画像送信** -- クリップボードから画像をペーストしてClaude Codeに送信（`@パス` 形式）

## アーキテクチャ

Arkは、Agent SDKではなく **tmux + ttyd によるターミナル転送方式** を採用している。これにより、Claude CLIのフルターミナル体験をブラウザ上でそのまま再現できる。

```text
ブラウザ(iframe) ←→ ttyd(WebSocket) ←→ tmux(セッション) ←→ claude CLI
```

- **tmux** がClaude CLIプロセスをdetachedセッションで管理し、サーバー再起動後もセッションが永続化される
- **ttyd** がtmuxセッションにWebターミナルアクセスを提供し、各セッションに独立したttydプロセスが起動する
- **Beacon** は別レイヤーとして、Agent SDKベースのチャットUIを提供する。ターミナル操作ではなく、自然言語による高レベルな指示に特化している

## Quick Start

### 前提条件

- Node.js >= 20.6.0
- [pnpm](https://pnpm.io/)
- [tmux](https://github.com/tmux/tmux)
- [ttyd](https://github.com/tsl0922/ttyd)

### インストールと起動

```bash
git clone https://github.com/ignission/claude-code-ark.git
cd claude-code-ark
pnpm install
pnpm build
pnpm start
```

ブラウザで http://localhost:4001 を開く。

### 起動オプション

| オプション              | 説明                                              |
| ----------------------- | ------------------------------------------------- |
| `--skip-permissions`    | Claude CLIの権限確認をスキップ                    |
| `--repos /path1,/path2` | 許可するリポジトリパスを制限                      |
| `--quick` / `-q`        | Quick Tunnel（一時URL + トークン認証）を起動      |
| `--remote` / `-r`       | Named Tunnel（固定URL + Cloudflare Access）を起動 |

### 環境変数

| 環境変数            | 説明                                            |
| ------------------- | ----------------------------------------------- |
| `PORT`              | サーバーポート（デフォルト: 4001）              |
| `SKIP_PERMISSIONS`  | `true` で権限確認スキップ                       |
| `ARK_PUBLIC_DOMAIN` | Named Tunnel用の固定ドメイン                    |
| `ARK_TUNNEL_NAME`   | Named Tunnel名（デフォルト: `claude-code-ark`） |

## リモートアクセス

[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) をインストールした上で、Quick Tunnelを使う場合:

```bash
pnpm start:quick
```

起動後、ターミナルにQRコードと一時URL（`*.trycloudflare.com`）が表示される。トークン認証付き。

固定ドメインを使いたい場合は、環境変数 `ARK_PUBLIC_DOMAIN` を設定して `pnpm start:remote` で起動する。

## 開発

| コマンド          | 説明                       |
| ----------------- | -------------------------- |
| `pnpm dev`        | フロントエンド開発サーバー |
| `pnpm dev:server` | バックエンド開発サーバー   |
| `pnpm dev:full`   | フルスタック開発           |
| `pnpm dev:quick`  | Quick Tunnel付き開発       |
| `pnpm build`      | 本番ビルド                 |
| `pnpm start`      | 本番起動                   |
| `pnpm check`      | 型チェック                 |

## ライセンス

MIT
