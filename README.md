# Ark

**複数のClaude Codeセッションを、ひとつのWebUIから。**

<!-- スクリーンショットやGIFをここに追加 -->

> [!WARNING]
> このプロジェクトは実験的なものです。Cloudflare Tunnelなどを利用してリモートからアクセスする場合は、セキュリティに十分注意してください。信頼できないネットワーク上での公開は推奨しません。
>
> Ark は**単一ユーザー向け**です。認証を通過したクライアントは全セッションに到達できるため、複数人で共有する構成は想定していません。また、localhost / プライベート IP からのアクセスは認証をスキップします。

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
- **画像送信** -- クリップボードから画像をペーストしてClaude Codeに送信（`@パス` 形式）
- **セッションボード** -- Claude が書いた図や文書を右ペインに表示。本文を選んでコメントを付け、会話に戻せる
- **ボード提案 (Jev)** -- 長い返答をチャットで読ませない。返答が終わるたびに Jev (TypeSafe の決定モデル) が「ボードのほうが読みやすいか」を判定し、そうなら Ark が返答を文書にしてボードに出す。Claude のトークンは使わない

## アーキテクチャ

Arkは、Agent SDKではなく **tmux + ttyd によるターミナル転送方式** を採用している。これにより、Claude CLIのフルターミナル体験をブラウザ上でそのまま再現できる。

```text
ブラウザ(iframe) ←→ ttyd(WebSocket) ←→ tmux(セッション) ←→ claude CLI
```

- **tmux** がClaude CLIプロセスをdetachedセッションで管理し、サーバー再起動後もセッションが永続化される
- **ttyd** がtmuxセッションにWebターミナルアクセスを提供し、各セッションに独立したttydプロセスが起動する

## Quick Start

### macOS (.app, Apple Silicon)

Homebrew Cask:

```bash
brew install --cask ignission/tap/ark
```

または GitHub Releases から直接ダウンロード: <https://github.com/ignission/claude-code-ark/releases>

要件: macOS 12 (Monterey) 以降、arm64 (Apple Silicon)。Cask の `depends_on macos: ">= :monterey"` に合わせており、これ未満は未検証です。

#### 初回起動で「Ark は壊れているため開けません」と表示された場合

現在の `.app` は **Developer ID 署名・Apple notarization が未対応** (追跡 issue: [#193](https://github.com/ignission/claude-code-ark/issues/193))。
このため macOS は Homebrew 経由でダウンロードした `.app` を quarantine 対象として "damaged" 判定します。

> [!CAUTION]
> 以下の手順は Gatekeeper の検証を意図的に迂回します。実行前に **入手元が正規であること** を必ず確認してください:
>
> - 配布元が `https://github.com/ignission/claude-code-ark/releases` であること
> - Homebrew Cask 経由でインストールした場合、`brew` が `.zip` の sha256 を Cask 定義 ([`Casks/ark.rb`](https://github.com/ignission/homebrew-tap/blob/main/Casks/ark.rb)) と自動照合しているため、改ざんは検知されています
> - 直接ダウンロードした場合は GitHub Releases ページ掲載の sha256 と `shasum -a 256 Ark-*.zip` 出力を手元で比較してください

署名対応完了までは、**上記 CAUTION の真正性確認 (Cask 経由なら自動 sha256 照合済み、それ以外なら手動照合) を済ませた上で**、インストール後に quarantine 属性を手動で削除してください:

```bash
# Cask の install 先 (/Applications/Ark.app) 前提。別パスにある場合は読み替え。
APP="/Applications/Ark.app"
if [ ! -d "$APP" ]; then
  echo "ERROR: $APP が見つかりません。インストール先を確認してください。" >&2
  exit 1
fi
xattr -dr com.apple.quarantine "$APP"
```

> [!NOTE]
> Homebrew 4.5 で `--no-quarantine` switch および `HOMEBREW_CASK_OPTS=--no-quarantine` 環境変数が **代替なしで廃止** されたため、現状 install 時点での回避はできません。`xattr -dr` で事後削除する手順のみが残された対処です。
> 参考: <https://github.com/Homebrew/brew/pull/19046>

### Linux / 開発環境 (ソースから起動)

#### 前提条件

- Node.js >= 20.6.0
- [pnpm](https://pnpm.io/)
- [tmux](https://github.com/tmux/tmux)
- [ttyd](https://github.com/tsl0922/ttyd)
- [Claude Code CLI（`claude`）](https://docs.claude.com/en/docs/claude-code) -- **インストール済みかつログイン済み**であること（確認: `claude --version` / 未ログインなら `claude` を起動して `/login`）

#### インストールと起動

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
| `OPENROUTER_API_KEY` | ボード提案 (Jev) の API キー。設定画面のキーが優先 |
| `ARK_FEATURE_BOARD_SUGGEST` | `false` でボード提案を止める |

## ボード提案 (Jev)

Claude の長い説明をチャットで読むのはしんどい。ボード提案は、返答が終わるたびに
[Jev](https://openrouter.ai/docs/guides/community/jev) (TypeSafe の決定モデル。文章を生成せず、テキストと型付きの質問に確率だけ返す分類器) へ「この返答はチャットよりボードのほうが読みやすいか」を問い、閾値以上なら Ark が動く。

- **文書と判定したら**: 返答の markdown を Ark が doc 型のボードへ機械変換して開く。Claude には何も送らないので、Claude のトークンは 0。生成物は worktree の `.claude/diagrams/_auto/<sessionId>/` に残り、ボードでコメントを付けて会話に戻せる
- **図が要ると判定したら**: チャットに「図にする」ボタンを出す。押したときだけ Claude に作図を頼む (トークンを使うのは人が押したときだけ)
- 判定は 1 回 200〜400ms、費用は 100 万トークンあたり $0.042 (1 ターン 0.002 円ほど)。会話本文は末尾 6,000 文字だけを送り、学習利用は拒否 (`data_collection: deny`) を指定する

### 使い方

1. [OpenRouter](https://openrouter.ai/settings/keys) で API キーを発行する
2. Ark の左上「Ark ▾」メニュー (スマホはセッション一覧のスライダーアイコン) から **ボード提案の設定** を開き、キーを貼って保存する
3. 以後、長い返答が終わるとボードが開く。うるさければ同じ画面で閾値 (既定 0.7) を上げるか、チェックを外して止める

キーは Ark のデータベースに保存され、画面には末尾 4 文字しか戻さない。環境変数 `OPENROUTER_API_KEY` か `~/.config/openrouter/api-key` でも渡せる (設定画面のキーが優先)。キーが無い間は何もしない。

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
