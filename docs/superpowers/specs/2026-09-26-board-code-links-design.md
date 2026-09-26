# 図解ボードからコードへ飛ぶリンクと、変更レビュー文書の型

- 日付: 2026-09-26
- 検討の経緯: dev.fast Whiteboard (人間とエージェントが設計を共有するキャンバス) を見て、Ark の図解ボードに
  取り込める点を選んだ。取り込むのは「図・文書の記述からコードへ 1 クリックで飛ぶ」と「変更レビューを書く
  ときの型」の 2 つ。コミットにセッション id を残す案は見送った (ユーザー決定)
- 状態: 実装する (ユーザー決定)

## 1. 目的

ボードに「`parse()` が入力を検証する」と書いたとき、その語からコードの該当行へ飛べるようにする。
Whiteboard が `review-source:head/src/file.ts#L10-L24` で実現している体験を、Ark の既存部品
(右ペインの `FileViewerPane` と、その行ハイライト) で実現する。

あわせて、変更 (ブランチ・PR) をレビューする文書を書くときの節の順序と図の選び方を規約にする。

## 2. 決定事項

| 項目 | 決定 |
|---|---|
| リンクの書き方 | `<a href="src/foo.ts#L10-L24">parse()</a>`。worktree 相対パス + 任意の `#L<行>` か `#L<開始>-L<終了>`。`http(s)://` はそのまま外部リンク |
| クリックの扱い | サーバが配信時に注入する **リンク層** (`diagram-link-layer.ts`) が `<a>` のクリックを横取りし、iframe を遷移させずに親へ MessagePort で伝える |
| 親側の処理 | `DiagramPane` が受け取り、相対パスは `ark:open-file`、`http(s)` は `ark:open-url` として **自分の window へ postMessage** する。どちらも端末のリンクが使っている既存の入口 (`useViewerTabs`) なので、ファイルは右ペインで該当行がハイライトされて開き、URL は新しいタブで開く |
| 行の範囲 | 開始行にスクロールしてハイライトする。終了行は受け取るが v1 では使わない (`FileViewerPane` の単一行ハイライトのまま) |
| 対象 | doc 型と graph 型の両方 (投影 HTML 内の `<a>` にも効く) |
| 規約 | `diagram-authoring` の規約に「コードを指す語はリンクにする」と「変更レビュー文書の型」を追記し、見本を `_examples/` に置く |

## 3. 検討して採らなかったもの

### `<a>` を横取りせず、そのまま遷移させる

いまは `<a href>` を押すと iframe ごと遷移し、`DiagramPane` はそれを「図が別ページへ遷移しようとした」として
コメント層との接続を切る (`DiagramPane.tsx` の 2 回目の `load` 判定)。つまりボード内のリンクは現状
**壊れる**ので、横取りは機能追加であると同時に欠陥の修正でもある。

### 独自スキーム (`ark://file/...`)

相対パスの方が GitHub 上でもそのまま読め、書き手 (Claude・人間) が覚える規則が 1 つ減る。
文書内アンカー (`#s6`) と区別できるので独自スキームは要らない。

### `DiagramPane` に `onOpenFile` prop を通す

`SplitViewPane` → `Dashboard` → `useViewerTabs` と 3 層に prop を通すことになる。`useViewerTabs` は既に
window の `message` で `ark:open-file` / `ark:open-url` を受けているので、`DiagramPane` が同一オリジンの
自分の window へ postMessage すれば配線ゼロで届く。端末のリンクと同じ経路を通るので挙動も揃う。

### コミットへの `Ark-Session` トレーラ (C 案)

Claude が打つ `git commit` を Ark の hook が書き換える形か、リポジトリごとに git hook を入れる形の
どちらかになる。前者はコマンドの書き換え、後者は手動導入で、いまは価値が費用に見合わないと判断した
(ユーザー決定)。必要になったら、hook の入力にある Claude の会話 id を `Claude-Session:` トレーラに
載せる案が最も筋がよい。

## 4. 構成

```text
[ボード iframe]  <a href="src/foo.ts#L10">  ── click ──▶ リンク層 (注入)
                                                        │ port.postMessage({type:"ark:diagram-open-link", href})
                                                        ▼
[DiagramPane]   handleDiagramOpenLinkMessage ── 相対 ──▶ window.postMessage({type:"ark:open-file", path, line})
                                             ── http ──▶ window.postMessage({type:"ark:open-url", url})
                                                        ▼
[useViewerTabs] 既存: file:read → FileViewerPane(targetLine) / 新しいタブで開く
```

### 4.1 リンク層 (`packages/server/src/lib/diagram-link-layer.ts`)

- `LINK_LAYER` (読みやすいソース) と `injectDiagramLinkLayer(html)` を export。コメント層と同じく
  `</body>` 直前に 1 回だけ注入し、`data-ark-link-layer` の marker で二重注入を防ぐ。配信は
  `createCachedMinifier` で圧縮した版
- スクリプトの動作:
  - window の `ark:diagram-init` で `event.ports[0]` を保持する (他の層と同じ port を共有)
  - `document` の `click` を capture で聞き、`event.target.closest("a[href]")` を取る
  - `href` 属性 (解決前の生の値) が `#` 始まりなら何もしない (文書内アンカー)
  - `javascript:` / `data:` / `mailto:` などは `preventDefault` して無視
  - それ以外は `preventDefault` し、port があれば `{ type: "ark:diagram-open-link", href }` を送る。
    port が無い (init 前) ときも遷移はさせない
  - 修飾キー (Ctrl / Meta / Shift / 中クリック) も同じ扱い (新しいタブで開けるかは親が決める)
- 注入順: `injectCsp(...)` の後、doc は編集層とコメント層の前、graph はハーネスとコメント層の前

### 4.2 親側 (`packages/web/src/components/DiagramPane.tsx`)

- port の `onmessage` に `handleDiagramOpenLinkMessage(event.data, worktreeRelativeDir, post)` を足す
  (pinch と同じく純関数として export し、node 環境でテストする)
- `parseDiagramLinkHref(href, boardDir)`:
  - `http:` / `https:` → `{ kind: "url", url }`
  - 相対パス → `#L<n>` / `#L<a>-L<b>` を切り出し、パスはボードのあるディレクトリ基準ではなく
    **worktree 基準**で解釈する (`src/foo.ts` と書けば worktree 直下の `src/foo.ts`)。
    `..` を含む、`/` 始まり、空文字は拒否 (`useTerminalLinkInjection.isAllowedFilePath` と同じ規則。
    ただし `/tmp/` と HTML 絶対パスの特例は不要なので持たない)
  - それ以外 (不明なスキーム) → `null`
- `post` は `window.postMessage(message, window.location.origin)`。`ark:open-file` は
  `{ type, path, line }` (line は開始行か null)、`ark:open-url` は `{ type, url }`

### 4.3 規約 (`.claude/skills/diagram-authoring/SKILL.md`)

- 「守ること」の並びに **コードを指す語はリンクにする** を足す: 書式、worktree 相対、行の付け方、
  外部 URL はそのまま、`#` 始まりは文書内アンカー
- 新しい節 **変更レビュー文書** を足す:
  1. what / why
  2. 要件 (利用者の言葉のまま。無ければ節ごと省く)
  3. 設計: 図は 1 枚。時間軸で参加者がやり取りするなら `flow`、分岐・再試行・状態遷移なら `state`、
     データの形と読み書きの変更なら `er`、境界や責務の移動なら `context-map`。小さな変更で設計が
     自明なら節ごと省く
  4. 実装: エントリポイントから読む順に。関数名・ファイル名はリンクにする
  5. 書き終えたら通読し、矛盾と裏の取れていない主張を消す
  - 節は `kind: "section"`、本文は `paragraph` / `list` / `code` / `figure` で書く (既存の語彙のまま)
- 見本 `_examples/change-review.diagram.html` を 1 つ置く (架空の小さな変更を題材にし、リンクの
  書き方を含める)。既存の契約テスト (`diagram-authoring-contract.test.ts`) に文言と見本の妥当性を足す
- 契約テストの制約を守る: `docs/diagrams` や `.claude/diagrams` のディレクトリ名を規約本文に書かない、
  `doc` を表の行にしない

### 4.4 エラー

| 状況 | 見え方 |
|---|---|
| ファイルが無い | 既存の `file:content` の `error` がビューアに出る (変更なし) |
| `..` や絶対パス | 親が無視する (何も起きない)。規約で書き方を示す |
| port 未接続でクリック | 遷移だけ止める。接続後に押し直せば開く |
| 不明なスキーム | 遷移を止めて無視 |

## 5. テスト

- `diagram-link-layer.test.ts`: 注入が 1 回だけ / `</body>` 直前 / marker で二重注入しない。
  スクリプトは `node:vm` で最小の DOM スタブ (`document.addEventListener`, `closest`, `preventDefault`)
  を与えて、相対パス・http・`#` アンカー・`javascript:` の 4 通りで「preventDefault したか」
  「port に何を送ったか」を確認する (コメント層のテストと同じ方式)
- `DiagramPane.test.ts`: `parseDiagramLinkHref` と `handleDiagramOpenLinkMessage` を node 環境で
  (相対 + 行 / 相対 + 範囲 / http / `..` 拒否 / 絶対パス拒否 / 不明スキーム)
- `diagram-authoring-contract.test.ts`: 新しい節の見出しと語、見本ボードがアンカー・著者・model の
  検証を通ること
- 実機: 見本ボードを開いてリンクを押し、右ペインにファイルが該当行ハイライトで開くこと、
  コメント層が切れない (「遷移しようとした」のエラーが出ない) こと、`https` リンクが新しいタブで開くこと

## 6. 範囲外

- 行範囲の終了行までのハイライト (`FileViewerPane` の拡張)
- コード側からボードへの逆引き (この行はどの図で説明されているか)
- 意味的 diff、コミットへのセッション id、トレースの保存
- モバイルでのファイルビューア動作は端末リンクと同じ扱い (専用の対応はしない)
