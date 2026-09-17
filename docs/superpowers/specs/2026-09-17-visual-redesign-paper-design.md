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
| 対象外 | 用語の言い換え (main / worktree / /clear等)、`/bridge` ページ、図 (ボード) の中身の配色、Mermaidのテーマ、経過時間の表示 (元データが無い) |

## 4. デザイントークン

`packages/web/src/index.css` の `:root` をライト、`.dark` をダークにする (今は両方が同じダーク値)。
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

### ダーク (`.dark`)

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

| BridgeSessionStatus | トーン | チップの文言 | アイコン | セクション |
|---|---|---|---|---|
| AWAITING | awaiting | 質問 | 丸に ? | あなたの番 |
| ERR | error | 問題 | 丸に ! | あなたの番 |
| IDLE | idle | 完了 | チェック | あなたの番 |
| TOOL / THINK | busy | 作業中 | 呼吸する3点 | 作業中 |
| READY | neutral | 待機 | 横線 | 休止中 |
| STOP | neutral | 停止 | 丸に横線 | 休止中 |
| セッション未起動のworktree | neutral (枠線のみ) | 未起動 | 再生 | 休止中 |
| スナップショット未着 | neutral | (文言なし) | 横線 | 休止中 |

- 色だけに頼らず、必ず**文言とアイコン**を添える (色覚の多様性)
- 参照モックではERRを「休止中」に置いたが、エラーも人の対応が要るので「あなたの番」に入れる

### 並べ方

PCサイドバーとモバイル一覧を、リポジトリ順ではなく**注意の順**に3セクションで並べる。

1. **あなたの番** (見出しの右に件数バッジ。`--status-awaiting` の丸): AWAITING → ERR → IDLE
2. **作業中**
3. **休止中**

- セクション内の順は、今の `useGroupedWorktreeItems` の並び (リポジトリ名 → パス) を保つ
- 空のセクションは見出しごと出さない
- **PCではポインタがサイドバーの一覧の上にある間、並び替えを止める**。クリックしようとした行が
  状態の変化で動き、別のセッションを開く事故を防ぐ。ポインタが外れたら反映する

## 8. 画面ごとの変更

### 8.1 PCサイドバー (`SessionSidebar` / `SessionCard` / `SidebarMainLayout`)

- ヘッダー: ワードマーク「Ark」(sans 17/600)。`Terminal` アイコンは外す。右に `+` と通知ベル (と、
  リモート時の 🌐 をアイコン化したもの)
- リポジトリ見出しの行は廃止し、リポジトリ名を行の主ラベルに上げる
- 行 = 1行目「[状態チップ] 主ラベル」、2行目「ブランチ · プレビュー文」
  - 主ラベルは表示名が設定されていれば表示名、無ければリポジトリ名
  - 選択中の行は白いカード (`--card` + 罫線 + `--shadow-card`) で持ち上げる。`◀` は外す
- プロファイル表示 (Linuxのみ): 既定プロファイルのときは出さない。既定以外のときだけ2行目の先頭に
  中立色の小さなチップで出す。プロファイル別の5色は使わない。「古い設定」の警告は `--status-awaiting` の
  トーンで残す
- リポジトリ単位の操作 (新規worktree作成・サイドバーから除外・プロファイル設定・グリッド表示) は、
  行の右クリックメニューと `…` に「リポジトリ」のグループとして移す。RepoGridViewへの導線はここに残す
- 最下段の「About Ark」とCPU/MEM/DISK (`SystemStatusBar`) はサイドバーから外す。CPU/MEM/DISKと
  `/bridge` へのリンクはAboutダイアログの中に移す。Aboutはヘッダーか `…` から開く

### 8.2 PCメインペイン (`SplitViewPane` / `TerminalPane` / `SplitChatPane`)

- **上部バーを1本に統合する**。今は、上部バー (端末/会話トグルと図) と、端末ペインの中のヘッダー
  (セッション名・ブランチ・8個のアイコン) に分かれていて、会話モードではセッション名と操作が消える
  - 左: セッションの主ラベル (17/600) + ブランチ (13/400) + 状態チップ
  - 中央: 「端末 / 会話」のセグメントコントロール (選択側が白いカプセル。絵文字は使わない)
  - 右: 「図」の開閉ボタンと `…` メニュー
- `…` メニューに今のアイコン列を畳む。端末でしか意味の無い操作 (バッファのコピー・端末の再読み込み・
  入力バーの表示) は端末モードのときだけ出す。削除はメニューの最下段に赤い文字で置き、確認ダイアログは
  今のまま
- `TerminalPane` の中のヘッダーはPCでは出さない。操作は親から呼べるようにする (実装は計画で決める)
- 端末は「暗い窓」として額縁で囲む: 12pxの角丸、8pxの内側余白、背景は端末と同じ暖色の暗色
- `SplitChatPane` の自前のヘッダー行 (busy表示と購読ドット) はPCでは出さない。状態は上部バーの
  チップが担う。接続が切れたときだけ、会話の上に帯で知らせる

### 8.3会話 (`SplitChatPane`。PCとモバイルで共有)

- ユーザー: 吹き出し。背景は `--primary` を14%混ぜた淡い色、文字は `--foreground`、15px、幅は最大78%、
  右寄せ。送信中 (pending) は透明度を下げてスピナーを添える
- アシスタント: 吹き出しなしで紙に直接書く (`.md-prose`、15px / 1.6)
- **ツール行を折りたたむ**: 連続するツール呼び出しを「作業N件」の1行にまとめ、押すと今の行が開く。
  作業中の最後のまとまりだけは、最新の1行を要約の下に出す
- 質問カード (`AskUserQuestionCard`): 白いカード + 12px角丸 + 影。見出しに「質問」チップ、選択肢は
  番号バッジ付きの行ボタン、「その他 (自由入力)」は点線の行。回答の送り方 (tmuxキー送出) は変えない
- 許可プロンプト等の帯 (`AwaitingPad`): 同じカードの形にそろえる。「直前の画面」は等幅のまま残す
- 絵文字のアイコン (⚙ ❓ ⏳ 🧵 🖼 ✂ 🎨 🖥) はlucideのアイコンに置き換える
- スラッシュコマンドのカードと補完候補の色 (emerald / blue / violet) はトークンに置き換える
- 入力欄: 角丸のピル、送信は `--primary` の円形ボタン
- 使われていない 🎨ボード / 🖥ターミナル のボタン (呼び出し元がpropsを渡していない) は削除する

### 8.4モバイル一覧 (`MobileSessionList` / `MobileLayout`)

- 見出し「Ark」(22/700) と `+`、通知ボタン
- PCサイドバーと同じ3セクション・同じ行の中身 (状態チップ・主ラベル・ブランチ · プレビュー) を、
  12px角丸のカードで出す。今のモバイル一覧に無い状態・プレビュー・表示名をPCとそろえる
- 下部の「セッション」タブバーは、タブが2つになるリモート時 (ブラウザタブがある) だけ出す。
  選択中のタブは緑の線ではなく、文字色とウェイトで示す

### 8.5モバイル会話 (`MobileSessionView` / `MobileSessionViewModeToggle`)

- ヘッダー: 戻る + 主ラベル + ブランチ + 状態チップ。右に `…` (今の操作メニューと削除を統合)
- **状態の帯**: ヘッダーの直下に32pxの帯を出す。右上の小さいスピナーは廃止する
  - 回答待ち: 「質問があります」+「カードへ」(押すと質問カードまでスクロール)
  - 作業中: THINKは「考えています」、TOOLは「作業しています」
  - エラー: 「問題が起きています」
  - 完了・待機・停止では出さない
  - 文言は状態だけから作る。端末の画面テキストは解釈しない (情報源分離の原則)
- **下部の浮かぶガラスバー1枚**: 上段に「会話 / 端末 / 図」のセグメント、下段に添付・入力・送信。
  28pxの角丸で、会話の本文はこのバーの下を通る (本文の下端に余白を足す)
  - 端末モードでは、ガラスをやめて不透明にし、端末に重ねない
  - 図モードではセグメントだけを出す

### 8.6そのほか

- `App.tsx` のToasterの直書き色を外し、トークンに従わせる
- `ThemeProvider` をOSの設定に追従させる (`matchMedia` の変化も拾う)
- ダイアログ類 (RepoSelect / FolderBrowser / CreateWorktree / ProfileManager / MessageShortcutManager /
  About) の `glow-green` と直書き色をトークンに置き換える。パスの表示と入力は等幅のまま
- `RepoGridView` の状態色を7節の対応表に置き換える
- `UpdateBanner` / `FileViewerPane` (`prose-invert` を `dark:` のときだけに) / `NotFound` を両テーマで読める色にする
- PCの左ペインの既定を `chat` に変える (`split-view-left-mode.ts` の `normalizeSplitViewLeftMode` の既定値)
- ttydの背景色を `#1c1a17`、文字色を `#e6e1da` に変える (`ttyd-manager.ts`)。`TerminalPane` と
  `MobileSessionView` の `bg-[#1a1b26]` も同じ値にそろえる。デプロイ手順でttydを再起動するので、
  反映に追加の手間は無い

## 9. テストへの影響

見た目に依存しているテストは、意図 (何を確かめたいか) を保ったまま直す。

| テスト | 直し方 |
|---|---|
| `e2e/mobile-session-state.spec.ts` | 下部タブの `text-primary` ではなく、一覧が表示されていること (見出し等) でフォールバックを確かめる |
| `SplitViewPane.test.tsx` | 会話ラッパのclassName完全一致をやめ、表示・非表示で確かめる。aria-labelとaria-pressedは保つ |
| `MobileSessionView.test.tsx` | 絵文字の確認を外し、文言とariaで確かめる |
| `split-view-left-mode` の既定値 | `chat` に変わることをテストで固定する |

新しく足すテスト:

- 状態の対応表 (`status-tone`): 7つの状態と未起動・未着が、トーン・文言・セクションに正しく対応する
- 並べ方: 3セクションの順と、セクション内の順が保たれること
- ホバー中は並び替えを止めること

## 10. 確かめ方

- `pnpm check` と `pnpm test` を通す
- 検証ビルドは本番の配信物を上書きしないよう、別の出力先 (`vite build --outDir <scratch>`) に作り、
  `vite preview` で開く。ttydへの通信は遮断して撮る (ユーザーのtmuxペインが縮むのを防ぐ)
- PC (1440×900) とモバイル (390×844) を、ライトとダークの両方で撮り、参照モックと見比べる
- 状態が並ぶ画面は、ダミーのスナップショットで7状態すべてを出して確かめる
- ユーザーが実機で触る段階は、プレビュー配信の方法をそのとき決める

## 11. リスク

- **地味に見える**: 色より構造で勝負する案なので、余白・文字組・チップの質が悪いと「メモアプリ」に落ちる。
  参照モックの寸法を守る
- **行が動く**: 注意の順に並べるので、状態が変わるたびに行がセクションを移る。PCはホバー中に止めて緩和する
- **明暗の段差**: 明るい画面の中の暗い端末窓は、切り替えた瞬間のコントラストが大きい。意図した表現として
  受け入れる
- **状態の誤判定が目立つ**: `BridgeSessionStatus` は端末画面の解析なので、ERRなどの誤判定が「あなたの番」に
  上がると以前より目立つ。判定ロジックは今回変えない
- **変更範囲が広い**: 20ファイル以上に触る。9節のテストと10節の撮影で退行を拾う
