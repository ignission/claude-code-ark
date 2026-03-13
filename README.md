# Claude Code Manager

**複数のClaude Codeセッションを、ひとつのWebUIから。**

<!-- スクリーンショットやGIFをここに追加 -->

> [!WARNING]
> このプロジェクトは実験的なものです。Cloudflare Tunnelなどを利用してリモートからアクセスする場合は、セキュリティに十分注意してください。信頼できないネットワーク上での公開は推奨しません。

## なぜ必要か

Claude Codeで本格的に開発を始めると、すぐにターミナルのタブが爆発する。

worktreeごとにClaude Codeを起動して、featureブランチ用、bugfix用、実験用...と増えていく。どのタブでどのセッションが動いているか見失い、外出先からは進捗すら確認できない。サーバーを再起動すればセッションは消え、コンテキストも失われる。

Claude Code Managerは、そういった問題をまとめて解決する。ブラウザを開けば、すべてのセッションが一覧でき、どこからでも操作できる。

## Features

- **セッション管理** -- worktreeごとにClaude Codeセッションを起動・停止。サーバー再起動後も自動復元
- **ブラウザ操作** -- Webターミナルから直接Claude Codeを操作。ローカルにターミナルを開く必要なし
- **マルチペイン** -- 最大4つのセッションを同時に表示・監視（PC）
- **モバイル対応** -- スマホからフル操作可能。IME / 日本語入力にも対応
- **リモートアクセス** -- Cloudflare Tunnelで外出先からセッションにアクセス。QRコードですぐ接続
- **Git Worktree統合** -- WebUIからworktreeの作成・削除・一覧表示

## Quick Start

### 前提条件

- Node.js >= 20.6.0
- [pnpm](https://pnpm.io/)
- [tmux](https://github.com/tmux/tmux)
- [ttyd](https://github.com/tsl0922/ttyd)

### インストールと起動

```bash
git clone https://github.com/ignission/claude-code-manager.git
cd claude-code-manager
pnpm install
pnpm build
pnpm start
```

ブラウザで http://localhost:3001 を開く。

## リモートアクセス

[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) をインストールした上で、Quick Tunnelを使う場合:

```bash
pnpm start:quick
```

起動後、ターミナルにQRコードと一時URL（`*.trycloudflare.com`）が表示される。トークン認証付き。

固定ドメインを使いたい場合は、環境変数 `CCM_PUBLIC_DOMAIN` を設定して `pnpm start:remote` で起動する。

## 開発

| コマンド | 説明 |
|---------|------|
| `pnpm dev` | フロントエンド開発サーバー |
| `pnpm dev:server` | バックエンド開発サーバー |
| `pnpm dev:full` | フルスタック開発 |
| `pnpm dev:quick` | Quick Tunnel付き開発 |
| `pnpm build` | 本番ビルド |
| `pnpm start` | 本番起動 |
| `pnpm check` | 型チェック |

## ライセンス

MIT
