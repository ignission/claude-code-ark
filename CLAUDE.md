# Ark - 開発引き継ぎ資料

このドキュメントはClaude Codeが開発を引き継ぐための資料です。

## プロジェクト概要

**Ark** は、ローカルで稼働する複数のClaude Codeインスタンスを管理するWebUIアプリケーションです。ユーザーがgitリポジトリとworktreeを選択し、各worktreeに対してClaude Codeセッション（tmux + ttyd）を起動・管理できます。

## アーキテクチャ

### PC: ttyd ターミナル方式 / モバイル: チャットビュー (JSONL tail) 併用

PC のデフォルト UI は ttyd の生ターミナル（`TerminalPane`。`SplitViewPane` の
左ペインに常時表示）。右ペインは図解タブが開かれたときだけ意味を持ち、
上部バーのトグルで開閉する（中身は `DiagramPane`。詳細は下記「セッションボード」）。
チャット形式で会話を描画する `SplitChatPane`（JSONL transcript を tail）は
モバイル専用（`MobileSessionView` の🖥/💬トグルで ttyd 表示と切替）。
エンジンは PC・モバイル共通で tmux 上の対話版 claude
(プラン枠課金を維持。Agent SDK / claude -p は使わない)。

```text
表示: <configDir>/projects/<encoded-cwd>/*.jsonl → JsonlTailManager → Socket.IO → チャット描画（モバイル専用）
入力: チャット入力欄 / ターミナル入力欄 → Socket.IO → tmux send-keys → claude CLI
補助: tmux(セッション) ←→ ttyd(WebSocket) ←→ iframe (PC は常時表示 / モバイルはトグル)
```

**情報源分離の原則 (チャット UI v3 の核心)**: 会話内容は 100% JSONL transcript
から取得する。tmux capture-pane は busy/AWAITING の existence チェック
(`session:previews` の bridgeStatus) のみに使い、**画面テキストから内容を
パースすることは全面禁止** (過去 2 回の挑戦の断念原因)。

1. **tmux**: Claude CLIプロセスをdetachedセッションで管理。サーバー再起動後もセッションが永続化される
2. **JsonlTailManager**: worktree 毎の JSONL を fs.watch + 1 秒 polling で tail し、新規行を購読 socket に push。/clear のファイル切替は onReset → 空 snapshot で追従
3. **ttyd**: tmuxセッションにWebターミナルアクセスを提供（PC は常時表示、モバイルは🖥/💬トグルで表示切替）
4. **SessionOrchestrator**: tmuxとttydを統合管理し、セッションのライフサイクルを制御する

### メッセージ送信の流れ

1. クライアントが `session:send` イベントでメッセージを送信 (送信直後は pending bubble を楽観表示)
2. サーバーの `SessionOrchestrator.sendMessage()` が `tmuxManager.sendKeys()` を呼び出す
3. tmuxの `C-u` (入力欄クリア) → `send-keys -l` でリテラル入力 + `Enter` キーを送信
4. claude が transcript (JSONL) に追記 → tail がクライアントへ push → pending と reconcile して確定描画

### AskUserQuestion (重要な実機知見)

対話版 claude は AUQ の tool_use を**回答/拒否が確定した瞬間**に tool_result と
まとめて JSONL へ書く (質問表示中は JSONL に何も出ない)。そのため:

- **質問のリアルタイム検出**: セッション起動時に `--settings` で注入する
  PreToolUse hook (`auq-hook-bridge.ts`) が tool_input.questions を
  `/api/internal/auq-event` へ POST → `session:auq` でカード表示
- **回答**: カードから tmux キー送出 (単問 single = digit 一発 / multiSelect =
  digit トグル → Right → Review digit 1 / 自由入力 = digit → literal → Enter)
- **カードを閉じる**: JSONL に解決イベントが出現したとき (`hasResolvedAuqSince`)
- permission prompt 等は AWAITING バナー (+[1][2] クイックキー + ターミナル誘導)

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
| チャットビュー (モバイル専用) | JSONL tail ベースの会話描画 + pending reconcile + AskUserQuestion カード + slash 補完 + busy/AWAITING 表示（`MobileSessionView` の🖥/💬トグルで ttyd 表示と切替） |
| セッションボード       | worktree の `.claude/diagrams/*.diagram.html`（意味モデル + HTML 投影）を表示する図解ペイン（右ペインタブ・PC のみ）。Claude が MCP ツール `board_open` で開き、ファイル更新を検知して自動再読込する |
| Webターミナル          | ttyd iframeによるフルターミナル体験（PC はデフォルト表示、モバイルは🖥/💬トグルでチャットビューと切替） |
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
- **superpowersスキルが生成するplan/specファイル（`docs/superpowers/specs/`, `plans/` 等）は成果物としてコミットし、作業のPRに含める**（設計承認の対象物をdiffとして残す・履歴アーティファクト。flow-x P2.5 の設計承認は plan だけの diff を持つ draft PR で取る）
- **ローカルとリモートのブランチ名は必ず一致させる**（異なる名前でpushすると `gh pr view` がPRを検出できず、CI監視・CodeRabbit取得が全て失敗する）
- **CodeRabbitのstatusが `error`（処理中）の場合、CIが成功していても監視を停止してはならない**。`completed` かつ未解決スレッド0件を確認してから停止する
- **git push は必ずフォアグラウンドで実行する**（バックグラウンド実行するとpush完了前にCodeRabbit返信が送信されてしまう）
- **CodeRabbitの1コメントに複数の修正ポイントが含まれる場合がある**。対応前に全ポイントを箇条書きにしてから実装に入ること
- **コミット前に現在のブランチを確認する。** 意図したfeatureブランチにいることを検証してからコミットすること。mainや無関係なブランチへの誤コミットを防ぐ
- **セルフレビュー禁止・成果物は必ず「作った側と別の AI」がレビューする**。自分が実装した成果物を自分でレビューしてはならない。Claude が実装した場合のレビューは `/codex review`（Codex CLI）に委任する。**例外: `/flow-x`（役割逆転 skill）では codex が実装するため、レビューは Claude が担う** — この場合も「実装者 ≠ レビュアー」の原則は保たれている。push 前レビューは flow の P5 codex ゲート / flow-x の P5 Claude レビューが担う（旧 `/pre-push-review` skill は撤廃済み）

## 自走実装（flow / flow-x / flow-loop）

- **`/flow #NNN`（または slug）**: Claude が plan/実装し codex がレビューゲート (P2/P5/P8/P9) を担う自走 skill。worktree 作成 → plan → 実装 (TDD) → ローカル検証 → push → CI/CodeRabbit 監視 → 自律修正 → マージ確認 (人間) → cleanup → pm2 deploy 監視 (P12: 30 秒間隔・最大 5 分) を 1 セッションで実行。worktree は `<repo-parent>/ark-<sanitized-branch>/` に作られ、P11 では削除しない（deploy 確認後にユーザーが手動 `git worktree remove`）
- **`/flow-x #NNN`**: flow の役割逆転版。**codex が plan 立案と実装** (`codex exec --dangerously-bypass-approvals-and-sandbox`)、**Claude がレビュー** (P2/P5/P8/P9)。**P2.5 設計承認ゲート**（人間が plan を承認してから実装へ）を持ち、plan は成果物としてコミットする。`--async-gates` で待ちを park に変える非同期モードになる
- **運転ループ `/flow-loop`**: `/flow-x` の外殻。自分アサインの open Issue を WIP 上限 (既定 2) 内で自動 pick し `/flow-x --async-gates` で回す冪等な `tick` を提供する。人間ゲートは **P2.5 設計承認**と **P10 マージ確認**の 2 つで廃止せず、判断を **GitHub PR 上のシグナル** (コメント「承認」`ok` `lgtm` /「修正: <指示>」/ Close。author 本人の PR は GitHub 仕様で Approve 不可のためコメントで判断) として非同期に検知する。設計承認は plan をコミットした draft PR で取る。P7 (CI/CodeRabbit) / P12 (deploy) のセッション内待機 (Monitor/CronCreate) も tick のポーリングに置き換わるため、セッションを拘束しない。安全装置: サーキットブレーカー (連続 halt 3 で停止)・kill switch・`--dry-run`・日次 pick 予算・`active_hours`。loop に処理させない Issue は GitHub ラベル `loop-exclude` で pick 対象から外す。常駐運用は `/loop 30m /flow-loop tick`。詳細は `.claude/skills/flow-loop/SKILL.md`

## デプロイ手順

mainブランチをpullした後は、以下の手順で **順番通りに** ビルド・再起動する：

```bash
# 1. 依存関係をインストール
#    毎日の bump-claude-code ワークフローによる同梱 @anthropic-ai/claude-code の
#    更新は install で初めて node_modules に反映される。省略すると稼働中の Ark が
#    旧バージョンの claude を配り続ける
pnpm install --frozen-lockfile

# 2. ビルド
pnpm build

# 3. 古いttydプロセスをkill（再起動の直前に実行）
#    ttydは各セッションごとに独立プロセスで起動しており、
#    サーバー再起動時に同じポートを確保できずEADDRINUSEになるため、
#    必ず再起動前にkillする。-f だとコマンドライン文字列に "ttyd" を含む
#    無関係なプロセスに誤マッチしうるため、プロセス名一致の -x を使う
pkill -x ttyd

# 4. pm2で再起動（サーバー起動時にttydも自動で再起動される）
pm2 restart claude-code-ark
```

**注意**:

- `pkill -x ttyd` を省略するとttydのポート(7680〜)が競合し、ターミナルが表示されなくなる
- `@anthropic-ai/claude-code` の postinstall（native binary の配置）はルート `package.json` の `pnpm.onlyBuiltDependencies` で許可している。リストから外すと install 後も `claude native binary not installed` で起動できなくなる

## 一般規約

- **コマンド実行を依頼されたら即実行する。** コマンドの説明や注意点だけ述べて実行しない、という振る舞いは禁止。「実行しますか？」の確認も不要（CLAUDE.mdで明示的に確認を求めている場合を除く）
- **曖昧な指示（「リファクタリングして」「修正して」「改善して」等）を受けた場合、実装前にやることを2文で要約しユーザーの確認を得ること。** 明確な指示（具体的な修正内容記載）の場合は確認不要

## 既知の制約

### プロファイル切替（Linux限定）

- **C-1: プロファイル変更は新規セッションにのみ適用される**。tmuxセッションは起動時に確定したenvを保持する。リポジトリのプロファイル紐付けを変えても、稼働中のセッションは元のプロファイルで動作し続ける。UIは`staleProfile`バッジ + 「再起動」ボタンを表示する（再起動はClaude会話履歴を破壊するので確認ダイアログ必須）
- **C-2: 同一プロファイルの並行セッションは非推奨**。1プロファイル=1`.credentials.json`を共有するため、複数セッション同時稼働でリフレッシュトークン競合が発生する可能性あり（[claude-code#24317](https://github.com/anthropics/claude-code/issues/24317) 等）
- **C-3: macOS / Windows非対応**。macOSはOAuth credentialsをKeychainに保存するため、`CLAUDE_CONFIG_DIR`分離だけではプロファイル切替できない。`multiProfileSupported=false`でUIを完全非表示

### Beacon（tmux 対話版 claude）

Beacon は専用 tmux セッション `ark-beacon` で**対話版 claude を常駐起動**し、JSONL transcript を tail して描画する（`claude -p` ではない＝プラン枠課金を維持）。対話版 claude は**起動時の構成を生存中ずっと保持する**ため、以下の制約がある:

- **C-B1: 起動後の `--add-dir` / 外部 OAuth MCP は固定される**。Beacon 起動後に追加した登録リポジトリ・新規 worktree や、回復した外部 MCP（Jira/Linear 等）は、稼働中の会話には反映されない。反映するには Beacon をリセット（停止ボタン = stop-and-reset、または 🗑 = clear）して再起動する必要がある。`create_worktree` 直後に同一会話でその worktree を Beacon 自身が `Read` するケースが該当（タスク着手フローは新 worktree を別セッションへ委譲する設計のため実害は小さい）。**外部 OAuth MCP の access token も launch 時点で固定される**ため、長時間（>1h）セッションでは token 失効後に Jira/Linear 等が失敗する → [#202](https://github.com/ignission/claude-code-ark/issues/202)（token-refresh プロキシ等で対応予定。回避策はリセット）。ark-beacon MCP は Ark 管理の固定 token なので影響なし
- **C-B2: ark-beacon MCP の degraded 起動のみ自己回復する**。ArkMcpServer 起動失敗時は司令塔ツール無し（degraded）で起動するが、次ターンで MCP が回復していれば自動でセッションを貼り直す（会話文脈はリセットされる）。外部 OAuth MCP の起動時失敗は自己回復せず C-B1 のリセットで対応する
- **C-B3: ark-beacon MCP は固定 port + 永続 token で起動する**。常駐 claude は起動時の mcp-config（url/token）を保持し続けるため、サーバー再起動後も同じ endpoint へ再接続できるよう port/token を settings に永続化している（`beacon_ark_mcp_port` / `beacon_ark_mcp_token`）。port が他プロセスに奪われた場合のみ ephemeral にフォールバックし、その会話の司令塔ツールはリセットまで失敗する
- **C-B4: MCP 接続の追加/削除（auth-completed / disconnect）は会話文脈をリセットする**。`markMcpConfigStale` が次ターンで tmux セッションを貼り直すため。**この貼り直し（C-B2 の degraded 復旧 / C-B3 のポート変化を含む）では UI 履歴も同時にクリアされる**（claude 文脈が消えるのに履歴だけ残ると「モデルが覚えていない履歴」に追記してしまうため、整合させて全クライアントへ空履歴を broadcast する）

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
| `session:jsonl-subscribe` | `sessionId: string`             | JSONL 履歴の購読開始（snapshot + 増分 push）|
| `session:jsonl-unsubscribe` | `sessionId: string`           | JSONL 購読解除                   |
| `session:jsonl-load-more` | `{ sessionId, limit }`          | 過去履歴を limit 行で snapshot 再送 |
| `session:send-literal` | `{ sessionId, text }`              | Enter 無しの literal 送信（AUQ 自由入力用）|
| `diagram:subscribe` | `{ worktreePath, relPath }`           | 図ファイルの更新監視を開始（1セッション1図を想定） |
| `diagram:unsubscribe` | `{ worktreePath, relPath }`         | 図ファイルの更新監視を解除                       |
| `slash:list`      | `sessionId, callback`                   | slash command 候補一覧（コールバック）|
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
| `session:jsonl-snapshot` | `{ sessionId, lines }`         | JSONL 履歴 snapshot（/clear 切替時は空配列）|
| `session:jsonl-line`     | `{ sessionId, line }`          | JSONL 新規行 push                |
| `session:auq`            | `{ sessionId, at, questions }` | 回答待ち AskUserQuestion（PreToolUse hook 由来）|
| `diagram:open`           | `{ sessionId, relPath }`       | Claude が `board_open` を呼んだ。クライアントは図タブを開く |
| `diagram:updated`        | `{ worktreePath, relPath }`    | 監視中の図ファイルが更新された。クライアントは再読込する |
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

- **Node.js** >= 22.12.0（同梱 Claude Code 2.1.207 + Vite 8 の要件）
- **pnpm**
- **tmux**
- **ttyd**
- **cloudflared**（リモートアクセス使用時のみ）
