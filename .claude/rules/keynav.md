---
paths:
  - "packages/web/src/components/KeyNavLayer.tsx"
  - "packages/web/src/components/CommandPalette.tsx"
  - "packages/web/src/lib/keynav*.ts"
  - "packages/web/src/lib/palette*.ts"
  - "packages/web/src/hooks/useTerminalLeaderKey.ts"
  - "packages/server/src/lib/diagram-keynav-layer.ts"
  - "packages/web/src/components/DiagramPane.tsx"
---

# キーボード操作 (ノーマルモード) とコマンドパレット

PCでは、vimのように「入力モード」と「ノーマルモード」を分け、キーでArkを動かせる (`KeyNavLayer` / `lib/keynav.ts` / `lib/keynav-dom.ts`)。キーの一覧は `?` で出る。**キーの正本は `KEYNAV_HELP`** で、ここには写さない。

## ノーマルモードの出入り

- **入口は前置キー `Ctrl+;`。** vimのEscにしないのは、会話の入力欄のEscをClaude本体と同じ動き (中断など) に割り当て済みで、端末でもEscはClaudeに届ける必要があるため。ノーマルモードからは `i` でも入力へ戻る
- **端末の中からも前置キーが効く。** ttydのiframeは別のブラウジングコンテキストで、端末にフォーカスがある間のキーは親に届かない。ttydは同じ出どころなので、iframeのdocumentに捕捉段階のリスナーを付け、前置キーだけを横取りする (`useTerminalLeaderKey`。ほかのキーには触らない)
- **図の中からは、図に載せた層が前置キーを知らせる** (`diagram-keynav-layer.ts`)。図のiframeはsandboxで出どころが違い、親は中のdocumentに触れない。サーバーが図へ注入する層が前置キーだけを横取りしてportで親へ送り、`DiagramPane` が端末と同じ合図 (`ark:keynav-leader`) に直す。このときノーマルモードは作業エリアから始まる
- 図を `j` / `k` で送るときは逆向き。`keynav-dom` が見えている図のiframeへ合図を投げ、`DiagramPane` がportで中へ渡し、層が `scrollBy` する
- ノーマルモードに入るとき、フォーカスをiframeや入力欄から、見えない受け皿へ移す (iframeに残るとキーが親に届かない)。入力欄や端末をクリックしたら入力モードに戻す

## 指示の実行

- **指示は「マウスで押すもの」をそのまま押して実行する** (行をクリックする、タブをクリックする、ツリーやコミット一覧へ矢印キーを送る)。`Dashboard` や `SplitViewPane` へ指示ごとの口を足さない。マウスで出来ることとキーで出来ることを食い違わせないため
- **要素は必ず「見えているもの」から探す** (`hidden` の祖先を持たないもの)。全セッションぶんのペインが常時マウントされている
- Enter、Tab、矢印はノーマルモードでも横取りしない (フォーカスのある行やボタンが自分で動く)
- 文字のキーは、割り当てが無くても受け取る (入力もページ内検索もさせない)
- ダイアログやメニューが開いている間は何もしない

## コマンドパレット

ノーマルモードの `:` で、名前で探して実行するパレットが開く (`CommandPalette` / `lib/palette.ts`)。候補はセッション、図、ファイル、コマンド。最後に、打った文を裏のClaudeに聞く行を置く (`Tab` で直接聞く。何も一致しなければ `Enter` がこれになる。裏のClaudeは `ask.md`)。

- **入口は `:` だけ。** 入力モードから直接開くキーは足さない (端末のClaudeに届かないキーを増やさない)。端末からは `Ctrl+;` → `:` の2打
- **ファイルは一覧を1回取って、手元で絞り込む。** パレットを開くたびに `file:index` でそのworktreeの全パスを取る (`git ls-files --cached --others --exclude-standard`。gitignoreの対象は含まない。5万件まで)。打つたびにサーバーへ問い合わせない
- **場所やタブを替えるコマンドは、パレットが実行せずに `KeyNavLayer` へ返す** (`ark:palette-closed` の `command`)。パレットが自分でDOMを押すと、`KeyNavLayer` が覚えている「いる場所」と食い違う。閉じたあとのフォーカスも `KeyNavLayer` が置き直す
- **パレットの入力欄は `data-keynav-ignore` を持つ。** 持たないと、入力欄へのフォーカスを `KeyNavLayer` が「入力モードへ戻る合図」と読む
- **開く先のセッションは、パレットを開いた時点のものに固定する。** ファイルと図の一覧はそのworktreeのもので、開いている間に選択が替わっても、別のworktreeで開かない
- **取り消せない操作 (停止、削除、再起動) は載せない。** 打ち間違いの `Enter` で消えるため。起動していないworktreeも載せない (選ぶと起動が走る)
