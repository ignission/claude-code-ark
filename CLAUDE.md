# Ark - 開発引き継ぎ資料

このドキュメントはClaude Codeが開発を引き継ぐための資料です。

## プロジェクト概要

**Ark** は、ローカルで稼働する複数のClaude Codeインスタンスを管理するWebUIアプリケーションです。ユーザーがgitリポジトリとworktreeを選択し、各worktreeに対してClaude Codeセッション（tmux + ttyd）を起動・管理できます。

## アーキテクチャ

### ttyd ターミナル方式 / チャットビュー (JSONL tail) 併用

PC・モバイルとも、ttyd の生ターミナル（`TerminalPane`）と、チャット形式で会話を
描画する `SplitChatPane`（JSONL transcript を tail）を切り替えて使う。

- **PC**: `SplitViewPane` は 左 = 端末 / 会話、右 = 作業エリア の 2 ペイン。
  左ペインは上部バーの🖥/💬トグルで切り替える（既定は端末）。作業エリアは
  上部バー右端の「パネル」トグルで開閉し、上端のタブ「図 / ファイル / Git」で中身を
  切り替える（中身は `DiagramPane`・`FilePane`・`GitPane`。詳細は下記「ファイルペイン」
  「Git タブ」「セッションボード」）。端末・会話のリンクからファイルを開くと作業エリアが
  「ファイル」のタブで開き、左ペインのモードは変わらない。図の中のコードリンクは
  タブを替えず、図の横の「ピーク」（`FilePeek`）で開く。
  **幅を持つのは左ペインで、作業エリアは残りを埋める**（当初は作業エリアが幅を持ち、
  ピークや「Git」のタブの間だけ広げていたが、そのたびに会話の幅が変わって文章の
  折り返しが動いた）。
  左ペインの選択と幅・作業エリアの開閉とタブ・開いているファイルタブ・
  ファイルツリーの展開と折りたたみは localStorage に永続化する
- **PC の見た目は「浮かぶパネル」**。色のついた壁紙 (`--wallpaper`) の上に、サイドバー・
  左 (上部バー + 端末 / 会話)・作業エリアの 3 枚を 8px のすき間で離して置き、区切りの線は
  引かない (`index.css` の `.app-wallpaper` / `.panel` / `.panel-glass` / `bg-well`)。
  パネルの間のすき間がそのままリサイザになる。パネルの中は線ではなく、くぼみ (`--well`) で
  分ける。大きな面に `backdrop-filter` は使わない (ttyd の iframe と CodeMirror が描き直す
  たびにぼかしが走るため)。暗い配色では影が見えないので、パネルを壁紙より明るい面にする
- **モバイル**: `MobileSessionView` の🖥/💬/📐トグルで 1 画面ずつ切り替える（既定は会話）

左ペインは端末・会話の両方をマウントしたまま `display` で切り替える。ttyd は
iframe（別ブラウジングコンテキスト）なので、アンマウントすると再接続になるため。
その代わり「見えていないペイン」も生きているので、JSONL 購読と window レベルの
ファイル D&D は表示中の 1 枚だけに絞る（`split-view-left-mode.ts`）。

エンジンは PC・モバイル共通で tmux 上の対話版 claude
(プラン枠課金を維持。Agent SDK / claude -p は使わない)。

```text
表示: <configDir>/projects/<encoded-cwd>/*.jsonl → JsonlTailManager → Socket.IO → チャット描画
入力: チャット入力欄 / ターミナル入力欄 → Socket.IO → tmux send-keys → claude CLI
補助: tmux(セッション) ←→ ttyd(WebSocket) ←→ iframe (どちらもトグルで表示切替)
```

**情報源分離の原則 (チャット UI v3 の核心)**: 会話内容は 100% JSONL transcript
から取得する。tmux capture-pane は busy/AWAITING の existence チェック
(`session:previews` の bridgeStatus) と、AUQ カードの「直前の画面」および
作業中 (THINK / TOOL) の会話ビューに出す画面末尾 (`session:previews` の `liveTail`)
の **verbatim 表示** (`auq-screen-context.ts`。無解釈のスクリーンショット的添付)
のみに使い、**画面テキストから内容をパースすることは全面禁止**
(過去 2 回の挑戦の断念原因)。

1. **tmux**: Claude CLIプロセスをdetachedセッションで管理。サーバー再起動後もセッションが永続化される
2. **JsonlTailManager**: worktree 毎の JSONL を fs.watch + 1 秒 polling で tail し、新規行を購読 socket に push。/clear のファイル切替は onReset → 空 snapshot で追従
3. **ttyd**: tmuxセッションにWebターミナルアクセスを提供（PC は左ペイン、モバイルは全画面。どちらも🖥/💬トグルで会話ビューと切替）
4. **SessionOrchestrator**: tmuxとttydを統合管理し、セッションのライフサイクルを制御する

### メッセージ送信の流れ

1. クライアントが `session:send` イベントでメッセージを送信 (送信直後は pending bubble を楽観表示)
2. サーバーの `SessionOrchestrator.sendMessage()` が `tmuxManager.sendKeys()` を呼び出す
3. tmuxの `C-u` (入力欄クリア) → `send-keys -l` でリテラル入力 + `Enter` キーを送信
4. claude が transcript (JSONL) に追記 → tail がクライアントへ push → pending と reconcile して確定描画

### ttyd の切断復帰 (Press ⏎ to Reconnect)

ttyd 1.7.4 の自動再接続は「socket が落ちたら 1 度だけ繋ぎ直す」だけで、その試行が
失敗すると WebSocket の error イベントで `doReconnect=false` になり、以後
"Press ⏎ to Reconnect" のまま二度と繋ぎ直さない。モバイルで Chrome を
バックグラウンドへ送ると、電波が戻る前に再接続を試すのでこの状態に落ちる
(実機再現で確認: close 1006 → token fetch 失敗 → connect 失敗 → 停止)。

`useTtydReconnect` が iframe 内の overlay を 1.5 秒ごとに見て、停止状態を検出したら
iframe を貼り直す (判定と抑止は `@/lib/ttyd-reconnect`)。

- **復帰手段は iframe リロード**。Enter の合成入力は、実は生きている接続に撃つと
  permission prompt や AUQ を誤って確定させるので使わない。リロードは tmux に
  1 バイトも送らない
- overlay は "Reconnected" / "Reconnecting..." / "80x24" にも使い回される。
  `/Reconnect/` で判定すると復帰直後に再リロードする無限ループになる
- **表示中のペインだけ**貼り直す。隠れた iframe を貼り直すと ttyd の `fit()` が
  サイズ 0 に対して走り、端末が歪んだままになる
- オフラインのあいだは貼り直さない (白い iframe が残るだけ)。復帰しないまま
  3 回に達したら諦め、以後は手動リロードボタンに委ねる

### AskUserQuestion (重要な実機知見)

対話版 claude は AUQ の tool_use を**回答/拒否が確定した瞬間**に tool_result と
まとめて JSONL へ書く (質問表示中は JSONL に何も出ない)。そのため:

- **質問のリアルタイム検出**: セッション起動時に `--settings` で注入する
  PreToolUse hook (`auq-hook-bridge.ts`) が tool_input.questions を
  `/api/internal/auq-event` へ POST → `session:auq` でカード表示
- **質問の文脈**: AUQ 表示中は直前の会話も JSONL に無いため、hook 受信時の
  tmux 画面を capture し verbatim でカードに添付する (「直前の画面」表示。
  解釈・パースはしない)
- **回答**: カードから tmux キー送出 (単問 single = digit 一発 / multiSelect =
  digit トグル → Right → Review digit 1 / 自由入力 = digit → literal → Enter)
- **カードを閉じる**: JSONL に解決イベントが出現したとき (`hasResolvedAuqSince`)
- permission prompt 等は AWAITING バナー (+[1][2] クイックキー + ターミナル誘導)

### 図解コメントの操作 ID（operationId）

コメントの mutation（create / reply / resolve / delete / send）はクライアント側
（transport）の ACK タイムアウトがサーバー処理を取り消さないため、再試行で
同じ操作が二重に適用されうる（#306）。そのため mutation payload には
クライアント生成の `operationId` を必須で載せ、サーバーはプロセス内 LRU
（`diagram-comment-operation-log.ts`）で適用済み ID を記録して、同じ ID の
再送は再適用せず現在の sidecar を返す。

- `operationId` は iframe のコメント層が「ユーザー操作」単位で生成し、
  タイムアウト後にユーザーが同じ操作をやり直しても同じ値を送る（成功時に破棄）
- transport は ACK が 5 秒戻らなければ同じ payload をそのまま 1 回再送する
  （合計 10 秒。iframe 側 watchdog の 15 秒より短い）
- MCP 経由（Claude の `board_reply` 等）は `operationId` 無しで呼び、冪等化しない
- 記録は sidecar に持たせない（成果物に再試行の都合を混ぜない。再起動をまたぐ
  再試行は socket も切れるため稀）
- サーバー再起動をまたぐ再試行は冪等化の対象外とする

### 図解ボード doc 本文の書き手（data-ark-author）

`type: "doc"` の本文は人間も別セッションの Claude も同じファイルを書き換える（#319）。
読み手が知りたいのは**どのブロックに人間が手を入れたか**の 1 点なので、`data-ark-id` を
持つブロック要素へ `data-ark-author="human"` を付けてそれだけを記す。
本文 HTML が正準 source なので、モデル側には持たせない。

- **Claude 側の印（`data-ark-author="claude"`）は廃止した**。文書のほぼ全ブロックに付いて
  本文より目立ち、唯一読みたい差である「人間が触った箇所」を埋めてしまうため。
  ボードにも Claude のバッジは出さない。既存文書に残る `claude` は 422 にせず受理する
  （語彙としては残すが、新規には付けない）
- 語彙は `human` / `claude` の 2 値。語彙外の値、`data-ark-id` の無い要素への付与、
  1 要素内の重複は配信（`readDiagram`）と保存（`saveDiagramEdit`）の両境界で 422
  （`diagram-doc-authorship.ts`）。無印は既存文書を壊さないよう許容する
- 人間はボード上で doc 本文を直接編集でき、編集層は人間が手を入れたブロックへ
  自動で `human` を付ける（誤字を1つ直しただけでも付く）。読み手の規則は「`human` が
  付いたブロックは人間が手を入れた本文である」に一本化し、決定かどうかは属性ではなく
  本文の記述で判断する
- 編集層が `human` を自動で付けるのは、他の `data-ark-id` を内包しない最内側の葉
  ブロックだけ（文書全体を包む容器へ丸ごと付いてしまう事故を防ぐため）。容器ブロックに
  `human` が無くても、その中身を人間が書いていないとは限らない
- `human` はサーバーで検証できない（ファイルは worktree 外から自由に書き換えられる）。
  Claude が自分で `human` を付けてよいのは、人間がコメント・会話で下した決定を転記する
  ときだけ（人間が自分で編集した分は編集層が自動で付ける）。この規約を SessionStart
  hook の context と `diagram-authoring` skill で配り、doc モードのコメント層が
  `human` の付いたブロックにだけ「人間」のバッジを出す。無印ブロックには
  著者バッジを表示しない
- 「前回開いたときから何が変わったか」の差分可視化と、複数エージェントの同時編集の
  競合（last-write-wins）は本機能の範囲外

### tmux 読み取りの結果型（TmuxReadResult）

`TmuxManager` の読み取り系（`getEnv` / `getPaneEnv` / `getBuffer` / `capturePane` /
`capturePaneVisible`）は `string | null` ではなく `TmuxReadResult<string>`
（`tmux-read-result.ts`）を返す。以前は **tmux コマンドの失敗**と**値が無いこと**を
同じ `null` に畳んでいたため、セッション消滅・復元失敗の原因が事後に追えなかった（#393）。

- `{ ok: true, value }` または `{ ok: false, failure }`。`failure.kind` は
  `no-session`（管理外 ID）/ `tmux-failed`（非 0 終了・起動失敗・timeout。`status` /
  `signal` / `code` / `stderr` を持つ）/ `not-set` / `no-buffer` / `invalid-pane-pid` /
  `proc-error` / `unsupported-platform`
- 呼び出し側は `not-set` / `unsupported-platform` / `no-buffer` を「想定内の値なし」として
  静かに扱い（`no-buffer` は `session:copy` が「バッファが空です」を返す）、それ以外は `describeTmuxReadFailure` でログに理由を残す
- 1 秒間隔の polling 経路（`getAllPreviews` / bridge-collector）は
  `TmuxReadFailureReporter` で同じ失敗を 1 度だけ出し、回復時も 1 行残す
- `getEnv` は `show-environment -t <session>` の一覧から自前で探す（変数名指定だと
  未設定時も exit 1 になり tmux 失敗と区別できない）。`getBuffer` は `show-buffer` の
  前に `list-buffers` で有無を見る（同じ理由）
- 書き込み系（`sendKeys` 等）は従来どおり throw

### ファイルペインの書き込み

PC の作業エリアの「ファイル」のタブ（`FilePane`）は worktree のファイルをツリーから
開き、CodeMirror で編集して保存できる。Claude も同じファイルを書き換えるので、
書き込みと監視には見ただけでは分からない決まりがある（`file-manager.ts` /
`file-handlers.ts` / `FileEditor.tsx`）。

- **右側は作業エリア 1 つで、「図 / ファイル」のタブで切り替える**（当初は
  左 | ファイル | 図 の 3 ペインだった）。1680px の画面で 3 つ開くと会話のペインが
  最小幅の 360px まで縮み、図とコードを並べたいのは図のリンクを踏んだ直後だけだった
- **図の中のコードリンクは「ピーク」で開く**（`FilePeek`）。`DiagramPane` が
  `ark:open-file` に `source: "board"` を付け、`Dashboard` がそれを見て、
  ファイルタブへ足さずにセッションごとの peek へ入れる。`SplitViewPane` は「図」の
  タブの本体を左右に割って図の横へ出す。
  中身はタブと同じ `FileEditor` で、編集も保存もできる。「ファイルで開く」で
  ファイルタブへ移す（未保存の編集は確認のうえ捨てる）。開けるのは 1 件だけで、
  リロードでは復元しない
- 作業エリアを閉じると `DiagramPane` は外すが、1 度見せた `FilePane` とピークは
  外さずに `hidden` で残す（外すと未保存の編集が消える）。タブを替えるだけなら
  `DiagramPane` も外さない（iframe を作り直さない）
- **ファイルの種類アイコンは material-icon-theme の一部だけを同梱する**。ファイル名・
  拡張子・フォルダ名との対応表は `lib/file-icons.ts`、SVG の束ねは遅延読み込みの
  `lib/file-icon-assets.ts`（glob のブレース内の一覧を手で持ち、対応表との一致をテストで見る）。
  表示は `FileIcon`（ツリーとタブ）。足すときは両方に同じ名前を足す

- **書けるのは worktree 内の既存ファイルだけ**。読み取りは `/tmp` 配下も通すが、
  書き込みは `/tmp` 配下と worktree の `.git/` 配下を拒否する。新規作成・削除・
  リネームは持たない。realpath を取ってから worktree 内かを確かめるので、
  worktree の外を指す symlink 経由では書けない
- **同じディレクトリの一時ファイルへ書いてから `rename` する**。直接書くと、Claude の
  Read やファイルの監視が書きかけを読みうる。mode は元のファイルのものを引き継ぐ
- **読み取り時の mtime（`expectedMtimeMs`）を保存に添え、食い違えば `conflict` で
  拒否する**。マージはしない。利用者が「上書き保存」を選んだときだけ `force: true` で
  照合を飛ばす。照合は一時ファイルを書いた後、`rename` の直前にもう一度行う
  （書いている間に Claude が書き換えた分を潰さないため）。同じファイルへの保存は
  サーバー内で直列にする
- 編集できるのは 2MB 以下の、BOM なし UTF-8 のテキストだけ（`file:open` の `editable` を
  サーバーが判定する）。それ以外は読み取り専用で開く。UTF-16 や Shift_JIS は読めた時点で
  文字が化けており、書き戻すと元の内容を壊すため
- **監視（`file:subscribe`）は、見えているタブ 1 枚にだけ張る**。全セッションの
  `SplitViewPane` は常時マウントされ、`FilePane` も 1 度見せたら閉じても外さない
  （外すと未保存の編集が消える）ので、開いているタブすべてに張るとサーバーの上限
  （1 socket あたり 50 件）を超える。隠れていたタブは、見えたときに `file:open` し直して
  ディスクと突き合わせる（未編集なら黙って読み直し、編集中ならバナー）。隠れたままの
  タブは読み込みもしない
- 自分の保存による `file:updated` もサーバーは抑止しない。クライアントが、開き直した
  結果の mtime が手元と同じなら捨てる（`decideOnDiskChange`）
- **ファイルタブは `useFileTabs` が持ち、端末のタブ列（`useViewerTabs` の `sessionTabs`）
  には載せない**。`sessionTabs` は 1 本の配列を index 1 つで指すので、隠れたタブを
  足すたびに「閉じたあとの index 補正」と「隠れタブに着地したときの空白」の特例が増える
  （図を右ペインへ移したときに 1 件増えた）。ファイルタブは id で指す別のリストにして、
  その補正を要らなくした。PC では `useViewerTabs` の `onOpenFile` へ
  `ark:open-file` の行き先を決める関数を渡し、端末・会話のリンクは
  `useFileTabs.openFile`（「ファイル」のタブ）へ、図のリンクはピークへ送る
- モバイルは `onOpenFile` を渡さないので、従来の読み取り専用のタブ
  （`file:read` → `file:content` + `FileViewerPane`）のまま動く
- 行指定つきのリンク（`README.md#L10`）で開いた Markdown は、プレビューではなく
  編集で出す（プレビューでは行を示せない）

### キーボード操作（ノーマルモード）

PC では、vim のように「入力モード」と「ノーマルモード」を分けてキーで Ark を動かせる
（`KeyNavLayer` / `lib/keynav.ts` / `lib/keynav-dom.ts`）。キーの一覧は `?` で出る
（正本は `KEYNAV_HELP`）。

- **入口は前置キー `Ctrl+;`**。vim の Esc にしないのは、会話の入力欄の Esc を Claude 本体と
  同じ動き（中断など）に割り当て済みで、端末でも Esc は Claude に届ける必要があるため。
  ノーマルモードでは `i` でも入力へ戻る
- **端末の中からも前置キーが効く**。ttyd の iframe は別のブラウジングコンテキストなので、
  端末にフォーカスがある間のキーは親に届かない。ttyd は同じ出どころなので、iframe の
  document に捕捉段階のリスナーを付け、前置キーだけを横取りする（`useTerminalLeaderKey`。
  ほかのキーには触らない）
- **図の中からは、図に載せた層が前置キーを知らせる**（`diagram-keynav-layer.ts`）。図の
  iframe は sandbox で出どころが違い、親は中の document に触れない。サーバーが図へ
  注入する層が前置キーだけを横取りして port で親へ送り、`DiagramPane` が端末と同じ
  合図（`ark:keynav-leader`）に直す。ノーマルモードは作業エリアから始まる。
  図を `j` / `k` で送るときは逆向きで、`keynav-dom` が見えている図の iframe へ合図を投げ、
  `DiagramPane` が port で中へ渡して層が `scrollBy` する
- ノーマルモードに入るとき、フォーカスを iframe や入力欄から見えない受け皿へ移す
  （iframe に残るとキーが親に届かない）。入力欄や端末をクリックしたら入力モードに戻す
- **指示は「マウスで押すもの」をそのまま押して実行する**（行をクリックする、タブを
  クリックする、ツリーやコミット一覧へ矢印キーを送る）。Dashboard や SplitViewPane へ
  指示ごとの口を足さず、マウスで出来ることとキーで出来ることを食い違わせない。
  全セッションぶんのペインが常時マウントされているので、要素は必ず「見えているもの」
  （`hidden` の祖先を持たないもの）から探す
- Enter・Tab・矢印はノーマルモードでも横取りしない（フォーカスのある行やボタンが自分で動く）。
  文字のキーは割り当てが無くても受け取る（入力もページ内検索もさせない）。ダイアログや
  メニューが開いている間は何もしない

### コマンドパレット

ノーマルモードの `:` で、名前で探して実行するパレットが開く（`CommandPalette` /
`lib/palette.ts`）。候補はセッション・図・ファイル・コマンドで、最後に、打った文を
裏の Claude に聞く行を置く（`Tab` で直接聞く。何も一致しなければ `Enter` がこれになる。
下記「Claude に聞く」）。

- **入口は `:` だけ**。入力モードから直接開くキーは足さない（端末の Claude に届かない
  キーを増やさない）。端末からは `Ctrl+;` → `:` の 2 打
- **ファイルは一覧を 1 回取って、手元で絞り込む**。パレットを開くたびに `file:index` で
  その worktree の全パスを取る（`git ls-files --cached --others --exclude-standard`。
  gitignore 対象は含まない。5 万件まで）。打つたびにサーバーへ問い合わせない
- **場所やタブを替えるコマンドは、パレットが実行せず KeyNavLayer へ返す**
  （`ark:palette-closed` の `command`）。パレットが自分で DOM を押すと、KeyNavLayer が
  覚えている「いる場所」と食い違う。閉じたあとのフォーカスも KeyNavLayer が置き直す
- パレットの入力欄は `data-keynav-ignore` を持つ。持たないと、入力欄へのフォーカスを
  KeyNavLayer が「入力モードへ戻る合図」と読む
- **開く先のセッションは、パレットを開いた時点のものに固定する**（ファイルと図の一覧は
  その worktree のもの。開いている間に選択が替わっても、別の worktree で開かない）
- **取り消せない操作（停止・削除・再起動）は載せない**。打ち間違いの `Enter` で消えるため。
  起動していない worktree も載せない（選ぶと起動が走る）

### Claude に聞く（裏の Claude）

コマンドパレットで打った文を `Tab` で「聞く」と、表のセッションとは別の、裏で動く専用の
Claude が答え、浮かぶウィンドウ（`AskWindow`）に出る（`ask-manager.ts` / `useAsk`）。
表のセッションへは何も送らない（進行中の会話に割り込まない）。

- **裏の Claude も tmux 上の対話版 claude**（プラン枠のまま。Agent SDK / `claude -p` は
  使わない）。サイドバーに出ないセッションを 1 つだけ持つ。tmux のセッション名は
  `arkask-<session-id>` で、`ark-` で始めないのでサーバー起動時の復元の対象にならない
- **動かす場所は Ark 専用の空のフォルダ**（`~/.local/share/ark/ask`。`ARK_ASK_DIR` で
  替えられる）。表のセッションと同じフォルダで動かすと、会話ビューが「そのフォルダで
  一番新しい JSONL」として裏の会話を拾う。`data/` の下でも動かさない（リポジトリの中
  なので、その CLAUDE.md と設定を読み込む）
- **道具は持たせない**（`--tools ""` と `--strict-mcp-config`）。ファイルを読まず、何も
  書き換えず、コマンドも実行しない。許可の確認が出ないので、答える人がいなくても
  止まらない。`--tools ""` だけだと、利用者が設定している MCP サーバーの道具が残る
- **claude は `exec` で起動する**。シェルを残すと、claude が終わったあとに聞いた文が
  シェルのコマンドとして実行される。`exec` なら claude と一緒に tmux セッションが終わり、
  次に聞いたときに作り直す
- **答えは `--session-id` で決めた JSONL から読む**（「一番新しいファイル」を探さない）。
  人の発話と Claude の text だけを取り出し、`stop_reason: "end_turn"` でターンの終わりを知る。
  対話版は答えを書き終えてから JSONL に出すので、書かれるそばからは出せない
- **フォルダの信頼の確認には、裏で「はい」と答える**。新しいフォルダでは claude が
  起動時に確認を出し、既定は「いいえ」。Ark が作った空のフォルダで道具も無いので、
  その画面が出ている間だけ `Down` → `Enter` を送る。画面は「確認が出ているか」
  「入力欄が出たか」の有無だけを見る（内容は読まない）
- **`--settings` は付けない**。Ark の hook（AUQ・ボード提案の Stop hook）を裏の会話に
  効かせない。利用者自身の `~/.claude` の設定は効く
- 会話はサーバーが持ち、変わるたびに `ask:state` で丸ごと配る。サーバーを再起動しても、
  残っている tmux セッションの名前から session-id を取り、同じ JSONL を読み直す。
  「新しく聞く」はセッションを終わらせる（次に聞いたときに作り直す）
- ウィンドウはダイアログにしない（後ろの画面もノーマルモードのキーも止めない）

### 図の一覧

図のタブは「図の一覧」と「図」の 2 つの画面を行き来する（`DiagramSwitcher` /
`lib/diagram-browser.ts`）。Finder のように、一覧で図を開くと図の画面へ替わり、上のバーの
「戻る」で一覧へ、「進む」で開いていた図へ移る。一覧はリスト表示で、名前・種類・
更新日時の列を持つ（以前はプルダウン 1 本で、名前しか見えず、どれが新しい図かも
分からなかった）。

- 一覧の画面は図の上に重ねて描く。図の iframe を外さないので、戻ってきたときに
  作り直しにならない

- **既定は更新の新しい順**（いま描いた図が先頭に来る）。列の見出しで並べ替え、選んだ
  並びは localStorage に覚える。上の欄で名前とパスを絞り込む
- 種類と更新日時は `diagram:list` が返す（`kind` / `mtimeMs`）。種類は「デッキ / 文書 /
  シーケンス / 呼び出し / 図」で、graph の図種と `type` の無い図は「図」にまとめる
- **見せる図が替わったら図の画面へ移る**（復元や Claude の `board_open` で図が開いたのに、
  一覧の画面のままにしない）。図をまだ選んでいないときは、一覧の画面から始める
- 一覧は `role="listbox"` で、矢印・Home / End・PageUp / PageDown・Enter で動く。
  ノーマルモードの `j` / `k` / `gg` / `G` は、一覧が開いている間は図ではなく一覧へ届く
- 削除は行ごとのボタンから（確認のダイアログを挟む）

### Git タブ

PC の作業エリアの「Git」のタブ（`GitPane`）は、セッションの worktree のコミットグラフ・
ref・差分・未コミットの変更を見せる。手本は Fork のメイン画面で、ファーストビューは
コミット一覧（`components/git/` / `git-view.ts` / `git-view-handlers.ts`）。

- **いまは見るだけ**。ステージ・コミット・破棄・チェックアウト・fetch / pull / push は
  持たない。破棄やチェックアウトは取り消せず、確認の設計が要るので、見た目と閲覧を
  先に実機で固める
- **対象の worktree は `sessionId` からサーバーが引く**（クライアントのパスは信用しない）。
  `sha` は 16 進 7〜40 桁だけ、`path` は `..` を含まない相対パスだけを通し、パスは必ず
  `--` の後ろに置く
- **git は必ず `--no-optional-locks` で呼ぶ**。付けないと `git status` が index を
  更新しようとして `index.lock` を取り、同じ worktree で動いている Claude の git 操作と
  取り合う
- **追従は指紋のポーリングで、見えている間だけ**。`GitPane` は 3 秒ごとに
  `git:fingerprint` を問い合わせ、変わったときだけ
  refs・status・コミットを読み直す（読み込み済みの件数ぶん。上限 3,000 件）。
  指紋はHEAD・いまのブランチ（`symbolic-ref`）・ref・statusに、indexのblob
  （`diff --cached --raw` / `diff --raw`）と、作業ツリー側が変わっているパス・未追跡の
  パスの `lstat`（mtimeと大きさ。2,000パスまで）を混ぜたハッシュ。statusの出力だけだと、
  変更済みのファイルの再編集・ステージし直し・同じコミットを指す別ブランチへの切り替えで
  変わらず、画面が古いままになる。
  `SplitViewPane` は全セッションぶんが常時マウントされ、`GitPane` も 1 度見せたら
  外さないので、隠れている間も問い合わせると全セッションぶんの git が回り続ける。
  見えた瞬間には 1 回問い合わせる
- 読み込みには通し番号を振り、あとから始めた読み込みだけが state を書ける
  （遅れて届いた古い応答で新しい一覧を上書きしない）。指紋の問い合わせは重ねない。
  読み直しに失敗したら覚えている指紋を捨て、次の問い合わせで必ず読み直す
- **続きの読み込みが失敗したら、自動では頼み直さない**。末尾が見えたままだと失敗のたびに
  頼み直し続けるので、一覧の末尾に「再試行」の行を出して止める
- **競合中（unmerged）のパスは未ステージに1回だけ `U` で出す**。indexにステージ0が
  無いので、差分はours（ステージ2。無ければbaseのステージ1）と作業ツリーの差にする
- **作業ツリーのシンボリックリンクはたどらず、行き先の文字列を内容にする**
  （indexのblobと同じ形。境界は親ディレクトリの実体で確かめる）
- **詳細のrefの札は、読み直した一覧から渡す**。コミットの応答はshaごとに持ち続けるので、
  応答のrefは新しいコミットが積まれると古くなる。一覧に無いコミットだけ応答のrefを出す
- **マージコミットの差分は第 1 親との差**（`<sha>^1`。ルートコミットは空との差）。
  combined diff は「そのブランチを取り込んで何が入ったか」を示さないため
- **グラフの割り当ては「第 1 親は必ず自分の列で受ける」**（`lib/git-graph.ts`）。
  別の列が同じ親を待っていても寄せない（寄せると本線が枝の列へ飛ぶ）。同じ親を待つ列は
  親の行で合流する。読み込みが途中で切れていても、親が未読の列は下へ伸ばしたままにする
- **未コミットの変更は「HEAD を親に持つ仮のコミット」として割り当てる**
  （`lib/git-graph-rows.ts`）。HEAD が一覧の先頭に無くても線がつながる。変更が無いときも
  仮の行を足して割り当て、その線だけを外す（足したり足さなかったりすると、作業ツリーが
  汚れる / 片付くたびに全レーンの列と色がずれ、Claude の作業中にグラフがちらつく）
- 一覧の行は固定高（28px）で、見えている範囲だけを描く。グラフは行ごとの SVG を
  上端から下端まで描いて継ぐ。レーンの色（8 色）と差分の地色は `index.css` の
  `--git-*` に明暗それぞれの値で持つ
- 差分は `@codemirror/merge` の `unifiedMergeView`（`GitDiffView`。読み取り専用）で、
  テーマと構文の色は `lib/codemirror-theme.ts` を `CodeEditor` と共有する。
  `GitDiffView` は `React.lazy` で読み、`@codemirror/merge` を初期バンドルに入れない
- 自動で「Git」へ替えることは無い。差分の
  「ファイルで開く」は `ark:open-file` を投げるので、「ファイル」のタブへ替わる

### ボード提案 (Jev 判定)

長い説明をチャットで読む負担を減らすため、Claude が返答を終えるたびに Stop hook
(`auq-hook-bridge.ts` が `--settings` で注入) から Ark へ問い合わせ、直前のターンの本文を
Jev に判定させる。図解すべきなら hook が `{ decision: "block", reason }` を返し、Claude は
止まらずにその返答をデッキにして `board_open` で開く (`board-suggest-stop-hook.ts` / `jev-client.ts`)。

- **図を描くのは Claude だけ**。以前は返答の markdown を doc 型ボードへ機械変換していたが、
  チャットと同じ文章が別のペインに出るだけで読み手には何も足さなかったので撤去した
- **tmux には何も送らない**。send-keys で作図を頼むと端末で入力中の下書きを C-u で消しうる
  (bridgeStatus は入力中を IDLE と報告する)。Stop hook の block なら入力欄に触れない。
  block の指示は transcript に isMeta の user 行として残り、会話ビューでは折りたたんだ
  システムの行になる
- Claude への入力に足すのは「外部の分類器がこの返答を図にすべきと判定した」ことだけで、
  SessionStart hook の作図規約を読み上げ直すものではない。実測では規約だけだと、1,500 文字を
  超える返答で Claude が自分で `board_open` したのは直近 14 日の 192 件中 17 件だった
- **Jev は生成しない分類器**。noul「ボードのほうが読みやすいか」を 1 問だけ問い、確率だけが
  返る (1 回 200〜400ms、入力 100 万トークン $0.042)。本文は末尾 6,000 文字だけ送り、
  `provider.data_collection: "deny"` を付ける
- ターンの本文は hook の `transcript_path` の末尾 4MB から組み立てる (最後の人の発話より後の
  text block を連結。tool_result と isMeta の user 行では区切らない)。読めなければ
  `last_assistant_message` で判定する
- **Stop hook が効くのは、Ark がこの版になってから claude を起動したセッションだけ**。
  claude は `--settings` のファイルを起動時に読むだけで、書き換えても読み直さない (実機で確認)。
  それより前から動いているセッションでは、claude を起動し直すまでボード提案が動かない
- hook の受け口は長い返答を載せてくるので、全体の `express.json({ limit: "10kb" })` から外し、
  token を確かめてから 4mb の parser を当てる
- block しない条件: `stop_hook_active` (block で続けたターンの終わり。無限ループ防止)・
  そのターンで既に `board_open` した・無効・鍵なし・Jev の失敗・閾値未満。hook の curl は
  `-f -m 10` で、失敗や timeout は何も出さずに止まらせる
- 設定は Ark メニュー (PC) / セッション一覧のスライダーアイコン (モバイル) の
  「ボード提案の設定」ダイアログで変える (`board-suggest-config.ts`)。有効
  `board_suggest_enabled`・閾値 `board_suggest_threshold` (既定 0.7。0.5 付近は
  「分からない」)・鍵 `board_suggest_api_key` を settings に保存し、次のターンから効く。
  鍵の優先順は 設定画面 > `OPENROUTER_API_KEY` > `~/.config/openrouter/api-key`。
  鍵と `auq_hook_token` は `/api/settings` に載せず (`isSecretSettingKey`)、
  `board-suggest:get` は末尾 4 文字だけ返す。`ARK_FEATURE_BOARD_SUGGEST=false` で
  機能ごと止められる。Jev の失敗はセッションごとに 1 回だけログに出す
- Decisions API は alpha (`/api/alpha/decisions`) なので endpoint と model は
  `jev-client.ts` の定数に閉じ込めてある

### コンテキスト機構は持たない

Ark はセッションに **task.md 規約・復唱・失敗の記録・知識の配布のいずれも注入しない**。
セッションが受け取るのは、Claude Code が標準で与えるものと、リポジトリ自身の
`CLAUDE.md` / `.claude/` だけである。

作業の記憶や横断知識が欲しい場合は、**利用者自身の設定**（`~/.claude/CLAUDE.md`、
native auto memory 等）で行う。Ark はそこに関与しない。

#### なぜ持たないのか（#367 / #401）

task.md 規約・復唱・失敗の自動収集・セッション lifecycle を持つ 10,350 行の機構
（`ark/context`）を運用し、実 Issue を 2 群に並行で解かせる対照実験を 6 回行った。

結論は **足していたものが機構ではなく「既にある機構のこだま」だった**こと。

| Manus の主張 | 既にあった忠実な機構 | 足していたもの |
|---|---|---|
| 失敗をコンテキストに残す | 失敗した `tool_result` は原文のまま窓に残る | `errors/raw.log` への写しと「読みに行け」 |
| 復唱で注意を操作する | エージェント自身が task.md を書き換える規約 | hook が読み上げる `additionalContext` |

復唱の対照実験（4 回・1 勝 1 分 2 敗）で群間を動かしていたのは **hook だけ**で、
「エージェント自身が書く」規約は両群に残っていた。つまり測れたのは
「エージェント自身の復唱があるとき、こだまは何も足さない」であり、
忠実な機構そのものの効果は測れていない。

機構自体が「実装済みなのに発火しない / 無音で止まる」不具合を 10 件生んだ
（#350 #352 #357 #365 #369 #372 #373 #383 #397）。うち 9 件は配達装置の中にあった。

同種の機構は 4 代目まで作って 4 代目とも撤去している
（Frontline 8,108 / Beacon 10,016 / flow 8,845 / ark/context 10,350 行）。
**5 代目を作る前に `.claude/rules/context-engineering.md` を読むこと。**

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
| チャットビュー           | JSONL tail ベースの会話描画 + pending reconcile + AskUserQuestion カード + slash 補完 + busy/AWAITING 表示（PC は `SplitViewPane` の左ペイン、モバイルは `MobileSessionView`。どちらも🖥/💬トグルで ttyd 表示と切替） |
| 音声モード（iPhone）   | 会話モードの1タップ操作から全画面の音声モードに入る。話した指示を2秒の取り消し猶予つきで送り、Claude がターンを終えた返答（JSONL の `stop_reason: "end_turn"`）を読み上げる。質問・権限確認は読み上げて画面での操作に回す。ブラウザ内蔵の音声認識・読み上げだけを使い、画面を点けて前面に出している間だけ動く |
| セッションボード       | worktree の `.claude/diagrams/*.diagram.html`（意味モデル + HTML 投影）を表示する図解ペイン（右ペインタブ・PC のみ）。Claude が MCP ツール `board_open` で開き、ファイル更新を検知して自動再読込する。doc 型は本文を人間がその場で直接編集でき、変更をブロック単位で会話へ還流する。本文の `<a href="src/foo.ts#L10">` はファイルビューアで該当行を開く。変更レビュー向けに `sequence`（時間順のやり取り）と `call-tree`（呼び出し経路と差分量）の内蔵図種があり、モデルだけ書けば投影が出る（`diagram-static-builtin.ts`）。デッキ（`type: "deck"`）は 1 ファイルに `blocks`（見出しと、カード・チップ・表など決まった部品の並び。`diagram-deck-blocks.ts`）/ `sequence` / `call-tree` のページを並べ、全ページを積んで見せる（既定）か 1 枚ずつめくらせる（`diagram-deck.ts`。graph の図種と doc はページにできない）。デッキに書くのはモデルの JSON だけで、見た目は Ark が描いて明暗に追従する。自由形の `html` ページは古い形で、図の切り替えからは今までどおり開けるが、`board_open` は拒否する（書く側のモデルごとに見た目がぶれるため。絵が要るときは `type` の無い 1 枚の図を別のファイルに描く）。積んで見せるときは、点の地のキャンバスにページをカードとして互い違いに置く（位置は持たない。ドラッグも保存も無い）。込み入った説明は、頼まれなくても作図規約の「説明図（デッキ）」で 1 ページに 1 つのことを置くデッキを描いて開く（SessionStart hook で伝え、「会話を図解」ボタンも同じ依頼を送る） |
| ボード提案 (Jev)       | Claude が返答を終えるたびに (Stop hook) Jev (TypeSafe の決定モデル、OpenRouter 経由) へ「チャットよりボードのほうが読みやすいか」を問い、閾値以上なら hook の block で Claude にその返答をデッキへ図解させてボードに開かせる。tmux には何も送らない。鍵は「ボード提案の設定」ダイアログから入れる (環境変数 / `~/.config/openrouter/api-key` でも可)。無ければ待機 |
| Webターミナル          | ttyd iframeによるフルターミナル体験（PC は左ペインの既定、モバイルは🖥/💬トグルでチャットビューと切替） |
| マルチペインビュー     | 複数セッションの同時表示（1列 / 2x2グリッド切り替え）                       |
| モバイル対応           | セッション一覧/詳細の画面遷移、Quick Keys、スクロールモード、キーボード対応 |
| 特殊キー送信           | Enter, Ctrl+C, Ctrl+D, y, n, S-Tab, Escape, スクロール等                    |
| ファイルアップロード   | D&D・ファイル選択・クリップボード貼り付けで画像/PDF/テキスト/Excelを送信（`@パス` 形式） |
| ファイルペイン         | worktree のファイルを見て直すペイン（PC のみ。右の作業エリアの「ファイル」のタブで、「図」と切り替える）。ツリー（gitignore 対象は隠し、git の変更の印を出す）とタブで開き、CodeMirror で編集して Ctrl+S / Cmd+S で保存する。Claude がファイルを書き換えたら自動で読み直し、編集中に書き換えられたらバナーで「再読込」「上書き保存」を選ばせる。会話・端末のリンクからも開く。ボードの中のコードリンクは、図を見たまま横の「ピーク」で開き、そこから「ファイル」のタブへ移せる。モバイルは従来の読み取り専用のタブのまま |
| Git タブ               | worktree のコミットグラフと差分を見るペイン（PC のみ。右の作業エリアの「Git」のタブ。読み取りだけ）。左にサイドバー（変更 / ブランチ / リモート / タグ / スタッシュ）、右上に色分けしたグラフと ref の札つきのコミット一覧、右下に選んだコミットの詳細（コミットの情報 / 変更されたファイル / unified の差分）。先頭の行で未コミットの変更（ステージ済み / 変更 / 未追跡）も見られる。見えている間は 3 秒ごとに追従し、Claude がコミットすると一覧が更新される |
| キーボード操作         | PC で、前置キー `Ctrl+;` からノーマルモードに入り、1 文字のキーで動かす（`i` で入力へ戻る）。`h` / `l` でサイドバー・左のパネル・作業エリアを移り、`j` / `k` でセッション・ツリー・コミット・会話・図を動く。`J` / `K` でセッションの前後、`n` で次の「あなたの番」、`t` で端末と会話、`p` で作業エリア、`gd` / `gf` / `gs` でタブ、`?` で一覧。端末と図の中からも前置キーが効く |
| コマンドパレット       | PC で、ノーマルモードの `:` から開く。セッション・図・ファイル（worktree 内を名前で）・コマンドを1つの入力欄で絞り込み、`Enter` で開く / 実行する。取り消せない操作は載せない |
| Claude に聞く          | PC で、コマンドパレットに打った文を `Tab` で聞くと、表のセッションとは別の裏の Claude（道具なし。ファイルは読まない）が答え、浮かぶウィンドウに出る。ウィンドウの中で続けて聞ける。表のセッションの会話には入らない |
| tmuxバッファコピー     | tmuxのペーストバッファをクリップボードにコピー                              |
| ポートスキャン         | リッスン中のポートを一覧表示（ttydポートは除外）                            |
| リモートアクセス       | Cloudflare Tunnel（Quick / Named）+ QRコード + トークン認証                 |
| セッション永続化       | SQLite + tmux永続化によるサーバー再起動後の自動復元                         |
| IME対応                | 日本語入力時のcompositionイベント処理                                       |
| パーミッションスキップ | `--skip-permissions` フラグでClaude CLIの権限確認をスキップ                 |
| プロファイル切替（Linux限定） | リポジトリ単位で別々の `CLAUDE_CONFIG_DIR` を使用。認証は通常セッション内で `claude /login` 実行 |
| リモート画面           | SSH で届くホストの VNC 画面 (macOS の画面共有など) を noVNC で全面表示する。サイドバーの画面メニュー (PC) / 下部タブ「画面」(モバイル) から開く。設定は SQLite の `screens`、WebSocket は Ark サーバ内で `ssh -W` に直結する (`screen-bridge.ts`。websockify もローカルポートも使わない)。ARD 認証に WebCrypto を使うため localhost か HTTPS でだけ繋がる |

## Git・PRワークフロー

- **実装完了後はユーザーに確認せず即pushすること**（「pushしますか？」と聞かない）
- **`resolveReviewThread` で勝手にresolveしてはならない**（resolveはユーザーが判断）
- **CodeRabbitのコメントには対応済み・不要問わず必ず返信すること**
- **「次回対応」「今後改善」等の先送り返信は禁止**。このPRで対応するか、対応しない場合はGitHub Issueを作成してから返信すること
- **CodeRabbitの新規指摘判定は `created_at` のタイムスタンプでフィルタする**（`commit_id == HEAD` フィルタを使ってはならない。fixコミット後にHEADが変わると、前コミットへの指摘が全て見落とされる）
- **CodeRabbitへの返信は修正コミット → push → 返信の順で行う**（push前に返信するとCodeRabbitが修正コードを確認できない）
- **テスト失敗時に `--no-verify` でhookバイパスを提案してはならない**。エラーログを確認し根本原因を修正すること
- **ローカルとリモートのブランチ名は必ず一致させる**（異なる名前でpushすると `gh pr view` がPRを検出できず、CI監視・CodeRabbit取得が全て失敗する）
- **CodeRabbitのstatusが `error`（処理中）の場合、CIが成功していても監視を停止してはならない**。`completed` かつ未解決スレッド0件を確認してから停止する
- **git push は必ずフォアグラウンドで実行する**（バックグラウンド実行するとpush完了前にCodeRabbit返信が送信されてしまう）
- **CodeRabbitの1コメントに複数の修正ポイントが含まれる場合がある**。対応前に全ポイントを箇条書きにしてから実装に入ること
- **コミット前に現在のブランチを確認する。** 意図したfeatureブランチにいることを検証してからコミットすること。mainや無関係なブランチへの誤コミットを防ぐ
- **セルフレビュー禁止・成果物は必ず「作った側と別の AI」がレビューする**。自分が実装した成果物を自分でレビューしてはならない。Claude が実装した場合のレビューは `/codex review`（Codex CLI）へ委任し、codex が実装した場合は Claude がレビューする
- **push 後の CI 結果と CodeRabbit の指摘は自分で確認する**（自動取得の hook は撤去済み。`gh pr view <PR#> --json statusCheckRollup` 等で確認する）
- **CI 失敗は自分で修正する。** エラーログを読み根本原因を直す
- **CodeRabbit の指摘も自分で対応する**（上記の返信規約に従う）。ただし**設計方針の変更を伴う指摘だけはユーザーに判断を仰ぐ**

## デプロイ手順

mainブランチをpullした後は、以下の手順で **順番通りに** ビルド・再起動する：

```bash
# 1. 依存関係をインストール
#    毎日の bump-claude-code ワークフローによる同梱 @anthropic-ai/claude-code の
#    更新は install で初めて node_modules に反映される。省略すると稼働中の Ark が
#    旧バージョンの claude を配り続ける
#
#    pnpm 11 が要る (.mise.toml / packageManager が 11 系を指す)。mise が古いと
#    `no asset found: pnpm-linux-arm64` で pnpm 自体が入らず、この行が失敗する。
#    その場合は `mise self-update` するか、corepack 経由に切り替える:
#      corepack pnpm install --frozen-lockfile
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
- **単一ユーザー前提**: 認証はアプリ全体に対する単一の関門であり、**セッション単位の閲覧権限は無い**。認証を通過したクライアントは任意のセッションの会話履歴・ライブ端末・キー送出に到達できる。Ark は 1 人のユーザーが自分のセッション群を管理するツールであり、**複数人で共有する構成（Named Tunnel + Cloudflare Access でチームに公開する等）は想定しない**。所有者モデルや経路ごとの権限判定を足す計画は無い（#296 で判断）

### トンネル自動復旧

サーバー再起動時、前回トンネルが有効だった場合は自動的に再起動する（`/tmp/ark-tunnel-state.json` で状態管理）

### 関連ファイル

```
packages/server/src/lib/
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
├── packages/
│   ├── server/
│   │   ├── src/
│   │   │   ├── cli.ts
│   │   │   ├── index.ts
│   │   │   └── lib/
│   │   │       ├── session-orchestrator.ts
│   │   │       ├── tmux-manager.ts
│   │   │       ├── ttyd-manager.ts
│   │   │       └── database.ts
│   │   ├── build.mjs
│   │   └── ecosystem.config.cjs
│   ├── shared/
│   │   └── src/
│   │       ├── types.ts
│   │       └── file-paths.ts
│   ├── web/
│   │   └── src/
│   │       ├── components/
│   │       ├── hooks/
│   │       └── pages/
│   └── desktop/
│       ├── src/
│       │   ├── main.ts
│       │   └── preload.ts
│       └── electron-builder.yml
├── data/
│   └── sessions.db
├── package.json
└── pnpm-workspace.yaml
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
| `voice:diagnostic` | `{ sessionId, kind, detail }`           | 音声モードの診断。サーバーのログに1行出すだけ（本文は送らない） |
| `diagram:comments:get` | `{ sessionId, relPath }, callback`  | 図のコメント sidecar を取得（コールバック） |
| `diagram:comment:create` | `{ sessionId, relPath, operationId, anchorId, body, anchorQuote?, anchorOccurrence? }, callback` | コメント thread 作成 |
| `diagram:comment:reply` | `{ sessionId, relPath, operationId, threadId, body }, callback` | thread へ返信 |
| `diagram:comment:resolve` | `{ sessionId, relPath, operationId, threadId }, callback` | thread を解決済みにする |
| `diagram:comment:delete` | `{ sessionId, relPath, operationId, threadId }, callback` | thread を削除 |
| `diagram:comment:send` | `{ sessionId, relPath, operationId, threadId }, callback` | thread の内容を会話セッションへ送る |
| `diagram:subscribe` | `{ worktreePath, relPath }`           | 図ファイルの更新監視を開始（1セッション1図を想定） |
| `diagram:unsubscribe` | `{ worktreePath, relPath }`         | 図ファイルの更新監視を解除                       |
| `slash:list`      | `sessionId, callback`                   | slash command 候補一覧（コールバック）|
| `board-suggest:get` | `callback`                            | ボード提案の設定を取得（鍵は末尾 4 文字だけ。コールバック）|
| `board-suggest:set` | `{ enabled?, threshold?, apiKey? }, callback` | ボード提案の設定を変更（`apiKey: null` で設定側の鍵を削除。コールバック）|
| `tunnel:start`    | `{ port? }`                             | Quick Tunnel起動                 |
| `tunnel:stop`     | -                                       | トンネル停止                     |
| `ports:scan`      | -                                       | ポートスキャン                   |
| `file-upload:upload` | `{ sessionId, base64Data, mimeType, originalFilename?, requestId }` | ファイルアップロード |
| `file:open`       | `{ sessionId, filePath }, callback`     | ファイルを開く（コールバック。`{ ok: true, content, mimeType, size, mtimeMs, editable }` / `{ ok: false, error }`）|
| `file:list`       | `{ sessionId, dirPath }, callback`      | ディレクトリを 1 階層一覧する（コールバック。`{ ok: true, entries, truncated }` / `{ ok: false, error }`）|
| `ask:get`         | `callback`                              | 裏の Claude との会話のいまの状態（コールバック。`{ messages, busy, error }`）|
| `ask:send`        | `{ text }, callback`                    | 裏の Claude に聞く（8,000 文字まで。答えは `ask:state` で届く。コールバック。`{ ok: true }` / `{ ok: false, error }`）|
| `ask:reset`       | `callback`                              | 裏の Claude との会話をまっさらにする（コールバック）|
| `file:index`      | `{ sessionId }, callback`               | worktree 内の全ファイルのパス（gitignore 対象は除く。5 万件まで。コマンドパレットが名前で探すための一覧。コールバック。`{ ok: true, paths, truncated }` / `{ ok: false, error }`）|
| `file:write`      | `{ sessionId, filePath, content, expectedMtimeMs, force? }, callback` | worktree 内の既存ファイルを書き換える（コールバック。`{ ok: true, mtimeMs }` / `{ ok: false, code: "conflict" \| "error", error, mtimeMs? }`）|
| `file:subscribe`  | `{ sessionId, filePath }`               | ファイルの更新監視を開始（見えているタブ 1 枚だけ。1 socket あたり 50 件まで）|
| `file:unsubscribe` | `{ sessionId, filePath }`              | ファイルの更新監視を解除         |
| `git:log`         | `{ sessionId, skip, limit }, callback`  | コミット一覧（全ブランチ・新しい順。`limit` は最大 500。コールバック。`{ ok: true, commits, hasMore }` / `{ ok: false, error }`）|
| `git:refs`        | `{ sessionId }, callback`               | HEAD・ブランチ（ahead / behind つき）・リモート・タグ・スタッシュ（コールバック）|
| `git:status`      | `{ sessionId }, callback`               | 未コミットの変更（コールバック。`{ ok: true, staged, unstaged, untracked }`）|
| `git:commit`      | `{ sessionId, sha }, callback`          | コミットの詳細と変更されたファイル（コールバック。`{ ok: true, commit, files }`）|
| `git:file-diff`   | `{ sessionId, target, path, oldPath? }, callback` | 1 ファイルの変更前後の内容（`target` は `commit` / `staged` / `unstaged` / `untracked`。コールバック。`{ ok: true, oldContent, newContent, binary, tooLarge }`）|
| `git:fingerprint` | `{ sessionId }, callback`               | HEAD・ブランチ・ref・status・indexのblob・変更中のファイルのmtimeと大きさのハッシュ（コールバック。変わったら読み直す）|
| `profile:list`    | -                                       | プロファイル一覧取得（Linux限定） |
| `profile:create`  | `{ name, configDir }`                   | プロファイル作成 |
| `profile:update`  | `{ id, name?, configDir? }`             | プロファイル更新 |
| `profile:delete`  | `{ id }`                                | プロファイル削除（CASCADEで紐付けも削除） |
| `repo:set-profile` | `{ repoPath, profileId \| null }` | リポジトリにプロファイルを紐付け（nullで解除） |
| `session:restart-with-profile` | `{ sessionId }`            | セッションをkill→新envで再起動 |
| `screen:list`     | -                                       | リモート画面一覧取得 |
| `screen:create`   | `ScreenInput`                           | リモート画面作成 |
| `screen:update`   | `{ id, ...ScreenPatch }`                | リモート画面更新 (`vncPassword` は指定時のみ) |
| `screen:delete`   | `{ id }`                                | リモート画面削除 |
| `screen:credentials` | `id, callback`                       | VNC の認証情報 (コールバック。一覧には載せない) |

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
| `ask:state`              | `{ messages, busy, error }`    | 裏の Claude との会話が変わった（全クライアントへ配る）|
| `file:updated`           | `{ sessionId, filePath }`      | 監視中のファイルが更新された。クライアントは開き直して突き合わせる |
| `system:capabilities`    | `{ multiProfileSupported }`               | 機能フラグ（接続時に1回emit） |
| `profile:list`           | `Profile[]`                        | プロファイル一覧 |
| `profile:created`        | `Profile`                          | プロファイル作成完了 |
| `profile:updated`        | `Profile`                          | プロファイル更新完了 |
| `profile:deleted`        | `{ id }`                                  | プロファイル削除完了 |
| `profile:error`          | `{ message, code? }`                      | プロファイル操作エラー |
| `repo:profile-changed`   | `{ repoPath, profileId \| null }`  | 紐付け変更通知（バッジ更新用） |
| `screen:list`            | `Screen[]`                     | リモート画面一覧 (接続時にも送る。パスワードは含まない) |
| `screen:created` / `screen:updated` | `Screen`            | リモート画面の作成・更新完了 |
| `screen:deleted`         | `{ id }`                       | リモート画面削除完了 |
| `screen:error`           | `{ message, code? }`           | リモート画面エラー |

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
| -                       | `OPENROUTER_API_KEY`    | ボード提案 (Jev) の API キー。設定画面の鍵が優先、無ければこれ、次に `~/.config/openrouter/api-key`。どれも無ければ判定しない |
| -                       | `ARK_FEATURE_BOARD_SUGGEST` | `false` でボード提案を止める |

---

## 前提条件

以下がインストールされている必要がある：

- **Node.js** >= 22.12.0（同梱 Claude Code 2.1.207 + Vite 8 の要件）
- **pnpm**
- **tmux**
- **ttyd**
- **jq**
- **cloudflared**（リモートアクセス使用時のみ）
- **ssh**（リモート画面使用時のみ）

### リモート画面 (ssh) の前提

ブリッジは Ark サーバーを動かしているユーザーの権限で `ssh -o BatchMode=yes -W` を起動する。
`BatchMode=yes` は一切のプロンプトを出せないので、次を満たしていないと接続できない。

- **鍵は Ark サーバーの実行ユーザーのもので、パスフレーズ無し** (または ssh-agent に登録済み)。
  パスフレーズを聞けずに落ちる
- **接続先が `known_hosts` に登録済み**。初回接続は `Host key verification failed` で失敗する。
  この文字列は切断理由としてしか出ないので、先に一度 `ssh <user>@<host>` を手で通しておく
- **pm2 で動かす場合は `ssh` が pm2 の PATH にあること**。無いと `spawn ssh ENOENT` が
  切断理由に出る

いずれも失敗は「画面が切断され、理由の 1 行が出る」形でしか見えないので、
繋がらないときはまずこの 3 つを疑う。
