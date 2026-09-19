# doc 型ボードを人間が直接書けるようにする 設計

## 目的

doc 型ボードの本文を、人間がその場で直接編集できるようにする。

出発点は「Confluence のリアルタイム文章みたいに編集したい」という要望だった。掘り下げた
結果、求められていたのは共同編集 ( CRDT / OT ) ではなく、**doc 型ボードが read only で
あることそのもの**だった。本文の言い回しを1つ直すのに、コメントを書いて、送信して、
Claude に2万文字超を全文書き直させている。「コメントして送信が鬱陶しい」と「文脈を食う」は
同じ1つの問題で、原因は doc が書けないことにある。

## 測ったこと

新しい機構を足す前に、いまどこが詰まっているかを実測した
( `.claude/rules/context-engineering.md` §1 )。

### doc 型は仕様として read only

`diagram-reader.ts:137` がすべてで、`doc` にだけ編集ハーネスが載らない。

```js
model.model.type === "doc"
  ? injectDiagramCommentLayer(projected, "doc")                   // コメント層だけ
  : injectDiagramCommentLayer(injectHarness(projected), "graph")  // 編集ハーネス + コメント層
```

graph 側 ( `er` / `flow` / `state` / `event-storming` / `context-map` ほか ) は label の
インライン編集・ドラッグ・kind 変更・edge 増減ができる。doc だけができない。

### 実運用のボードは doc が主役

`_examples` と `_archive` を除いた実物。

| ボード | type | node | 文字数 ( UTF-8 の bytes ではなく文字 ) |
| --- | --- | --- | --- |
| `orista-app-ios/stripe-native-overview` | **doc** | 66 | **26,504** |
| `shomatan/note/nisa-yutai-stocks` | **doc** | 34 | **19,784** |
| `claude-code-manager/aeo-2026-09-todo` | flow | 16 | 3,340 |
| `claude-code-manager/aeo-2026-09-backlog` | backlog | 10 | 3,279 |

read only なのが、一番大きく一番よく使うボードである。

### 書き戻しのコスト

全 transcript の `.diagram.html` へのツール呼び出しを走査した実測値。

| | 回数 | 文字数 |
| --- | --- | --- |
| 新規作成 ( Write ) | 15 | 206,883 ( 平均 13,792 ) |
| **更新 ( Write )** | **8** | **97,021 ( 平均 12,127 )** |
| 部分編集 ( Edit ) | 15 | 平均 1,054 |
| Read | 2 | — |

新規作成の文字数は中身そのものなので避けられない。**問題は更新の8回**で、その大半が doc
ボードである ( `stripe-native-overview` 2回、`chapter7-decision-drift` 4回 )。1ブロックを
直すためにボード全体を書き直している。

Read が2回しかないのは、Claude が自分で書いたボードを文脈に持ったまま書き戻しているため。
**「変更を送る」で人間の編集を Claude へ知らせる経路は、実質的に使われていない。**

### 送信文は既に小さい

`diagram:submit` はモデル差分を意味の文にして1行ずつ、`diagram:comment:send` は1行。
典型で200文字前後。`anchorQuote` は256文字、`body` は4,000文字、`anchorText` は80文字で
切ってある。**送信のデータ構造に無駄は無い。ここは変えない。**

### 制約として確かめたこと

- `validateDiagramDocAnchors` は **`data-ark-id` と model node の1対1を強制する**。
  node id ごとにちょうど1個。人間がブロックを増減したら model 側も同時に動かさないと422
- `validateDiagramDocAuthorship` は `data-ark-author` を `human` / `claude` の2値に限り、
  `data-ark-id` を持つ要素にだけ許す。`claude` → `human` への変更は禁じていない
- ハーネスのサイズ guard ( `diagram-harness.test.ts:187` ) は `injectHarness` の出力だけを
  128KiB で測る。コメント層は別勘定 ( 同ファイル :295 )。**doc 編集層も別の注入文字列に
  すれば graph の残り枠12KBを食わない**
- `buildSubmissionHtml` は送信 HTML から `[data-ark-harness-ui]` を除去する
  ( `diagram-harness.ts:3208` )。コメント層はこの印を持つので焼き付かない。doc 編集層も
  同じ印と同じ除去を持てばよい

## 設計

### A. doc 編集層 ( 人間側・本体 )

`injectDiagramDocEditor` を新設する。**`diagram-harness.ts` には触らない。**

**モード切替は置かない。本文は常に編集できる。**

当初は「読む / 書く」の切替を置く設計にしていた。doc のコメント anchor がテキスト選択で
作られるため `contenteditable` と衝突すると考えたからだが、**これは誤りだった**。
コメント層には既に「選択したら浮くボタン」がある ( `diagram-comment-layer.ts:828` の
`updateSelectionAdd` が選択範囲の rect にボタンを置き、`:838` のクリックで composer が
開く )。選択がそのままコメントになるわけではないので、衝突しない。Notion や
Google Docs と同じ形が既に組まれている。

常時編集可にしたうえで起きること。

- `[data-ark-id]` を持つブロックを `contenteditable="true"` にする
- 人間が触ったブロックへ **`data-ark-author="human"` を自動で付ける**。#319 でこの属性を
  作った理由そのものであり、人間が書いた本文が初めて機械的に `human` になる。
  ただし **`human` の意味が変わる**。#319 では Claude が人間の決定を転記したときだけ付ける
  規約だったので `human` = 「人間の決定」だったが、直接編集では
  `human` = 「人間がその本文を打った」になる。誤字を1つ直しただけの段落も `human` になる。
  検証できる事実 ( 誰が打ったか ) を記す方が属性として健全なので自動付与を採るが、
  **読み手側の規約を3箇所で言い換える**: `CLAUDE.md` の「図解ボード doc 本文の書き手」節、
  `diagram-authoring` skill、SessionStart hook の context。
  「`human` が付いたブロックだけを人間の決定として扱う」→
  「`human` が付いたブロックは人間が書いた本文である。決定かどうかは本文が述べる」
- 新しいブロックを作ったら id を採番し、model に node を足す。消したら node も消す。
  `validateDiagramDocAnchors` の1対1制約を満たすため、これをやらないと保存が422になる
- 折り畳まれた選択 ( キャレットだけ ) では浮くボタンを出さない。入力中に出ると邪魔になる
- 保存は既存の `diagram:autosave` / `diagram:submit` に乗せる。新しい保存経路を作らない
- 送信 HTML から `[data-ark-harness-ui]` を除く ( graph と同型 )

**`label` 抜粋はサーバー側で本文から再生成する。** doc の model `label` は検索と一覧用の
60〜80文字の抜粋である。人間が本文を直すと抜粋がずれ、`board_comments` が返す `anchorText`
が嘘になる。保存経路で1回作り直す。

### B. `board_patch` の `set-block` ( Claude 側・同じ問題の裏側 )

doc の正準 source は本文 HTML なので、モデルを差し替えても意味が無い。ブロック単位で
差し替えるツールを足す。

```
board_patch(path, ops: [
  { "op": "set-block", "id": "s6-p1",
    "html": "<p data-ark-id=\"s6-p1\" data-ark-author=\"claude\">…</p>" },
  { "op": "insert-block", "after": "s6-p1", "id": "s6-p1b",
    "html": "<p data-ark-id=\"s6-p1b\" data-ark-author=\"claude\">…</p>" },
  { "op": "delete-block", "id": "s6-p2" }
])
```

`insert-block` は model に node を足し、`delete-block` は model から node を消す
( `validateDiagramDocAnchors` の1対1制約。これが無いと Claude は段落を1つ足すだけで
全文 Write に落ちる )。

サーバーが該当 `data-ark-id` の要素だけ差し替え、`validateDiagramDocAnchors` と
`validateDiagramDocAuthorship` を再実行して書く。26,504文字 → 300文字程度。

**返却にモデルも本文も返さない**。適用した op 数だけ返す。返すと文脈に戻って節約が消える。

**all-or-nothing**。1つでも失敗したら1つも適用せず、失敗した op の位置と理由を返す。

**直列化する**。人間の autosave と競合しうるので、同一 absPath で直列化する。

読み取り側の `board_read(path, ids)` を対で足す ( 後述 )。書く口だけあって読む口が無いと、文脈を持たない Claude が結局は全文 Read に落ちる。

### C. 送信文に `anchorId` を載せる

`buildDiagramCommentMessage` の文へ、thread が既に持つ `anchorId` を加える
( `diagram-comments.ts:623` で `model.nodes` の id として検証済み )。

```
図のコメント（…） 対象: 6.2 決定 [s6-p1] / 引用: 「…」 / コメント: 「…」
```

これが無いと Claude はブロックの id を知らず、`set-block` を呼べない。**B の前提。**
あわせて、送るスレッドが1件のときは「board_comments で全件取得できる」の誘い文句を落とす
( 要らないツール呼び出しを1回増やしている )。

### D. `board_patch` のモデル ops ( graph 向け・二次 )

graph 型は投影がサーバー生成でファイルに焼き付かないため ( 実測で投影は189文字 )、
モデルだけ差し替えれば成立する。

`add-node` / `set-node` / `delete-node` / `add-field` / `set-field` / `delete-field` /
`add-edge` / `set-edge` / `delete-edge` / `add-group` / `set-group` / `delete-group`。
既存のコア語彙だけを扱い、図種固有の意味は従来どおり `ext` に入れる。

`delete-node` は incident edge と `groups[].nodes` の参照も同期除去する ( #243 の既存契約 )。

### E. `board_comments` の返却を行テキストへ

いまは `JSON.stringify(result)` をそのまま返している。1スレッド1行にする。
スレッド数が増えたときだけ効く小さい改善。

### F. 未知 type のボードが真っ白になるのを直す

`injectBuiltinProjection` は組み込みでない type に何もせず返す ( `diagram-builtin.ts:236` )。
`aeo-2026-09-backlog.diagram.html` は `type: "backlog"` で手書き投影も無いため、
**node 10個と group 4個が丸ごと描画されていない**。モデルから汎用 graph 投影を生成する
フォールバックを足す ( `renderNode` / `renderGroup` は既にあるので、CSS を既定値にして
type 判定を外すだけ )。

## doc の本文編集を Claude へどう渡すか

人間が本文を直したら、**「変更を送る」で Claude へ還流する**。編集したまま伝えないと、
Claude が次に動くときに人間の決定を知らず、逆方向へ進む。

### 渡すのは「アンカー + 書き換え後のブロック本文」

差分表現 ( 「A を B に変えた」 ) ではなく、書き換えた後のブロックの本文そのものを送る。

```
図の本文を編集しました（.claude/diagrams/stripe-native-overview.diagram.html）:
- [s6-p2] 決定: Payment Element ではなく Card Element で進める。理由は既存の…
- [s7-t1-r3] 見積もりを 3人日 から 5人日 へ
（いずれも human として記録済み）
```

実測した66ブロックの doc ボードで、**ブロック本文は中央値102文字・平均194文字**
( ファイル全体は26,504文字 )。1ブロックは全体の260分の1で、3ブロック直しても約580文字。

- **差分表現にしない**: 「A を B に変えた」は Claude が元の文を持っていないと復元できない。
  ブロック本文なら単独で意味が立ち、中央値102文字ならコストもほぼ変わらない
- **全文にしない**: Claude は自分が書いた本文を文脈に持っている。Read が2回しかないのは
  読み直す必要が無いからで、ブロックを渡せば手元の全文へ当てられる。全文を渡すのは
  既に持っているものをもう一度渡すことになる
- **`human` が付いていることを明記する**: #319 の規約は直接編集の追加で言い換わり、
  今は「`data-ark-author="human"` は人間が手を入れた印であり、決定かどうかは本文の
  記述で判断する」( 101-108行 )。送信文でそう言っておけば、別セッションの
  エージェントの出力と取り違えない

### 送る前に無害化する

ブロック本文は外部入力である ( 人間のインライン編集、PR で持ち込まれた `.diagram.html` )。
`diagram-diff.ts` が label に対してやっているのと同じ理由で、tmux へリテラル送出する前に
落とす。

- HTML タグを除去して本文テキストにする
- 制御文字と改行を除去して1行へ畳む ( `oneLine` と同じ扱い )
- 1ブロックあたり300文字で切り、超えたら `…` を付ける ( 実測の中央値は102文字、
  最大は966文字 )
- 変更ブロックが10個を超えたら本文は先頭10件までにし、残りは id の列挙と
  「`board_read` で引ける」の1行に畳む

エスケープではなく除去にするのは `diagram-diff.ts` と同じ判断による。受け手は tmux 越しの
対話版 Claude であり、エスケープ記法を機械的に解釈する文脈ではない。

### 足りないときのために `board_read` を足す

`/clear` の後や別セッションでは Claude は本文を持っていない。「全文か差分か」の二択に
しないため、ブロック id を指定して必要な分だけ読む口を開ける。`set-block` ( 書く ) の対。

```
board_read(path, ids: ["s6-p1", "s6-p2", "s6-t1"])
```

返すのは**ブロックの HTML** ( 本文テキストではない )。`set-block` がそのまま受け取れる形に
して、読んで直して書き戻す往復を閉じる。

- 送信は常にブロック本文 ( 安い )
- 前後の文脈が要るときだけ Claude が `board_read` で節単位を引く
- 全文 Read は最後の手段として残る

### どのブロックが変わったかをどう知るか

サーバー側に **doc 用の baseline ( `id → ブロック本文` ) を持つ**。`lastNotifiedModels` は
モデルしか持っておらず、doc の本文変更を検出できない。

- 既存の `lastNotifiedModels` と同じ寿命・同じ FIFO 上限で、`lastNotifiedDocBodies` を置く
- 「変更を送る」で、保存後の本文と baseline を id 単位で比べ、変わった id だけを送る
- 送信が成功したら baseline を進める ( 失敗したら進めない。既存の submit と同じ )

クライアントから `touchedIds` を受け取る案は採らない。編集層が申告した id を信じると、
外から書き換えられた本文や、申告漏れをそのまま見逃す。サーバーが実物を比べる。

### doc ではモデル差分を送らない

A の設計で `label` 抜粋を本文から再生成するため、本文を1文字直すだけで model の `label` が
変わる。このまま `describeModelDiff` を通すと
`[s6-p1] を 「新しい抜粋…」 に改名` という行が本文の還流と二重に出る。

**`model.type === "doc"` のときは `describeModelDiff` を呼ばず、ブロック本文の経路だけを
使う。** node の増減 ( ブロックの追加・削除 ) は本文の経路側で「ブロックを追加 / 削除」と
して表す。

### 送るのは人間が押したときだけ

自動では送らない ( `context-engineering.md` §4 )。既存の「変更を送る」と同じで、
人間の 編集 → 送信 の流れは変えない。

## 境界 / 非ゴール

- **共同編集 ( CRDT / OT ) はやらない**。Claude の書き込みはツール呼び出し単位なので
  文字単位の同期に意味が無い。ハーネスの注入枠にも入らない
- **`diagram:updated` の iframe 貼り直しは変えない**。今回の対象外
- **コメント機能は残す**。コメント → 送信の2段も残す。減らすのは「そもそもコメントする
  しかない」状況のほう
- **Claude へ何も注入しない**。`board_patch` は Claude が呼ぶツールであって、ハーネスから
  Claude の文脈へ差し込む機構ではない
- **graph ハーネスの発見性 ( 常時クロムが無く read only に見える ) は別件**とする

## 検証

- doc ボードに編集層が注入され、graph ボードには注入されない
- 本文が常に `contenteditable` で、かつ範囲選択でコメントの浮くボタンが出る ( 共存する )
- キャレットだけの折り畳まれた選択では浮くボタンが出ない
- 人間が触ったブロックに `data-ark-author="human"` が付き、保存が422にならない
- 新しいブロックを作ると id が採番され model に node が増える。消すと node も減る。
  どちらも `validateDiagramDocAnchors` を通る
- 保存後の `label` が本文の先頭60〜80文字と一致する
- 送信 HTML に編集層の DOM が焼き付かない
- doc 編集層の注入後サイズが独自 guard を超えない。**graph ハーネスの128KiB guard が
  変わらない**
- `set-block` が該当ブロックだけを差し替え、他のブロックのバイト列が変わらない
- `set-block` の返却に本文もモデルも含まれない
- 存在しない id を指す op で、ファイルが1バイトも変わらない
- 未知 type のボードが汎用投影で描画される
- 人間が本文を直して「変更を送る」を押すと、変更したブロックの id と本文が送られ、
  変更していないブロックは送られない
- 変更ブロックが10個を超えたとき、本文が10件で打ち切られ残りが id の列挙になる
- `board_read` が指定した id のブロックだけを返し、他のブロックを返さない
- `board_read` の返却を `set-block` へそのまま渡して往復できる
- `insert-block` で model に node が増え、`delete-block` で減る。どちらも
  `validateDiagramDocAnchors` を通る
- 送信文でブロック本文の HTML タグ・改行・制御文字が落ち、300文字で切られる
- doc ボードの送信に `describeModelDiff` 由来の「改名」行が混ざらない
- baseline が進むのは送信が成功したときだけで、失敗したら次回も同じブロックが送られる

## 段階

| Phase | 内容 | 単独で効くこと |
| --- | --- | --- |
| 1 | doc 編集層 + 本文の還流 ( A ) | doc が書けて、直した意図が Claude へ届く |
| 2 | `board_patch` の block ops と `board_read` ( B ) | 更新 26,504文字 → 300文字 |
| 3 | 送信文の `anchorId` ( C ) | Claude が id を知り、2 を実際に使える |
| 4 | 未知 type の描画 ( F ) | backlog ボードが見えるようになる |
| 5 | モデル ops ( D ) と `board_comments` ( E ) | graph 側の更新コストと返却を圧縮 |

**還流は Phase 1 に含める。** 書けるようになっても伝わらなければ、人間が直した決定を
知らない Claude が逆方向へ進む。分けて出荷しない。

2 と 3 は対で、片方だけでは効かない。4 は独立した不具合修正。
