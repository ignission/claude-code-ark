# ボード更新の文脈経済 設計

## 目的

図解ボードの「直し」を、ボード1枚分ではなく1行分のコストで回せるようにする。

出発点は「Confluence のようにリアルタイムで編集したい」という要望だった。掘った結果、
求められていたのは共同編集そのものではなく、**小さな直しが小さく済むこと**だった。
いま label を1つ直すのにボード全体を書き直しており、そこが鬱陶しさの実体である。

## 測ったこと

新しい機構を足す前に、いまどこに文脈が消えているかを実測した
( `.claude/rules/context-engineering.md` §1 )。

### 送信文は既に小さい

`diagram:submit` はモデル差分を意味の文にして1行ずつ送る。

```
図を編集しました（.claude/diagrams/foo.diagram.html）:
- Order を Purchase Order に改名
- Order に cancelled_at を追加
```

`diagram:comment:send` は1行。

```
図のコメント（…） 対象: Order / 引用: 「…」 / コメント: 「…」 / 他に未解決 3 件（board_comments で全件取得できる）
```

典型で200文字前後。`anchorQuote` は256文字、`body` は4,000文字、`anchorText` は80文字で
切ってある。**送信のデータ構造に無駄は無い。ここは変えない。**

### 消えているのは書き戻し

全 transcript の `.diagram.html` へのツール呼び出しを走査した実測値。

| | 回数 | 文字数 |
| --- | --- | --- |
| 新規作成 ( Write ) | 15 | 206,883 ( 平均 13,792 ) |
| **更新 ( Write )** | **8** | **97,021 ( 平均 12,127 )** |
| 部分編集 ( Edit ) | 15 | 平均 1,054 |
| Read | 2 | — |

新規作成の文字数は中身そのものなので避けられない。**問題は更新の8回**で、ノード1個を
直すためにボード全体12,127文字を書き直している。送信文の約60倍。

Read が2回しかないのは、Claude が自分で書いたボードを文脈に持ったまま書き戻している
ため。裏を返すと、**人間がボードを編集した後は Claude の手元が古い**。

### 投影はファイルに焼き付いていない

稼働中のボード2枚を実測した。

| ファイル | 全体 | モデル | 投影+その他 |
| --- | --- | --- | --- |
| `aeo-2026-09-todo.diagram.html` | 3,340 | 3,150 | 188 |
| `aeo-2026-09-backlog.diagram.html` | 3,279 | 3,088 | 189 |

投影は189文字しかない ( doctype と head と script タグのみ )。組み込みレンダラが配信時に
投影を作るため、ファイルにはモデルだけが残る。**モデルだけ差し替えれば図として成立する。**
これが本設計が成り立つ根拠である。

## 設計

### 変更1: 送信文に `anchorId` を載せる

`buildDiagramCommentMessage` ( `diagram-comments-handler.ts` ) が組む文に、thread が既に
持っている `anchorId` を加える。`anchorId` は `diagram-comments.ts:623` で
`model.nodes` の id として検証済みなので、そのまま node id として使える。

```
図のコメント（…） 対象: Order [order] / 引用: 「…」 / コメント: 「…」
```

これが無いと Claude は node の id を知らず、id を知らなければ部分更新のしようがない。
**変更3の前提**であり、単独では効かない。

あわせて、送るスレッドが1件だけのときは `他に未解決 N 件（board_comments で全件取得できる）`
の誘い文句を落とす。要らないツール呼び出しを1回増やしている。

### 変更2: `board_comments` の返却を行テキストへ

いまは `JSON.stringify(result)` をそのまま返している。スレッド1件につき1行のテキストに
変える。

```
#t3 [order] 対象:Order 引用:「…」 コメント:「…」 返信2
```

スレッド数が増えたときだけ効く小さい改善。JSON の構造が要るケースは無い
( 受け手は Claude であって機械ではない )。

### 変更3: `board_patch` MCP ツール

id 指定でモデルの一部だけを差し替えるツールを足す。Claude の文脈に入るのは ops の
数行だけで、ボード全文は入口にも出口にも現れない。

```
board_patch(path, ops: [
  { "op": "set-node",   "id": "order", "label": "Purchase Order", "kind": "root" },
  { "op": "set-field",  "node": "order", "id": "order_status", "label": "status" },
  { "op": "add-node",   "id": "refund", "label": "Refund", "kind": "entity" },
  { "op": "add-edge",   "id": "e9", "from": "order", "to": "refund" },
  { "op": "delete-node","id": "legacy" }
])
```

**op の語彙**: `add-node` / `set-node` / `delete-node` / `add-field` / `set-field` /
`delete-field` / `add-edge` / `set-edge` / `delete-edge` / `add-group` / `set-group` /
`delete-group`。既存のコア語彙 ( node / edge / field / group / label / kind ) だけを
扱い、図種固有の意味は従来どおり `ext` に入れる。新しい語彙は作らない。

**適用の流れ**: サーバーがファイルを読み、モデルへ ops を当て、`replaceModelBlock` し、
既存の検証 ( `parseDiagramModel` / `validateDiagramDocAnchors` /
`validateDiagramDocAuthorship` ) を通して書く。`saveDiagramEdit` の検証境界を再利用し、
新しい保存経路を作らない。

**all-or-nothing**: 1つでも op が失敗したら ( 存在しない id を指す、適用後にモデルが
検証を通らない ) 1つも適用せず、失敗した op の位置と理由を返す。部分適用はボードの
状態が読めなくなる。

**返却はモデル全文を返さない**。適用した op 数と、適用後の node / edge / group 数だけ
返す。モデルを返すと文脈に戻ってしまい、節約そのものが消える。

**参照整合性**: `delete-node` は incident edge と `groups[].nodes` の参照も同期除去する
( #243 の既存契約と同じ。これをやらないと保存時に422で弾かれる )。

**直列化**: `board_patch` はサーバー内の read-modify-write なので、人間の autosave と
競合しうる。同一 absPath で直列化する。

**還流 baseline を進める**: patch 成功時に `rememberNotifiedModel(key, patchedModel)` を
呼ぶ。

**手書き投影のボードには使えない**。モデルを差し替えても投影が古いままになるため、
`type` が組み込み ( `er` / `event-storming` / `flow` / `state` / `context-map` ) でない、
かつ `data-model-id` を持つ投影がファイルにあるボードは拒否し、理由を返す。実測した
稼働ボードには1本も該当が無い。

### おまけで直るもの: 還流のエコー

いま Claude が外から図を書き換えても還流の baseline は進まない
( `index.ts:765` と `:2001` は `if (!has)` 、進めるのは submit の `:2078` だけ )。
そのため人間が次に「変更を送る」と、**Claude 自身の変更が差分に混ざって返ってくる**。

`board_patch` はサーバーが書き手を知っているので baseline を進められ、このエコーが消える。
Claude が Write / Edit で直接書いた場合は従来どおりエコーが残るが、`board_patch` を
使う限り起きない。

## 境界 / 非ゴール

- **人間の 編集 → 送信 の流れは変えない**。「変更を送る」ボタンは残す。人間の編集を
  自動で会話へ流し込まない ( `context-engineering.md` §4 )
- **コメント機能は残す**。コメント → 送信の2段も残す。減らすのは送信後のコストである
- **共同編集 ( CRDT / OT ) はやらない**。ハーネスの注入サイズ枠 ( 残り約12KB ) に入らず、
  かつ Claude の書き込みはツール呼び出し単位なので文字単位の同期には意味が無い
- **`diagram:updated` の iframe 貼り直しは変えない**。今回の対象外
- **Claude へ何も注入しない**。`board_patch` は Claude が呼ぶツールであって、ハーネスから
  Claude の文脈へ差し込む機構ではない

## 検証

- `anchorId` が送信文に載り、thread に `anchorId` が無い旧形式 sidecar でも文が壊れない
- 未解決が1件のときに `board_comments で全件取得できる` が出ない
- `board_patch` の各 op がモデルへ正しく当たる ( node / field / edge / group の add / set / delete )
- 存在しない id を指す op で、**ファイルが1バイトも変わらない**
- `delete-node` で incident edge と `groups[].nodes` 参照が同期除去される
- 適用後に `parseDiagramModel` を通らない ops が、書き込み前に弾かれる
- 手書き投影のボードへの `board_patch` が拒否される
- `board_patch` の返却にモデル全文が含まれない
- patch 成功後に「変更を送る」を押しても、patch した内容が差分として返らない ( エコー解消 )
- 同一ファイルへの並行 patch が直列化され、片方の変更が失われない

## 段階

| Phase | 内容 | 単独で効くこと |
| --- | --- | --- |
| 1 | `anchorId` の搭載 + 誘い文句の削除 | Claude が id を知る ( 2 の前提 ) |
| 2 | `board_patch` | 更新 12,127文字 → 150文字程度 |
| 3 | `board_comments` の行テキスト化 | スレッドが増えたときの返却を圧縮 |

順序は 1 → 2 → 3。1 は数行、2 が本体、3 は独立して出せる。
