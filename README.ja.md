<div align="center">
  <h1>Ark</h1>
  <p><strong>手元で動くClaude Codeセッションの運転席</strong></p>
  <p>
    <a href="https://github.com/ignission/claude-code-ark/releases">Releases</a> ·
    <a href="https://github.com/ignission/claude-code-ark/issues">Issues</a> ·
    <a href="README.md">English</a>
  </p>
</div>

Arkは、git worktreeごとにClaude Codeのセッションを1つ動かし、そのすべてを1つの画面で見られるようにするセルフホストのWeb UIです。机のPCからもスマホからも同じセッションを操作できます。

動かしているのは、tmuxの中の対話版 `claude` CLIそのものです。プランも設定も `CLAUDE.md` も、ターミナルで使うときと同じように働きます。Agent SDKもAPIキーも使いません。

<p align="center">
  <img
    src=".github/assets/ark-board.png"
    width="880"
    alt="PCのArk。左にセッション一覧、中央に会話、右のボードにClaudeが描いたシーケンス図"
  />
</p>

> [!WARNING]
> Arkは実験的なプロジェクトで、**1人で使う**ことを前提にしています。認証を通過したクライアントはすべてのセッションに到達でき、Arkがトークンを求めるのはQuick Tunnel経由のアクセスだけです。サーバーへ直接届くアクセス (localhostや同じLAN) にはArkの認証がかからず、Named Tunnelの認証はCloudflare Accessに任せています。複数人での共有は想定していません。トンネルで外に公開するときは十分に注意してください。

## Quickstart

1. Arkを入れます。macOS (Apple Silicon) では `brew install --cask ignission/tap/ark`、それ以外では[ソースから起動](#ソースから起動-macos--linux)します (cloneして1コマンド)。
2. Arkを開き (ソースから起動した場合は http://localhost:4001)、リポジトリを選んで、worktreeでセッションを始めます。
3. Claudeに話しかけます。入力欄の上の帯にターミナルの末尾が出ていて、押すと生のターミナルが窓で開きます。

Claude Codeにログイン済みである必要があります。その機械でClaude Codeを初めて使う場合は、最初のセッションで入力欄の上の帯を押して端末を開き、Claude Codeの初回設定 (配色の選択とログイン) を済ませます。

## 最初に試すこと

**変更の説明をボードに描かせる。** 図の矢印や行から、その裏のコードを開けます。

> セッションを始めたとき、socketのイベントからブラウザに端末が出るまでに何が起きるかを、シーケンス図でボードに描いて。

**キーボードで動かす。** `Ctrl+;` でノーマルモードに入り、`?` でキーの一覧を出します。`J` / `K` でセッションを前後に移り、`n` で次の「あなたの番」へ飛び、`:` でコマンドパレットを開きます。

**スマホから答える。** `./scripts/start.sh --quick` で起動してQRコードを読み取り、Claudeの質問には、自動で開くターミナルから答えます。

## Arkを使う理由

### 開かなくても、各セッションの状況が分かる

サイドバーは、セッションを「あなたの番」「作業中」「休止中」に分けて並べます。Claudeが質問をすると、ターミナルが自動で開き、そこでClaude Codeの選択肢にそのまま答えます。

セッションのブランチにGitHubのPRがあれば、行にPRの番号とチェックの結果 (✓ / ✕ / 待ち、マージ済み、クローズ) が出て、押すとPRが開きます。チェックが落ちると通知が届きます。読み取りには [GitHub CLI](https://cli.github.com/) (`gh`) を使い、1分ごとに更新します。

### 動いているのは本物のClaude Code

Arkはエージェントを作り直していません。各セッションは、detachedなtmuxセッションの中の対話版 `claude` CLIで、画面は [ttyd](https://github.com/tsl0922/ttyd) を通して見せています。会話の表示は、Claude自身が書くtranscriptのファイルから描きます。Arkのサーバーを再起動してもセッションは動き続け、起動し直したArkがつなぎ直します。

### 長い説明は、会話ではなくボードに出る

Claudeは、シーケンス図、差分量つきの呼び出しツリー、複数ページのデッキを、会話の隣のボードに描きます。図の中のリンクを押すと、図を見たまま横にコードが開きます。ボードの文書はその場で書き換えられ、本文を選んでコメントを付け、会話へ送り返せます。

[OpenRouter](https://openrouter.ai/) のキーを入れると、どの返答をボードに出すかの判断もArkに任せられます。[ボード提案](#ボード提案と分岐todo)を参照してください。

### 画面を離れずにレビューできる

<p align="center">
  <img
    src=".github/assets/ark-git.png"
    width="880"
    alt="Gitタブ。上にブランチの札つきのコミットグラフ、下に選んだコミットの差分"
  />
</p>

- **Gitタブ**: ブランチの札つきのコミットグラフ、各コミットの差分、未コミットの変更を見られます。Claudeがコミットすると一覧が追従します。右クリックからブランチの作成・名前変更・削除ができ、fetch / pull (fast-forwardだけ) / pushも画面から実行できます。
- **ファイルタブ**: worktreeのファイルをツリーから開き、CodeMirrorで編集できます。編集中にClaudeが同じファイルを書き換えた場合は、黙ってマージせず、再読込か上書きかを選ばせます。

### スマホから使える

<p align="center">
  <img
    src=".github/assets/ark-mobile-sessions.png"
    width="260"
    alt="スマホのセッション一覧。「あなたの番」と「休止中」に分かれている"
  />
</p>

モバイルには専用のセッション一覧、会話の表示、クイックキーつきのターミナルがあり、日本語のIME入力にも対応しています。iPhoneの音声モードでは、話した指示を送り、Claudeの返答を読み上げます。外からのアクセスには、Arkが起動するCloudflare Tunnelを使います。

### そのほか

- 画像、PDF、テキスト、Excelのファイルを、貼り付け・ドラッグ&ドロップ・ファイル選択でClaudeに送れます。
- コマンドパレットから横道の質問ができます (`Tab`)。道具を持たない別のClaudeが浮かぶウィンドウで答え、セッションの会話には何も入りません。
- サーバーのマシンでheadlessのChromiumを1つ動かし、画面と入力をChrome DevTools Protocolで中継して、Arkの画面に出せます。必要なのはChromiumの実行ファイルだけです。`~/.cache/ms-playwright` にPlaywrightで入れたものを先に探し、なければPATHの `chromium-browser` / `chromium` / `google-chrome` を使います。見つからないときは、この機能だけが無効になります。
- SSHで届くホストのVNC画面 (macOSの画面共有など) を、ブラウザで開けます。Arkはサーバーの実行ユーザーで `ssh -o BatchMode=yes` を起動するので、そのユーザーにパスフレーズ無しの鍵 (またはssh-agentに登録済みの鍵) があり、接続先が `known_hosts` に登録済みである必要があります。
- リポジトリごとに別のClaudeアカウントを使えます (Linuxのみ)。
- 会話の途中で保留にした話題を、TODOタブに残せます。Claudeが「あとで」「別件で」と脇へ置いたとArkが判定すると、ClaudeがTODOとして書き留めます。完了と削除は人間だけが行います。[ボード提案と分岐TODO](#ボード提案と分岐todo)を参照してください。

## 仕組み

```text
表示: <config dir>/projects/<cwd>/*.jsonl → tail → Socket.IO → 会話の表示
入力: 入力欄 → Socket.IO → tmux send-keys → claude CLI
端末: tmuxセッション ←→ ttyd (WebSocket) ←→ iframe
```

- **tmux** が各 `claude` プロセスをdetachedなセッションで保つので、Arkのサーバーより長く動き続けます。
- **ttyd** がそのtmuxセッションをWebターミナルとして見せます。セッションごとに1プロセスです。
- 会話の内容は、すべてClaudeのtranscriptファイルから読みます。ターミナルの画面を解析して会話を復元することはしません。
- セッションのメタデータはSQLite (`data/sessions.db`) に保存します。

## インストール

### macOSアプリ (Apple Silicon)

```bash
brew install --cask ignission/tap/ark
```

[GitHub Releases](https://github.com/ignission/claude-code-ark/releases) から直接ダウンロードもできます。要件はmacOS 12 (Monterey) 以降のarm64で、これ未満は未検証です。

<details>
<summary>「Arkは壊れているため開けません」と表示された場合</summary>

現在の `.app` は **Developer ID署名とAppleのnotarizationに未対応**です (追跡Issue: [#193](https://github.com/ignission/claude-code-ark/issues/193))。このためmacOSは、ダウンロードした `.app` をquarantineの対象とし、壊れていると表示します。

> [!CAUTION]
> 以下の手順はGatekeeperの検証を意図的に迂回します。実行する前に、**入手元が正規であること**を必ず確認してください。
>
> - 配布元が `https://github.com/ignission/claude-code-ark/releases` であること
> - Homebrew Cask経由でインストールした場合は、`brew` が `.zip` のsha256をCask定義 ([`Casks/ark.rb`](https://github.com/ignission/homebrew-tap/blob/main/Casks/ark.rb)) と自動で照合しているので、改ざんは検知されています
> - 直接ダウンロードした場合は、GitHub Releasesのページに載っているsha256と `shasum -a 256 Ark-*.zip` の出力を手元で比べてください

確認を済ませたうえで、quarantine属性を手で削除します。

```bash
# Caskのインストール先 (/Applications/Ark.app) を前提にしています。別の場所にある場合は読み替えてください。
APP="/Applications/Ark.app"
if [ ! -d "$APP" ]; then
  echo "ERROR: $APP が見つかりません。インストール先を確認してください。" >&2
  exit 1
fi
xattr -dr com.apple.quarantine "$APP"
```

Homebrew 4.5で `--no-quarantine` スイッチと環境変数 `HOMEBREW_CASK_OPTS=--no-quarantine` が代替なしで廃止されたため ([Homebrew/brew#19046](https://github.com/Homebrew/brew/pull/19046))、インストールの時点では回避できず、あとから属性を削除する手順だけが残っています。

</details>

### ソースから起動 (macOS / Linux)

```bash
git clone https://github.com/ignission/claude-code-ark.git
cd claude-code-ark
./scripts/start.sh
```

ブラウザで http://localhost:4001 を開きます。

自分で用意するのは、Node.js 22.12.0以上と [tmux](https://github.com/tmux/tmux) だけです。`start.sh` が依存の導入とビルドを済ませ (初回は数分かかります)、起動のたびに前提を調べます。足りないものがあれば、その機械での入れ方を表示して止まります。

- **pnpm**: 無ければ `start.sh` が調達します。
- **ttyd**: Linuxでは、見つからなければ[公式のバイナリ](https://github.com/tsl0922/ttyd/releases)を取得して `data/bin/` に置きます (sha256を照合します)。macOSでは `brew install ttyd` を案内します。
- **Claude Code**: 依存として入るので、別に入れる必要はありません。
- **Chromium**: 任意です。ブラウザ機能だけが使います。
- **GitHub CLI (`gh`)**: 任意です。セッションの行にPRとチェックの結果を出す機能だけが使います。サーバーを動かすユーザーで `gh auth login` を済ませておきます。

更新するときは `git pull` して、もう一度 `./scripts/start.sh` を実行します。コミットが変わっていれば、依存の導入とビルドをやり直します。ポートは `PORT` で変えられます (既定は4001)。オプションの一覧は `./scripts/start.sh --help` で見られます。

## リモートアクセス

[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) をインストールしたうえで、次のように起動します。

```bash
./scripts/start.sh --quick
```

ターミナルにQRコードと一時URL (`*.trycloudflare.com`) が表示されます。URLはランダムなトークンで保護されます。Cloudflare Accessつきの固定ドメインを使う場合は、`ARK_PUBLIC_DOMAIN` を設定して `pnpm start:remote` で起動します。

## ボード提案と分岐TODO

長い説明を会話の中で読むのは疲れます。ボード提案を有効にすると、Claudeが返答を終えるたびに、Arkが [Jev](https://openrouter.ai/docs/guides/community/jev) へ「この返答は会話よりボードのほうが読みやすいか」を問い合わせます。Jevは確率だけを返す分類器で、文章を生成しません。確率が閾値以上なら、Claudeは止まらずに続け、その返答をデッキにしてボードに開きます。

- 判定は1回200〜400msで、費用は入力100万トークンあたり$0.042です。
- Arkが送るのは返答の末尾6,000文字だけで、`data_collection: "deny"` を付けます。
- デッキを描くのはClaudeなので、ほかのターンと同じくClaudeのプランを使います。

有効にする手順は次のとおりです。

1. [OpenRouter](https://openrouter.ai/settings/keys) でAPIキーを発行します。
2. 左上のArkメニュー (スマホではセッション一覧のスライダーアイコン) から「ボード提案と分岐TODOの設定」を開き、キーを貼って保存します。
3. 提案が多すぎる場合は、同じ画面で閾値 (既定0.7) を上げるか、無効にします。

キーはArkのデータベースに保存され、画面には末尾4文字しか表示されません。環境変数 `OPENROUTER_API_KEY` か `~/.config/openrouter/api-key` でも渡せますが、設定画面のキーが優先されます。キーが無い間は何もしません。

設定の変更は次のターンから反映されます。例外は、この機能が入る前の版のArkが `claude` を起動したセッションです。そのセッションでは、`claude` を起動し直すまでボード提案が動きません。

### 分岐TODO

同じ設定画面で有効にでき、同じキーを使います。Claudeが返答を終えるたびに、Arkは人の発話と返答を別の1問で [Jev](https://openrouter.ai/docs/guides/community/jev) に問い合わせ、「別の話題を保留・後回し・対象外にした」確率が閾値以上なら、ClaudeにMCPツール `todo_add` で書き留めさせます。TODOは右ペインのTODOタブ、サイドバーの件数、モバイルのTODO表示に出ます。ClaudeはTODOを完了も削除もできません。

既存のセッションは、`claude` を起動し直すまで分岐TODOが効きません。`claude` はMCPのツール一覧を起動時に取るためです。

## 設定

| オプション              | 説明                                                  |
| ----------------------- | ----------------------------------------------------- |
| `--skip-permissions`    | Claudeを `--dangerously-skip-permissions` 付きで起動  |
| `--repos /path1,/path2` | 許可するリポジトリを制限                              |
| `--quick` / `-q`        | Quick Tunnel (一時URL + トークン認証) を起動          |
| `--remote` / `-r`       | Named Tunnel (固定URL + Cloudflare Access) を起動     |

| 環境変数                    | 説明                                              |
| --------------------------- | ------------------------------------------------- |
| `PORT`                      | サーバーのポート (既定: 4001)                     |
| `SKIP_PERMISSIONS`          | `true` で権限確認をスキップ                       |
| `ARK_PUBLIC_DOMAIN`         | Named Tunnel用の固定ドメイン                      |
| `ARK_TUNNEL_NAME`           | Named Tunnelの名前 (既定: `claude-code-ark`)      |
| `OPENROUTER_API_KEY`        | ボード提案のAPIキー。設定画面のキーが優先される   |
| `ARK_FEATURE_BOARD_SUGGEST` | `false` でボード提案と分岐TODOを止める            |

## 分かっている制限

- **1人用です。** セッション単位の権限は無く、足す計画もありません。
- **macOSアプリは未署名です** ([#193](https://github.com/ignission/claude-code-ark/issues/193))。LinuxとWindows向けのパッケージはありません。Linuxではソースから起動します。
- **Gitタブは作業ツリーの中身を書き換えません。** ブランチの操作とfetch、pull (fast-forwardだけ)、pushはできますが、ステージ、コミット、破棄、チェックアウトはできません。worktreeで使用中のブランチを削除すると、確認のあとでそのworktreeごと消え、セッションも止まります。
- **ファイルタブが編集できるのは既存のファイルだけです。** 新規作成、削除、リネームはできません。
- **Gitタブ、ファイルの編集、キーボード操作はPCだけです。** スマホではファイルを読み取り専用で開きます。
- **リポジトリごとのアカウント切り替えはLinuxだけです。** macOSはClaudeの認証情報をKeychainに保存するためです。
- **音声モードはiPhone向けです。** 画面を点けてArkを前面に出している間だけ動きます。
- **UIは日本語です。**

## 開発

| コマンド          | 説明                         |
| ----------------- | ---------------------------- |
| `pnpm dev`        | フロントエンドの開発サーバー |
| `pnpm dev:server` | バックエンドの開発サーバー   |
| `pnpm dev:full`   | 両方                         |
| `pnpm dev:quick`  | Quick Tunnel付きのバックエンド |
| `pnpm build`      | 本番ビルド                   |
| `pnpm start`      | 本番ビルドを起動             |
| `pnpm check`      | lintと型チェック             |
| `pnpm test`       | ユニットテスト               |

## ライセンス

[Apache License 2.0](LICENSE)
