# 見た目の刷新: Paper (紙と付箋)

- 日付: 2026-09-17
- 方向性の検討: Fableと3案 (A Paper / B Lumen / C Atelier) を比較し、ユーザーがAを選択
- 参照モック: `2026-09-17-visual-redesign-paper/A-pc.html` / `A-mobile-chat.html` / `A-mobile-list.html`
  (ダミーデータ。ブラウザで直接開ける)

## 1. 目的

今のArkは「黒地にネオン緑」「名前が等幅」「CPU/MEM/DISK」などでターミナル感が強く、非エンジニアが
使いたくなる見た目ではない。Appleの最近の設計思想を取り入れ、**開いた瞬間に「自分が何をすればいいか」が
分かる**見た目に変える。

ワクワクの源泉は発光や透明感ではなく、**構造の明快さ**に置く。

### 見た目の問題に見えて、実は意味の問題だったもの

`SessionCard.tsx` の `statusToDotColor` は、作業が終わって入力を待っているIDLEをERRと同じ赤で塗る。
非エンジニアには「壊れた」にしか読めず、しかもリポジトリ順に並ぶので埋もれる。
さらに状態の色が2系統ある (PCサイドバーは `BridgeSessionStatus`、端末ヘッダとモバイルは
`session.status`)。`session.status` の `active` は「画面に内容がある」だけで、Claudeが動いているかとは
関係ないので、同じセッションがPCでは赤、モバイルでは緑の点滅になる。

今回の刷新で、状態の表示は `BridgeSessionStatus` の1系統に統一する。

## 2. 取り入れるAppleの考え方

WWDC25のLiquid Glassと、WWDC26 (iOS 27 / macOS 27) での揺り戻しを踏まえる。

- **ガラスは操作とナビゲーションの層だけ**。本文・カード・吹き出しには使わない (HIG Materials)
- **控えめに使う**。WWDC26は背後の拡散を強め、透明度をユーザーが選べるようにし、可読性へ寄せた
- **角丸を同心にする**。外側の角丸 = 内側の角丸 + 余白
- **コンテンツ優先**。操作は主要1〜2個を見せ、残りは `…` に畳む
- **システムフォント**。Apple端末ではSF Pro + ヒラギノが出る
- **Reduce Transparency / Increase Contrast / Reduce Motionに追従する**

Webには本物の屈折が無いので、ガラスは `backdrop-filter: blur(18px) saturate(170%)` までとする。

## 3. 決定事項

| 項目 | 決定 |
|---|---|
| 方向性 | A Paper。B Lumenから「モバイル下部の浮かぶガラスバー1枚」だけ借りる |
| テーマ | ライトを主に設計し、OSの設定 (`prefers-color-scheme`) に追従してダークにもなる |
| PCの左ペインの既定 | 「端末」から「会話」に変える (ユーザー決定)。保存済みの選択は尊重する |
| 状態の表示 | `BridgeSessionStatus` の1系統に統一。色 + 文言 + 形で表す |
| 端末 (ttyd) | 明るい画面の中の「暗い窓」として額縁で囲む。ttydの背景色を暖色の暗色に1行変える |
| 対象外 | 用語の言い換え (main / worktree / /clear等)、`/bridge` ページ、図 (ボード) の中身の配色、Mermaidのテーマ、一覧への経過時間の追加 (状態が変わってからの時刻はサーバーが持っていない。RepoGridViewの既存の `elapsedMs` 表示は残す) |

## 4. デザイントークン

`packages/web/src/index.css` の `:root` をライト、`@media (prefers-color-scheme: dark)` の中の `:root` をダークにする (今は `:root` と `.dark` が同じダーク値)。
shadcn/uiの既存トークン名はそのまま使い、状態色5つと影を新設する。

### ライト (`:root`)

```css
--background: oklch(0.985 0.005 80);
--foreground: oklch(0.24 0.02 60);
--card: oklch(1 0 0);
--card-foreground: oklch(0.24 0.02 60);
--popover: oklch(1 0 0);
--popover-foreground: oklch(0.24 0.02 60);
--primary: oklch(0.50 0.16 262);
--primary-foreground: oklch(0.99 0 0);
--secondary: oklch(0.955 0.008 80);
--secondary-foreground: oklch(0.24 0.02 60);
--muted: oklch(0.955 0.008 80);
--muted-foreground: oklch(0.48 0.02 60);
--accent: oklch(0.94 0.01 80);
--accent-foreground: oklch(0.24 0.02 60);
--destructive: oklch(0.55 0.20 25);
--destructive-foreground: oklch(0.99 0 0);
--border: oklch(0.90 0.01 80);
--input: oklch(0.90 0.01 80);
--ring: oklch(0.50 0.16 262);
--sidebar: oklch(0.985 0.005 80);
--sidebar-foreground: oklch(0.24 0.02 60);
--sidebar-accent: oklch(0.955 0.008 80);
--sidebar-accent-foreground: oklch(0.24 0.02 60);
--sidebar-border: oklch(0.90 0.01 80);
--sidebar-primary: oklch(0.50 0.16 262);
--sidebar-primary-foreground: oklch(0.99 0 0);
--sidebar-ring: oklch(0.50 0.16 262);

--status-busy: oklch(0.52 0.14 240);
--status-idle: oklch(0.55 0.15 150);
--status-awaiting: oklch(0.56 0.15 70);
--status-error: oklch(0.55 0.20 25);
--status-neutral: oklch(0.55 0.015 60);

--shadow-card: 0 1px 2px oklch(0 0 0 / 0.06), 0 4px 12px oklch(0 0 0 / 0.05);
--glass: oklch(1 0 0 / 0.72);
--radius: 0.75rem;
```

### ダーク (`@media (prefers-color-scheme: dark)`)

```css
--background: oklch(0.19 0.01 60);
--foreground: oklch(0.93 0.01 80);
--card: oklch(0.23 0.01 60);
--card-foreground: oklch(0.93 0.01 80);
--popover: oklch(0.23 0.01 60);
--popover-foreground: oklch(0.93 0.01 80);
--primary: oklch(0.74 0.13 262);
--primary-foreground: oklch(0.18 0.03 262);
--secondary: oklch(0.27 0.01 60);
--secondary-foreground: oklch(0.93 0.01 80);
--muted: oklch(0.27 0.01 60);
--muted-foreground: oklch(0.72 0.015 80);
--accent: oklch(0.29 0.01 60);
--accent-foreground: oklch(0.93 0.01 80);
--destructive: oklch(0.74 0.16 25);
--destructive-foreground: oklch(0.18 0.03 25);
--border: oklch(0.30 0.01 60);
--input: oklch(0.30 0.01 60);
--ring: oklch(0.74 0.13 262);
--sidebar: oklch(0.19 0.01 60);
--sidebar-foreground: oklch(0.93 0.01 80);
--sidebar-accent: oklch(0.27 0.01 60);
--sidebar-accent-foreground: oklch(0.93 0.01 80);
--sidebar-border: oklch(0.30 0.01 60);
--sidebar-primary: oklch(0.74 0.13 262);
--sidebar-primary-foreground: oklch(0.18 0.03 262);
--sidebar-ring: oklch(0.74 0.13 262);

--status-busy: oklch(0.76 0.12 240);
--status-idle: oklch(0.78 0.13 150);
--status-awaiting: oklch(0.82 0.14 75);
--status-error: oklch(0.74 0.16 25);
--status-neutral: oklch(0.65 0.015 60);

--shadow-card: 0 1px 2px oklch(0 0 0 / 0.3);
--glass: oklch(0.23 0.01 60 / 0.72);
```

`@theme inline` に `--color-status-*` を足し、`text-status-busy` `bg-status-busy/15` のようにTailwindから
使えるようにする。淡い背景は14%前後の透明度で作る。

### 撤去するもの

`--color-terminal-*`、`--chart-*`、`.terminal-prompt`、`.status-indicator` と `pulse-glow`、`.glow-green` /
`.glow-cyan`、未使用の `.pet-*` / `.heart-float` / `.level-up-flash` とkeyframes、未使用の `.container`。
`.md-prose` のrgbaとリンクの `#2563eb` はトークンに置き換える。

### ライトの琥珀の扱い

白地の琥珀は最も読みにくい。`--status-awaiting` を文字色に使うのは、12px/600のチップの中で、淡い背景と
アイコンを伴う場合に限る。

## 5. タイポグラフィ

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Hiragino Sans",
             "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif;
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
```

- `index.css` の `html, body` に直書きしている `font-family: Inter, …` も `var(--font-sans)` に置き換える
  (トークンを足すだけでは本文のフォントが変わらない)
- フォントはセルフホスト (@fontsource) のまま。CDNフォントは使わない (過去にモバイルが真っ白になった)
- **等幅はコードブロック、ツール行の引数、ファイルパスの入力欄だけ**。セッション名・ブランチ名・
  リポジトリ名・チップ・ボタンはsansに戻す

| 用途 | サイズ / ウェイト |
|---|---|
| 画面タイトル・ヘッダーのセッション名 | 17px / 600 / letter-spacing -0.01em |
| 会話本文 | 15px / 400 / line-height 1.6 |
| サイドバー行の主ラベル | 15px / 600 |
| 副ラベル (ブランチ・プレビュー) | 13px / 400 / muted-foreground |
| セクション見出し | 13px / 600 / muted-foreground。大文字化・字間拡張はしない |
| チップ・補足 | 12px / 500〜600 |
| 等幅 | コードブロック13px、ツール行の引数12px |

## 6. 角丸・余白・影・素材・モーション

- **同心**: ペイン16px (内側の余白4px) → カード12px → ボタン8px → チップfull。
  Tailwindでは `rounded-xl` / `rounded-lg` / `rounded-sm` / `rounded-full` に対応させる
- **余白**: 4pxグリッド。サイドバー行の縦10px・行間4px・セクション間20px。ペインの外周12px
- **影**: `--shadow-card` をカードと選択中の行だけに付ける。発光 (glow) は使わない
- **素材**: 基本は不透明の紙と1pxの罫線。ガラスはモバイル下部のバー1枚だけ
  (`--glass` + `backdrop-filter: blur(18px) saturate(170%)`)。以下で不透明に落とす
  - `@supports not (backdrop-filter: blur(1px))`
  - `@media (prefers-reduced-transparency: reduce)` / `(prefers-contrast: more)`
- **ガラスを端末 (ttyd) に重ねない**。ttydはiframeの大きさに合わせて描くので、行が隠れる
- **モーション**: 位置・不透明度・スケールだけで語る。回転・点滅・発光は置かない
  - 作業中: チップ内の3点がopacity 0.35→1を1.2秒周期で呼吸する
  - `prefers-reduced-motion: reduce` では止める

## 7. 状態の表現

### 対応表

1つのモジュール (`lib/status-tone.ts` を想定) に集約し、PCサイドバー・モバイル一覧・PCヘッダー・
モバイルヘッダー・RepoGridViewが同じ関数を使う。`statusToDotColor` / `fallbackDotColor` /
`STATUS_CONFIG` / `.status-indicator` はこれで置き換える。

| BridgeSessionStatus | トーン | チップの文言 | アイコン | セクション | 優先度 |
|---|---|---|---|---|---|
| AWAITING | awaiting | 確認待ち | 丸に ? | あなたの番 | 1 |
| ERR | error | 問題 | 丸に ! | あなたの番 | 2 |
| IDLE | idle | 入力待ち | 吹き出し | あなたの番 | 3 |
| TOOL / THINK | busy | 作業中 | 呼吸する3点 | 作業中 | 4 |
| READY | neutral | 待機 | 横線 | 休止中 | 5 |
| STOP | neutral | 停止 | 丸に横線 | 休止中 | 6 |
| セッション未起動のworktree | neutral (枠線のみ) | 未起動 | 再生 | 休止中 | 7 |
| スナップショット未着 | neutral | (文言なし) | 横線 | 休止中 | 8 |

- 色だけに頼らず、必ず**文言とアイコン**を添える (色覚の多様性)
- AWAITINGは質問カード (AskUserQuestion) と許可プロンプトの両方を含むので、文言は「質問」ではなく「確認待ち」にする
- IDLEは「出力があり、入力を待っている」状態で、作業の成功を意味しない (エラー・判断待ち・作業中の
  どれでもないときの判定)。そのため「完了」やチェックの形は使わない
- 参照モックとの違い: モックはAWAITINGを「質問」、IDLEを「完了」、ERRを「休止中」に置いている。
  実装はこの表に従う。エラーも人の対応が要るので「あなたの番」に入れる

### 並べ方

PCサイドバーとモバイル一覧を、リポジトリ順ではなく**注意の順**に3セクションで並べる。
比較のキーは次の順とする。

1. セクション (あなたの番 → 作業中 → 休止中)
2. 状態の優先度 (上の表)
3. リポジトリ名
4. リポジトリの絶対パス
5. worktreeのパス (worktreeの無いセッションは後ろ。今の `useGroupedWorktreeItems` と同じ)

- 「あなたの番」の見出しの右に件数バッジ (`--status-awaiting` の丸) を出す
- 空のセクションは見出しごと出さない
- 行はセクションをまたいでも**同じ親の下に安定したkeyで並べる** (見出しも同じ親に挟む)。
  セクション間の移動で行が再マウントされ、表示名の編集中の値やフォーカスが失われるのを防ぐ
- **並び替えの保留**: 次のどれかが成り立つ間は、行の位置を前の並びのまま保つ。状態チップの表示は
  即座に更新する (位置の移動と表示の更新を分ける)。条件が外れたら並びを反映する
  - PCでポインタが一覧の上にある
  - 一覧の中にフォーカスがある (表示名の編集中など)
  - 行の右クリックメニューか `…` メニューが開いている (Portalなのでポインタ判定では拾えない)
  - モバイルで一覧に触れている (touchstartからtouchendまで)

## 8. 画面ごとの変更

### 8.1. PCサイドバー (`SessionSidebar` / `SessionCard` / `SidebarMainLayout`)

- ヘッダー: ワードマーク「Ark」(sans 17/600)。`Terminal` アイコンは外す。右に `+`、通知許可ボタン
  (ブラウザの通知許可。今のまま)、リモート時の 🌐 をlucideのアイコンにしたもの
- リポジトリ見出しの行は廃止し、リポジトリ名を行の主ラベルに上げる
- 行 = 1行目「[状態チップ] 主ラベル」、2行目「ブランチ · プレビュー文」
  - 主ラベルは、表示名が設定されていれば表示名、無ければリポジトリ名
  - 同名のリポジトリを見分ける `disambiguator` (今は見出しに出ている親ディレクトリ名) は、主ラベルの後ろに
    muted-foregroundで出す。表示名があるときは、2行目の先頭にリポジトリ名を足す
  - 行の `title` にリポジトリの絶対パスを出す
  - 選択中の行は白いカード (`--card` + 罫線 + `--shadow-card`) で持ち上げる。`◀` は外す
  - 未起動のworktreeの行は「未起動」チップで出し、押すと今と同じくセッションを起動する
- **プロファイル (Linuxのみ)**
  - 表示: プロファイル未割り当て (今の「既定」) のときはチップを出さない。割り当てがあるときは、2行目の
    先頭に中立色の小さなチップでプロファイル名を出す。worktree個別の上書き (今の `*`) は「個別」と文言で
    添える。プロファイル別の5色は使わない
  - 操作: 今は設定の入口が2つある。リポジトリ見出しの「・既定」がリポジトリの既定プロファイル
    (`RepoProfileMenu` → `onSetRepoProfile`)、行のチップがworktree個別の上書き (`onSetWorktreeProfile`。
    「リポジトリの設定を継承」で解除) を変える。見出しとチップを消しても両方の操作を残すため、行のメニューに
    次の2つを別々に置く
    - 「このworktreeのプロファイル」: 個別の上書きの選択と「リポジトリの設定を継承」
    - 「リポジトリ」グループの「リポジトリの既定プロファイル」: 今の `RepoProfileMenu` の中身
  - 「古い設定」(起動後にプロファイルの割り当てが変わった) の警告と「再起動」は、`--status-awaiting` の
    トーンで今のまま残す
- **行のメニュー** (右クリックと、ホバー時に出る `…` の両方で同じ中身):
  - 開く / 表示名を変更 / このセッションの通知オン・オフ / 再起動 / このworktreeのプロファイル
  - リポジトリ: 新規worktreeを作成 / このリポジトリの全セッションを並べて見る (RepoGridView) /
    リポジトリの既定プロファイル / サイドバーから除外
  - プロファイルの項目は、今と同じくLinuxで `multiProfileSupported` のときだけ出す
  - 削除 (最下段、赤い文字、確認ダイアログは今のまま)
- 最下段の「About Ark」とCPU/MEM/DISK (`SystemStatusBar`) はサイドバーから外す。CPU/MEM/DISKと
  `/bridge` へのリンクはAboutダイアログの中に移す。Aboutはワードマークの横のメニューから開く

### 8.2. PCメインペイン (`SplitViewPane` / `TerminalPane` / `SplitChatPane`)

- **上部バーを1本に統合する**。今は、上部バー (端末/会話トグルと図) と、端末ペインの中のヘッダー
  (セッション名・ブランチ・8個のアイコン) に分かれていて、会話モードではセッション名と操作が消える
  - 左: セッションの主ラベル (17/600) + ブランチ (13/400) + 状態チップ
  - 中央: 「端末 / 会話」のセグメントコントロール (選択側が白いカプセル。絵文字は使わない)
  - 右: 1タップのボタン (メッセージのショートカットは両モード、それ以外は端末モードのときだけ) +
    「図」の開閉ボタンと `…` メニュー
- **端末に関する操作は1タップ、セッション全体の操作だけ `…` に残す**
- `…` を開かずに届く1タップのボタン (左からこの順)
  - ファイルを添付・画像を貼り付け (端末モードのときだけ)
  - メッセージのショートカット (両モード。送信の一覧と「ショートカットを管理」を1つのボタンから開く)
  - 端末のバッファをコピー・端末を再読み込み・入力バーを表示 / 入力バーを隠す (端末モードのときだけ)。
    入力バーだけは出したままにできる操作なので、今の状態を `aria-pressed` と文言で示す
- `…` メニューの中身は両モード共通で、このセッションの通知オン・オフ / 削除 (最下段、赤い文字) だけ
- 会話モードでの添付と画像の貼り付けは、会話の入力欄 (今もD&D・貼り付け・添付ボタンがある) が担う。
  端末側の添付確認画面と入力バーは端末ペインの中にあり、会話モードでは親ごと隠れるため、
  端末に関する操作はボタンからもメニューからも呼ばない
- `TerminalPane` の中のヘッダーはPCでは出さない。上の端末モード専用の操作は親から呼べるようにする。
  メニューが閉じてもファイル選択の `<input>` が消えないよう、inputは `TerminalPane` 側に残す
- 端末は「暗い窓」として額縁で囲む: 12pxの角丸、8pxの内側余白、背景は端末と同じ暖色の暗色
- `SplitChatPane` の自前のヘッダー行 (busy表示と購読ドット) はPCでは出さない。状態は上部バーの
  チップが担う。購読ドットは削除する (`jsonlSubscribed` は購読要求を送った時点でtrueになり、切断を
  表さないため)
- サーバーとの切断は、今の `Dashboard` の「Not connected to server」の帯 (`isConnected` 由来) を
  「サーバーとつながっていません」の文言と `--status-error` のトーンに直して使う

### 8.3. 会話 (`SplitChatPane`。PCとモバイルで共有)

- ユーザー: 吹き出し。背景は `--primary` を14%混ぜた淡い色、文字は `--foreground`、15px、幅は最大78%、
  右寄せ。送信中 (pending) は透明度を下げてスピナーを添える
- アシスタント: 吹き出しなしで紙に直接書く (`.md-prose`、15px / 1.6)
- **ツール行を折りたたむ**
  - 対象: `groupSidechain` で畳んだ後の並びのうち、sidechainの外にある `tool-call` イベント。
    ただし `AskUserQuestion` の `tool-call` (回答済みカード) は対象外で、独立して表示する
  - 境界: `user-input` / `assistant-text` / `slash-command` / `compact-marker` / sidechainのまとまり /
    `AskUserQuestion` が来たら、まとまりを閉じる。表示されない `thinking` は境界にしない
  - 表示: 「作業N件」(Nはまとまりの中の `tool-call` の数) の1行。押すと今のツール行が開く
  - 実行中のまとまり (中の `tool-call` に `status` が `running` のものが1件でもある) だけは、`running` の
    うち最も新しい1件を要約の下に出す。並列の呼び出しは結果の届いたものから `done` になるので、最後の1件
    だけでは判定しない
  - 1件だけのまとまりも同じく折りたたむ
- 質問カード (`AskUserQuestionCard`): 白いカード + 12px角丸 + 影。見出しに「確認待ち」チップ、選択肢は
  番号バッジ付きの行ボタン、「その他 (自由入力)」は点線の行。回答の送り方 (tmuxキー送出) と、入力欄の
  上に固定で出す配置は変えない
- 許可プロンプト等の帯 (`AwaitingPad`): 同じカードの形にそろえる。「直前の画面」とキーのボタンは等幅のまま
- 絵文字のアイコン (⚙ ❓ ⏳ 🧵 🖼 ✂ 🎨 🖥) はlucideのアイコンに置き換える
- スラッシュコマンドのカード・補完候補・ファイルリンクの色 (emerald / blue / violet) はトークンに置き換える
- 入力欄: 角丸のピル、送信は `--primary` の円形ボタン
- 使われていない 🎨ボード / 🖥ターミナル のボタン (呼び出し元がpropsを渡していない) は削除する

### 8.4. モバイル一覧 (`MobileSessionList` / `MobileLayout`)

- 見出し「Ark」(22/700) と `+`、通知許可ボタン
- PCサイドバーと同じ並べ方 (7節) と同じ行の中身 (8.1節) を、12px角丸のカードで出す。
  今のモバイル一覧に無い状態・プレビュー・表示名をPCとそろえる。行の `⋮` メニューは8.1節と同じ中身にする
- 下部のタブバー (「セッション」「ブラウザ」) は、ブラウザタブがあるリモート時だけ出す。
  選択中のタブは緑の線ではなく、文字色とウェイトで示す。タブバーを出さないときは、一覧の `pb-14` も外す

### 8.5. モバイル会話 (`MobileSessionView` / `MobileSessionViewModeToggle`)

- ヘッダー: 戻る + 主ラベル + ブランチ + 状態チップ。右に `…` (このセッションの通知オン・オフ /
  セッションを再起動 / 削除。メッセージのショートカットと端末に関する操作は下部バーの1タップの
  ボタンへ移した)
- **状態の帯**: ヘッダーの直下に32pxの帯を出す。会話の右上の小さいスピナーは廃止する
  - AWAITING: 質問カードが出ているときは「質問があります」、無いとき (許可プロンプト等) は
    「確認を求めています」。カードと `AwaitingPad` はどちらも入力欄の上に固定で出ているので、会話モードでは
    帯にボタンを付けない。端末モード・図モードでは「会話で答える」ボタンを付け、押すと会話モードに切り替える
  - TOOL / THINK: THINKは「考えています」、TOOLは「作業しています」
  - ERR: 「問題が起きています」
  - サーバーと切断中: 「サーバーとつながっていません」(`MobileLayout` に渡っている `isSocketConnected` を使う)。
    切断中はほかの状態より優先する
  - IDLE / READY / STOPでは出さない
  - 文言は状態と質問カードの有無だけから作る。端末の画面テキストは解釈しない (情報源分離の原則)
- **下部のバー**: 上段に「会話 / 端末 / 図」のセグメントと1タップの操作の行、下段にモードごとの入力部
  - 1タップの操作の行 (ファイルを添付・画像を貼り付け・メッセージのショートカット・スラッシュコマンド・
    端末のバッファをコピー・端末を再読み込み) はセグメントの下に置き、3モードのバーすべてに出す
    (`…` を開かずに届かせる)。画像を貼り付け・メッセージのショートカット・スラッシュコマンドは3モードとも
    出すが、ファイルを添付だけは会話モードで出さない (会話の入力欄が自前の添付ボタンを持つため。
    端末・図モードは端末側の確認ダイアログの流儀で受ける)
  - 端末に関する操作 (端末のバッファをコピー・端末を再読み込み) は端末モードだけに出す。図モードでも
    添付は端末側の流儀で受けるが、端末そのものは見えていないので端末の操作は出さない。
    一番混む端末モードで6つ並ぶが、44px×6 + 4px×5 = 284px なので、幅390pxの画面の本文幅 (366px) に収まる
  - 置き場所: `MobileSessionView` の本文コンテナ (キーボード表示中は `useVisualViewport` で高さを
    合わせている今の仕組み) の下端に絶対配置する。下端からの距離は `max(12px, env(safe-area-inset-bottom))`
  - 会話モード: バーは浮かぶガラス (28px角丸)。上段はセグメント + 1タップの操作の行、下段は
    `SplitChatPane` の入力欄 (添付・入力・送信)。会話の本文はバーの下を通る。本文の下端の余白は
    「バーの実測の高さ (ResizeObserver) + バーの下端からの距離 (上の
    `max(12px, env(safe-area-inset-bottom))` の実際の値) + 12px」とし、最下部までスクロールした
    ときに最後の行がバーに隠れないようにする。入力欄が複数行に伸びても余白が追従する
  - 端末モード: ガラスをやめて不透明にし、端末に重ねない (端末の領域はバーの上端までにする)。
    下段は今の端末用の入力部をそのまま使う: Quick Keys (↑ ↓ Esc Ctrl+C S-Tabなど) と入力欄。
    空のまま送信するとEnterを送る今の挙動を保つ
  - 図モード: 下部バーはセグメントだけでなく1タップの操作の行も持つ。図の下に置く不透明なバーで出す
    (図の中に下端固定のツールバーがあり、ガラスを重ねると隠れる)
  - 会話と端末の入力欄は、今と同じく別々のコンポーネントで、入力途中の文字もそれぞれに保つ
- 添付があると端末モードに切り替える今の挙動は保つ

### 8.6. そのほか

- `App.tsx` のToasterの直書き色を外し、トークンに従わせる
- OSの設定に追従させる。JSで `<html>` に `.dark` を付ける `ThemeProvider` をやめ、`@custom-variant dark (@media (prefers-color-scheme: dark))` とメディアクエリのトークンで切り替える。初回表示のちらつきが無く、実行中の切り替えにも追従する
- ダイアログ類 (RepoSelect / FolderBrowser / CreateWorktree / ProfileManager / MessageShortcutManager /
  About) の `glow-green` と直書き色をトークンに置き換える。パスの表示と入力は等幅のまま
- `RepoGridView` の状態色を7節の対応表に置き換える
- `UpdateBanner` / `FileViewerPane` (`prose-invert` を `dark:` のときだけに) / `NotFound` を両テーマで読める色にする
- PCの左ペインの既定を `chat` に変える。`split-view-left-mode.ts` の `normalizeSplitViewLeftMode` の既定値と、
  localStorageが例外を投げたときの既定値の両方を `chat` にそろえる。保存済みの選択は尊重する
- ttydの背景色を `#1c1a17`、文字色を `#e6e1da` に変える (`ttyd-manager.ts`)。`TerminalPane` と
  `MobileSessionView` の `bg-[#1a1b26]` も同じ値にそろえる。デプロイ手順でttydを再起動するので、
  反映に追加の手間は無い

## 9. テストへの影響

見た目に依存しているテストは、意図 (何を確かめたいか) を保ったまま直す。

| テスト | 直し方 |
|---|---|
| `e2e/mobile-session-state.spec.ts` | 下部タブの `text-primary` ではなく、一覧が表示されていること (見出し等) でフォールバックを確かめる |
| `SplitViewPane.test.tsx` | 会話ラッパのclassName完全一致をやめ、表示・非表示で確かめる。aria-labelとaria-pressedは保つ。端末が初期状態であることを前提にした購読・D&Dのテストは、`terminal` を明示的に保存してから始める |
| `MobileSessionView.test.tsx` | 絵文字の確認を外し、文言とariaで確かめる |
| `split-view-left-mode` | 保存なし・不正な値・localStorageの例外のどれでも `chat` になることを固定する |

新しく足すテスト:

- 状態の対応表 (`status-tone`): 7つの状態と未起動・未着が、トーン・文言・セクション・優先度に正しく対応する
- 並べ方: 7節の比較キーの順
- 並び替えの保留: ホバー中・フォーカス中・メニュー表示中は位置が変わらず、チップだけ変わる
- ツール行の折りたたみ: 境界の種類ごとにまとまりが切れること、`AskUserQuestion` とsidechainが対象外であること

## 10. 確かめ方

- `pnpm check`、`pnpm test`、`pnpm test:e2e` (少なくとも9節で直したspec) を通す
- 検証ビルドは本番の配信物を上書きしないよう、別の出力先 (`vite build --outDir <scratch>`) に作り、
  `vite preview` で開く
- 撮影する画面
  - PC: 1440×900と、PCレイアウトの下限に近い幅 (1024×768) で、サイドバーの幅を変えた状態も含める
  - モバイル: 390×844。キーボード表示の代わりにviewportの高さを縮めた状態も撮る
  - ライトとダークの両方。実行中にOSのテーマを切り替えたとき (`emulateMedia`) に追従することも確かめる
- 状態が並ぶ画面は、ダミーのスナップショットで7状態と未起動・未着をすべて出して確かめる
- 端末 (ttyd) を含む確認は、検証用のworktreeとセッションを作り、それだけを対象にする (ほかのセッションの
  ttydに触ると、ユーザーのtmuxペインが検証側の画面サイズに縮む)。端末/会話の切り替えでiframeが
  作り直されないこと、額縁の中で端末が正しい大きさに収まること、モバイルでバーが端末に重ならないことを見る
- ユーザーが実機で触る段階は、プレビュー配信の方法をそのとき決める

## 11. リスク

- **地味に見える**: 色より構造で勝負する案なので、余白・文字組・チップの質が悪いと「メモアプリ」に落ちる。
  参照モックの寸法を守る
- **行が動く**: 注意の順に並べるので、状態が変わるたびに行がセクションを移る。7節の保留条件で緩和する
- **明暗の段差**: 明るい画面の中の暗い端末窓は、切り替えた瞬間のコントラストが大きい。意図した表現として
  受け入れる
- **状態の誤判定が目立つ**: `BridgeSessionStatus` は端末画面の解析なので、ERRなどの誤判定が「あなたの番」に
  上がると以前より目立つ。判定ロジックは今回変えない
- **変更範囲が広い**: 20ファイル以上に触る。9節のテストと10節の撮影で退行を拾う
