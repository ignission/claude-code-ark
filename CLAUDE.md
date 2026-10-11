# Ark

Arkは、ローカルで動く複数のClaude Codeセッションを管理するWeb UI。gitのworktreeごとにセッション (tmux + ttyd) を起動し、PCとモバイルから見て動かす。

機能の一覧、起動オプション、環境変数、前提のツールは `README.ja.md` にある。Socket.IOのイベントの正本は `packages/shared/src/types.ts`。

## このファイルと `.claude/rules/`

ここに置くのは、どの作業でも要る原則と規約だけ。機能ごとの設計の決まりは `.claude/rules/` にあり、`paths:` に書いたコードを読むと読み込まれる。**機能の決まりを足すときは、ここではなく該当するrulesへ書く** (無ければ `paths:` 付きで作る)。

| ファイル | 中身 |
|---|---|
| `session-views.md` | 端末と会話の切り替え、PCのパネル構成、ttydの切断復帰、メッセージ送信 |
| `ask-user-question.md` | AskUserQuestionの検出、カード、回答のキー送出 |
| `diagram-board.md` | セッションボード、コメントの操作ID、docの書き手の印、図の一覧 |
| `board-suggest.md` | ボード提案 (Jev判定とStop hook) |
| `file-pane.md` | ファイルペインの書き込み、監視、タブ、ピーク |
| `git-tab.md` | Gitタブの読み取り、追従、グラフ |
| `keynav.md` | ノーマルモードとコマンドパレット |
| `ask.md` | Claudeに聞く (裏のClaude) |
| `tmux-read-result.md` | tmux読み取りの結果型 |
| `remote-access.md` | Cloudflare Tunnel、認証、単一ユーザーの前提 |
| `remote-screen.md` | リモート画面 (noVNC + `ssh -W`) |
| `voice-mode.md` | 音声モード |
| `context-engineering.md` | コンテキスト機構を足す前に通る条件 (常に読み込まれる) |
| `backend-*.md` / `frontend-codegen.md` | サーバーとフロントの実装パターン |

## アーキテクチャ

エンジンはPCとモバイルで共通の、tmux上の対話版claude。プラン枠の課金を保つため、Agent SDKと `claude -p` は使わない。

```text
表示: <configDir>/projects/<encoded-cwd>/*.jsonl → JsonlTailManager → Socket.IO → チャット描画
入力: チャット入力欄 / ターミナル入力欄 → Socket.IO → tmux send-keys → claude CLI
補助: tmux (セッション) ←→ ttyd (WebSocket) ←→ iframe
```

- **tmux**: claudeをdetachedセッションで動かす。Arkのサーバーを再起動してもセッションは残る
- **JsonlTailManager**: worktreeごとのJSONLを `fs.watch` と1秒のpollingでtailし、購読中のsocketへ送る。`/clear` でファイルが替わったら空のsnapshotを送る
- **ttyd**: tmuxセッションをWebターミナルとして見せる。セッションごとに1プロセス
- **SessionOrchestrator**: tmuxとttydをまとめて持ち、セッションのライフサイクルを制御する

### 情報源分離の原則

会話の内容は100% JSONLのtranscriptから取る。**画面テキストから内容をパースすることは全面禁止** (過去2回の挑戦を断念した原因)。

`tmux capture-pane` を使ってよいのは次の2つだけ。

- busy / AWAITINGの有無の判定 (`session:previews` の `bridgeStatus`)
- 画面のverbatim表示。AUQカードの「直前の画面」と、作業中 (THINK / TOOL) の会話ビューに出す画面末尾 (`session:previews` の `liveTail`)。解釈しないスクリーンショットのような添付で、`auq-screen-context.ts` が扱う

### セッションの永続化

- tmuxセッションはサーバーの再起動をまたいで残る (`cleanup()` はttydだけを止める)
- セッションのメタデータ (worktreeId、statusなど) はSQLite (`data/sessions.db`) に持つ
- サーバーは起動時に `ark-` で始まるtmuxセッションを見つけ、ttydを起動し直す

### コンテキスト機構は持たない

Arkはセッションに、task.mdの規約、復唱、失敗の記録、知識の配布のどれも注入しない。セッションが受け取るのは、Claude Codeが標準で与えるものと、リポジトリ自身の `CLAUDE.md` と `.claude/` だけ。作業の記憶や横断知識は、利用者自身の設定 (`~/.claude/CLAUDE.md`、native auto memoryなど) で持つ。

同種の機構を4代目まで作り、4代目とも撤去した (Frontline 8,108行 / Beacon 10,016行 / flow 8,845行 / ark/context 10,350行)。足していたのは既にある機構のこだまだった (#367の対照実験6回、#401で撤去)。機構そのものも「実装済みなのに発火しない / 無音で止まる」不具合を10件生み (#350 #352 #357 #365 #369 #372 #373 #383 #397)、うち9件は配達装置の中にあった。**5代目を作る前に `.claude/rules/context-engineering.md` を読む。**

## Git・PRワークフロー

- **実装が終わったら、確認せずにpushする** (「pushしますか?」と聞かない)
- **コミットの前に現在のブランチを確かめる。** mainや無関係なブランチへ誤ってコミットしない
- **ローカルとリモートのブランチ名を一致させる。** 違う名前でpushすると `gh pr view` がPRを見つけられず、CIの監視とCodeRabbitの取得がすべて失敗する
- **`git push` はフォアグラウンドで実行する。** バックグラウンドだと、pushが終わる前にCodeRabbitへの返信が送られる
- **セルフレビュー禁止。成果物は作った側と別のAIがレビューする。** Claudeが実装したら `/codex review` (Codex CLI) へ委ね、Codexが実装したらClaudeがレビューする
- **push後のCIの結果とCodeRabbitの指摘は自分で確かめる** (`gh pr view <PR#> --json statusCheckRollup` など。自動で取るhookは撤去済み)
- **CIの失敗は自分で直す。** エラーログを読み、根本の原因を直す。`--no-verify` でhookを飛ばす提案はしない
- **CodeRabbitのstatusが `error` (処理中) の間は、CIが通っていても監視をやめない。** `completed` かつ未解決スレッド0件を確かめてからやめる

CodeRabbitの指摘への対応:

- **指摘には自分で対応する。** 設計方針の変更を伴う指摘だけ、ユーザーに判断を仰ぐ
- **対応済みでも不要でも、すべてのコメントに返信する**
- **修正のコミット → push → 返信の順で行う。** push前に返信すると、CodeRabbitが修正後のコードを見られない
- **「次回対応」「今後改善」のような先送りの返信は禁止。** このPRで対応するか、対応しないならGitHub Issueを作ってから返信する
- **新しい指摘かどうかは `created_at` で絞る。** `commit_id == HEAD` で絞ると、fixコミットでHEADが変わったあと、前のコミットへの指摘をすべて見落とす
- **1つのコメントに複数の修正点が入っていることがある。** 実装の前に全部を箇条書きにする
- **`resolveReviewThread` で勝手にresolveしない** (resolveはユーザーが判断する)

## デプロイ

mainをpullしたあとは、`build-deploy` スキル (`.claude/skills/build-deploy/SKILL.md`) の手順で行う。順番は次のとおりで、入れ替えない。

```bash
pnpm install --frozen-lockfile   # 同梱claudeの更新はinstallで初めて反映される
pnpm build
pkill -x ttyd                    # 再起動の直前に。省くとttydのポート (7680〜) が競合する
pm2 restart claude-code-ark
```

各手順の理由、pnpm 11が入らないときの対処、pm2のenv汚染の確かめ方はスキルに書いてある。

## 一般規約

- **コマンドの実行を頼まれたら、すぐ実行する。** 説明や注意点だけ述べて実行しない、という振る舞いは禁止。「実行しますか?」の確認も要らない (このファイルが確認を求めている場合を除く)
- **曖昧な指示 (「リファクタリングして」「修正して」「改善して」など) を受けたら、実装の前にやることを2文で要約し、ユーザーの確認を得る。** 修正の内容が具体的に書かれた指示なら確認は要らない

## 開発原則: レイヤーをまたぐ変更の検証

- ある機能がレイヤーの境界 (クライアントとサーバー、永続化とメモリなど) をまたいで依存するなら、依存先がそれを供給する経路まで確かめる
- リロード、再接続、再起動のように状態が消えるタイミングで、依存が満たされるかを確かめる
- レビューでは、PRの差分の外に暗黙の前提が無いかを見る。たとえばクライアント側の永続化を実装したら、サーバー側がそのデータを供給する経路も検証の対象に含める

## 既知の制約: プロファイル切替 (Linux限定)

リポジトリ単位で別々の `CLAUDE_CONFIG_DIR` を使う機能。認証は通常のセッションの中で `claude /login` を実行する。

- **C-1: プロファイルの変更は、新しく起動したセッションにだけ効く。** tmuxセッションは起動時のenvを持ち続けるので、紐付けを変えても稼働中のセッションは元のプロファイルで動く。UIは `staleProfile` のバッジと「再起動」ボタンを出す (再起動はClaudeの会話履歴を壊すので、確認のダイアログが必須)
- **C-2: 同じプロファイルのセッションを並行で動かすのは非推奨。** 1プロファイルが1つの `.credentials.json` を共有するので、リフレッシュトークンが競合しうる ([claude-code#24317](https://github.com/anthropics/claude-code/issues/24317) など)
- **C-3: macOSとWindowsは非対応。** macOSはOAuthのcredentialsをKeychainに保存するので、`CLAUDE_CONFIG_DIR` を分けるだけでは切り替えられない。`multiProfileSupported=false` でUIをすべて隠す
