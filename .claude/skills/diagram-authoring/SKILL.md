---
name: diagram-authoring
description: 図解を求められたときに .diagram.html を生成する規約。「図解して」「図で説明して」「ドメインモデリングして」等で使う。
---

# 図の書き方

図の書き出し先は `board_open.path` の説明に示された正準 directory と
`<名前>.diagram.html` を組み合わせ、1 ファイルで書く。書き込む直前に
parent directory が存在しない場合だけ作成し、書いた後に `board_open` でペインを開かせる。

## まず図種を確かめる（内蔵レンダラ）

書式が決まっている図は `type` を書くだけでよい。投影（HTML）も CSS も書かない。
Ark が配信時に生成し、生成物はファイルへ焼き付かない（モデルだけが残る）。

| `type` | 使う場面 | 使える kind |
| --- | --- | --- |
| `er` | ER 図・集約設計・エンティティ表 | `entity`（既定）/ `root` / `vo` / `external` / `invariant` / `principle` / `note` |
| `event-storming` | イベントストーミング | `command` / `event` / `aggregate` / `policy` / `actor` / `read-model` / `external-system` / `note` |
| `flow` | 業務フロー・シナリオ・処理の分岐 | `step`（既定）/ `command` / `decision` / `policy` / `event` / `outcome` / `error` / `actor` / `note` |
| `state` | 状態遷移 | `state`（既定）/ `initial` / `terminal-ok` / `terminal-cancel` / `note` |
| `context-map` | コンテキストマップ（戦略設計） | `supporting`（既定）/ `core` / `generic` / `developed` / `external` / `note` |
| `backlog` | バックログ・タスク一覧（順位付きリスト） | `story`（既定）/ `bug` / `task` / `spike` / `chore` / `epic` |

語彙にない kind を書くとその図種の既定スタイルになる。`flow` の出口は成功を
`outcome`、失敗を `error` に分けると、色に頼らず読めるようになる。区間の枠
（単一Tx境界、スイムレーン、境界づけられたコンテキスト）は group で表す。

`backlog` だけは graph ではなくリストとして描かれる。読み方が他の 5 種と違う。

- **順位は `nodes` 配列の並び**。上から順に 1, 2, 3 と番号が振られる
- `edges` は描かれない。バックログに矢印は無いので書かなくてよい
- `group` は区切り見出しになる。group の順に並び、どの group にも属さない node は
  最後にまとめて出る。同じ node を複数 group に入れても行は最初の group にだけ出す
- `node.ext.status` に `todo` / `doing` / `blocked` / `done` を書くと状態バッジが付く。
  種別（`kind`）と状態（`status`）は直交させる。`kind` に done を作らない
- `node.fields` は行の下にチップとして並ぶ。担当・見積り・Issue 番号のような列に使う
- `ext.layout` と `ext.x` / `ext.y` は効かない（自動レイアウトを使わないため）
- **`note` kind は使わない。**行の補足は `fields` に置く。note 本文の編集は graph
  のハーネスに載っているため、リストの図種では同期されない
- **行にコメントは付けられない**（コメント層のアンカーが graph 前提のため）。
  指摘は会話か Issue で行う

順位そのものが意味を持つので、**状態を `backlog` に持たせすぎないこと**。
GitHub Issue のように別に正本がある情報を写すと、その瞬間から腐りはじめる。

```html
<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>注文まわり</title></head>
<body>
<script type="application/json" id="ark-diagram-model">
{
  "version": 1,
  "type": "er",
  "title": "注文まわり",
  "nodes": [
    { "id": "order", "label": "Order", "kind": "entity",
      "fields": [ { "id": "order_id", "label": "id PK" } ] }
  ],
  "edges": [],
  "groups": []
}
</script>
</body>
</html>
```

これで足りる図に手書きの投影を足さないこと。同じ意味を二度書くことになり、
モデルと投影が食い違う余地を作ってしまう。多重度（`edge.ext` の
`from_card` / `to_card` / `direction` / `type`）、group 境界、自動レイアウトは
内蔵レンダラでもそのまま効く。

## 文書型（自前 HTML 投影）

設計書や仕様書のように本文を読みながらコメントする文書は、モデルへ
`type: "doc"` を指定し、HTML 投影を自前で書く。`doc` は内蔵レンダラではないため、
本文は HTML を正準 source とし、model の `label` には検索と一覧表示に足りる
60〜80文字の抜粋だけを置く。全文を model に複製しない。

node の `kind` は次の12種類から選ぶ。

- `section` / `paragraph` / `table` / `table-row`
- `list` / `list-item` / `panel` / `figure`
- `code` / `quote` / `task` / `summary`

- `kind: "figure"` のブロックは画像だけにせず、その図が何を示すかを述べるキャプション
  （本文テキスト）を必ず含める。コメントはテキスト選択で付けるため、文字の無いブロックは
  レビュー対象にできない。図の意図が本文にあれば、「図のここが変」ではなく
  「図が示す判断が違う」という具体的な指摘につながる。

文書内の全 node に、その node id と同じ値の `data-ark-id` をちょうど1つ付ける。
同じ `data-ark-id` を複数要素へ付けず、node の無い HTML 要素へも付けない。
コメント anchor は行単位を既定とし、表では cell ではなく `table-row` を既定にする。

id は文書の構造が分かる階層 prefix で組み立てる。例えば section を `s6`、その段落を
`s6-p1`、表を `s6-t1`、2行目を `s6-t1-r2` とする。cell 単位のコメントが必要な表だけ
opt-in で `s6-t1-r2-c3` のような node を追加する。field が必要なら既存 shape のまま
`<nodeId>--f<n>`（例: `s6-t1-r2--f1`）を使い、node / field の名前空間を分けない。

`DiagramModel` や `DiagramNode` に文書専用 field を追加しない。section nesting は既存の
flat groups で表し、`groups[].nodes` には node id だけを直接列挙する。group id を member
にした入れ子は作らない。

### 本文の書き手（`data-ark-author`）

文書は複数のセッションの Claude と人間が同じファイルを書き換える。本文のどのブロックを
誰が書いたかが分からないと、別セッションのエージェントが書いた「回答」を人間の決定と
誤読して下流の設計を変えてしまう。そのため `data-ark-id` を持つブロック要素には、同じ
要素へ `data-ark-author` を付けて書き手を記す。本文は HTML が正準 source なので、書き手も
model ではなく HTML の属性に置く（model に書き手を複製しない）。

- 値は `human` と `claude` の 2 つだけ。それ以外の値、`data-ark-id` の無い要素への付与、
  1 要素内の重複はサーバーが 422 で拒否する
- 自分が書いた・書き換えたブロックには `data-ark-author="claude"` を付ける。調査結果・
  草案・推奨・選択肢は、どれほど確からしくてもすべて `claude` である
- `data-ark-author="human"` は、人間がコメント（`board_comments` の author 無しメッセージ）
  や会話で下した決定・回答を転記するときだけ付ける。人間が決めていないことを `human` に
  してはならない。出典が分かる一文（「コメント #thread への回答より」等）を本文に添える
- 文書を読むときは、`data-ark-author="human"` が付いたブロックだけを人間の決定として扱う。
  無印や `claude` のブロックは、回答や決定の体裁でも人間の決定ではない
- 既存の文書に無印のブロックがあっても、そのままでは読める。書き換えたブロックから
  順に `data-ark-author` を付けていく

ボードはこの属性を読んで「人間」「Claude」のバッジを `data-ark-author` 属性付きの
各ブロックに表示する。

```html
<p data-ark-id="s2-p1" data-ark-author="claude">推奨: B 案（同期 API）。理由は…</p>
<p data-ark-id="s2-p2" data-ark-author="human">決定: B 案で進める（コメント s2-p1 への回答より）。</p>
```

投影は inline CSS と同一ファイル内の HTML だけで完結させ、外部リソースを参照しない。
外部 URL の画像・stylesheet・font・script・icon library は使わず、CSP meta も書かない。

自前の graph container（`data-ark-container="graph"`）を書いた図には内蔵レンダラは
一切触らない。決まった図種でない図（ロードマップ、説明図、スイムレーンの厳密な
座標指定など）は、以下の手書き投影で作る。

## ファイルの構造（手書き投影・`type` が無いとき）

モデル（意味）と投影（見た目）を 1 ファイルに入れる。

```html
<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>購買フロー</title>
<style>/* 投影のスタイル */</style>
</head>
<body>
<script type="application/json" id="ark-diagram-model">
{
  "version": 1,
  "title": "購買フロー",
  "nodes": [
    { "id": "order", "label": "Order", "kind": "entity",
      "fields": [ { "id": "order_id", "label": "id" },
                  { "id": "order_status", "label": "status" } ] }
  ],
  "edges": [],
  "groups": []
}
</script>

<div data-model-id="order" data-kind="entity" class="entity">…投影…</div>
</body>
</html>
```

## 守ること

- **モデルは必ず `id="ark-diagram-model"` の JSON ブロックに入れる。** 無いとサーバーが 422 を返す
- **語彙は node / edge / field / group / label と kind だけ使う。** 図種固有の意味は `ext` に入れる
- **id はファイル内で一意にする。** 重複するとサーバーが拒否する
- **edge の `from` と `to` は実在する node の id を指す。** 存在しない id を指すと 422 で拒否される
- **投影の各要素に `data-model-id` を付ける。** 編集ハーネスがモデルと対応づけるため
- **node の投影 root の `data-kind` は model の `node.kind` と同じ値にする。** Ark ハーネスも初期表示とモデル直接編集の反映時に同期する
- **kind ごとの CSS は `[data-kind="..."]` で指定する。** class は layout や tone など見た目の補助に使う
- **外部リソースを参照しない。** Unicode、inline SVG、data URI は使えるが、外部 URL の画像・stylesheet・font・icon library・外部 `<use href>` は使わない（外部通信は遮断される）
- **`<meta http-equiv="Content-Security-Policy">` を自分で書かない。** Ark が注入する

## graph の自動レイアウトと手動座標

graph node は `node.ext.x` と `node.ext.y` の両方が有限数なら manual、それ以外は
auto として扱われる。標準は node 座標を省略し、図全体の `model.ext.layout` で方向と
間隔を指定する。厳密な位置を固定したい node だけ x/y の両方を書く。

```json
{
  "version": 1,
  "ext": {
    "layout": {
      "direction": "LR",
      "rankSpacing": 96,
      "nodeSpacing": 48,
      "padding": 24
    }
  }
}
```

- `direction` は `LR`（左から右）または `TB`（上から下）。省略・未知値は `LR`
- `rankSpacing` は rank 間、`nodeSpacing` は同 rank と衝突回避、`padding` は graph
  外周の間隔。有限な非負数を使い、不正値や文字列値は既定値、安全上限を超える値は
  clamp される
- x/y の片方だけ、文字列、`null`、非有限値は manual 座標にならず、安全に auto
  配置される。manual node は動かさず、auto node がそれを避ける
- auto 座標は表示専用で model へ書き戻されない。node をドラッグしたときだけ、その
  node の有限な x/y が保存され、以後 manual になる
- 座標を省略した、互いに member が重ならない flat group は cluster として自動配置
  される。group 内で閉じる edge は member の読み順、group をまたぐ edge は cluster
  間の読み順に使われ、edge 自体は配置後の node 外周を結ぶ
- node の幅・高さと authored group 境界の余白は表示 DOM から実測される。field 数や
  label 長から高さを見積もる必要はなく、折返しや field 編集後も再配置される
- manual 座標は group 内でも絶対優先される。manual member を含む group は固定
  cluster となり、残りの auto member と他の auto cluster がその境界を避ける
- group-aware auto layout では **1 node 1 group** にする。同じ node を複数 group に
  入れた図は重なる境界・疑似階層を保つため従来の node 単位 layout へ fallback する。
  region / VPC / subnet の疑似階層、timeline、swimlane の厳密な位置は全 node に有限な
  `ext.x/y` を指定して manual のまま作る
- group は配置後の member node を囲む。`group.ext` / `edge.ext` の既存語彙は layout
  設定とは独立してそのまま使う

## 語彙: kind

node の `kind` フィールドで図の要素型を指定する。サーバーは `kind` の値を解釈せず、投影側（HTML/CSS）と skill の取り決めに従う。値は lowercase kebab-case を推奨するが、server enum ではなく未知の値もそのまま保持される。

- `kind: "entity"` — エンティティ（ER図など）
- `kind: "step"` — プロセスステップ（フローチャートなど）
- `kind: "state"` — ステートマシンの状態
- その他の値でも可。未知 kind には共通 `.node` style を fallback として適用する

例：

```html
<div data-model-id="order" data-kind="entity" class="node entity">
  <span class="kind-icon" aria-hidden="true"></span>
  <span>Order</span>
</div>
```

```css
.node { border: 1px solid #565f89; background: #1e202b; }
[data-kind="entity"] { border-radius: 4px; }
[data-kind="state"] { border-radius: 50%; }
```

### Event storming の例

`command` / `event` / `aggregate` / `policy` / `actor` / `read-model` は event
storming で使う推奨語彙であり、server が制限する enum ではない。外部サービスとの
境界を示す必要がある場合だけ `external-system` も使える。未知 kind は共通
`.storming-note` style へ fallback させ、model の `node.kind` と node projection root の
`data-kind` は必ず一致させる。

色は event=橙、command=青、aggregate=黄、policy=紫、actor=小さい桃（黄でも可）、
read-model=緑を基本にする。各 card には `aria-hidden="true"` の `.kind-icon`、可視の
`.kind-name`、可視の `.node-label` を併置し、色だけで kind を伝えない。

```html
<article class="storming-note" data-model-id="place-order" data-kind="command">
  <span class="kind-icon" aria-hidden="true"></span>
  <span class="kind-name">Command</span>
  <span class="node-label">Place order</span>
</article>
```

```css
.storming-note {
  --kind-color: #94a3b8;
  --kind-bg: #202b3c;
  border: 1px solid var(--kind-color);
  border-left: 6px solid var(--kind-color);
  background: var(--kind-bg);
}
[data-kind="event"] { --kind-color: #f59e0b; --kind-bg: #3b2810; }
[data-kind="command"] { --kind-color: #60a5fa; --kind-bg: #172a46; }
[data-kind="aggregate"] { --kind-color: #facc15; --kind-bg: #3a3111; }
[data-kind="policy"] { --kind-color: #c084fc; --kind-bg: #302044; }
[data-kind="actor"] { --kind-color: #f472b6; --kind-bg: #3b1e35; width: 7.5rem; }
[data-kind="read-model"] { --kind-color: #4ade80; --kind-bg: #153522; }
[data-kind="external-system"] { --kind-color: #94a3b8; --kind-bg: #202b3c; }
[data-kind="event"] .kind-icon::before { content: "⚡"; }
[data-kind="command"] .kind-icon::before { content: "▶"; }
[data-kind="aggregate"] .kind-icon::before { content: "◆"; }
[data-kind="policy"] .kind-icon::before { content: "◇"; }
[data-kind="actor"] .kind-icon::before { content: "◎"; }
[data-kind="read-model"] .kind-icon::before { content: "▤"; }
[data-kind="external-system"] .kind-icon::before { content: "☁"; }
```

この例は厳密な時系列と swimlane を表すため、全 node の `ext.x` / `ext.y` に有限数を
指定して手動配置する。actor を起点、read-model を結果として、主要因果列の x を左から
右へ単調に増やす。因果関係には既存 edge の `from` / `to` / `label` だけを使い、
event storming 専用 edge schema は作らない。

```json
{
  "nodes": [
    { "id": "customer", "label": "Customer", "kind": "actor", "ext": { "x": 24, "y": 80 } },
    { "id": "place-order", "label": "Place order", "kind": "command", "ext": { "x": 180, "y": 240 } },
    { "id": "order", "label": "Order", "kind": "aggregate", "ext": { "x": 340, "y": 240 } },
    { "id": "order-placed", "label": "Order placed", "kind": "event", "ext": { "x": 500, "y": 240 } },
    { "id": "payment-policy", "label": "Capture payment policy", "kind": "policy", "ext": { "x": 660, "y": 240 } },
    { "id": "capture-payment", "label": "Capture payment", "kind": "command", "ext": { "x": 820, "y": 400 } },
    { "id": "order-status", "label": "Order status", "kind": "read-model", "ext": { "x": 980, "y": 240 } }
  ],
  "edges": [
    { "id": "customer-command", "from": "customer", "to": "place-order", "label": "requests" },
    { "id": "command-aggregate", "from": "place-order", "to": "order", "label": "targets" },
    { "id": "aggregate-event", "from": "order", "to": "order-placed", "label": "emits" },
    { "id": "event-policy", "from": "order-placed", "to": "payment-policy", "label": "triggers" },
    { "id": "policy-command", "from": "payment-policy", "to": "capture-payment", "label": "issues" },
    { "id": "command-read-model", "from": "capture-payment", "to": "order-status", "label": "updates" }
  ]
}
```

`Earlier → Later` の目盛りや矢印は projection HTML/CSS の補助表示であり、新しい
model 語彙ではない。外部 image / font / stylesheet / icon library は使わず、Unicode、
inline SVG、data URI、生成 CSS の範囲で作る。

swimlane や bounded context は既存の flat group で表す。`groups[].nodes` には node id
だけを入れ、actor や read-model を含む各 node を該当 lane に直接所属させる。

```json
{
  "groups": [
    { "id": "customer-lane", "label": "Customer", "nodes": ["customer"], "ext": { "role": "swimlane", "lane": "customer" } },
    { "id": "ordering-lane", "label": "Ordering", "nodes": ["place-order", "order", "order-placed", "payment-policy", "order-status"], "ext": { "role": "swimlane", "lane": "ordering" } },
    { "id": "payment-lane", "label": "Payment", "nodes": ["capture-payment"], "ext": { "role": "swimlane", "lane": "payment" } }
  ]
}
```

projection root は member node と sibling に置き、既存の
`[data-ark-group][data-model-id]` + `.group-label` contract を使う。全幅の帯や役割ごとの
境界は authored class と4つの `--ark-harness-group-*` から組み立てる。

```html
<section class="event-lane lane-payment" data-ark-group data-model-id="payment-lane">
  <span class="group-label" data-model-id="payment-lane">Payment</span>
</section>
```

```css
.event-lane {
  display: none;
  position: absolute;
  left: calc(var(--ark-harness-group-x) - 5rem);
  top: calc(var(--ark-harness-group-y) - 1.5rem);
  width: calc(var(--ark-harness-group-width) + 10rem);
  height: calc(var(--ark-harness-group-height) + 3rem);
}
.event-lane.ark-harness-graph-group { display: block; }
```

group nesting、group 一括 drag、snap / grid は未対応。この例は timeline を固定するため
auto layout を使わない。完成例は `_examples/event-storming.diagram.html` を
`board_open.path` の説明に示された正準 directory と組み合わせて参照する。

### Infrastructure の例

`service` / `db` / `queue` / `lb` / `cache` / `external` はインフラ構成図で
使える推奨語彙であり、server が制限する enum ではない。未知 kind にも共通
`.infra-node` style を fallback として適用し、model の `node.kind` と node projection
root の `data-kind` は一致させる。

この例は region / VPC / subnet の境界を厳密に重ねるため、graph 内のすべての node に
有限数の `ext.x` / `ext.y` を指定して手動配置する。外部クライアントも graph 外の特別要素にはせず、
`kind: "external"` の通常 node とする。通信や依存関係は既存 edge の `from` / `to` /
`label` だけで表す。

```json
{
  "nodes": [
    { "id": "client", "label": "Internet Client", "kind": "external", "ext": { "x": 24, "y": 280 } },
    { "id": "lb", "label": "Load Balancer", "kind": "lb", "ext": { "x": 260, "y": 280 } },
    { "id": "api", "label": "API Service", "kind": "service", "ext": { "x": 500, "y": 280 } }
  ],
  "edges": [
    { "id": "client-to-lb", "from": "client", "to": "lb", "label": "HTTPS" },
    { "id": "lb-to-api", "from": "lb", "to": "api", "label": "routes" }
  ]
}
```

各 card には `aria-hidden="true"` の `.kind-icon` と、文字として読める可視 label を
併置する。色は補助情報に留め、6 kind を異なる icon と label でも判別できるようにする。

```css
[data-kind="service"] { --kind-color: #60a5fa; --kind-bg: #182942; }
[data-kind="db"] { --kind-color: #a78bfa; --kind-bg: #27203d; }
[data-kind="queue"] { --kind-color: #f59e0b; --kind-bg: #342817; }
[data-kind="lb"] { --kind-color: #34d399; --kind-bg: #17362f; }
[data-kind="cache"] { --kind-color: #f472b6; --kind-bg: #382035; }
[data-kind="external"] { --kind-color: #a3a3a3; --kind-bg: #292929; }
[data-kind="service"] .kind-icon::before { content: "▣"; }
[data-kind="db"] .kind-icon::before { content: "◉"; }
[data-kind="queue"] .kind-icon::before { content: "≋"; }
[data-kind="lb"] .kind-icon::before { content: "⇄"; }
[data-kind="cache"] .kind-icon::before { content: "◇"; }
[data-kind="external"] .kind-icon::before { content: "☁"; }
```

```html
<article class="infra-node" data-model-id="api" data-kind="service">
  <span class="kind-icon" aria-hidden="true"></span>
  <span class="node-label">API Service</span>
</article>
```

icon は Unicode、inline SVG、data URI の範囲で作る。外部 URL の image / font /
stylesheet / icon library や、外部ファイルを指す `<use href>` は使わない。

region / VPC / subnet の境界は、既存の flat group を次の形で使う。

```json
{
  "groups": [
    { "id": "tokyo-region", "label": "Tokyo Region", "nodes": ["lb", "api"], "ext": { "role": "region" } },
    { "id": "production-vpc", "label": "Production VPC", "nodes": ["lb", "api"], "ext": { "role": "vpc" } },
    { "id": "app-subnet", "label": "Application Subnet", "nodes": ["api"], "ext": { "role": "subnet" } }
  ]
}
```

projection は member node の sibling として既存の
`[data-ark-group][data-model-id]` + `.group-label` contract を使う。

```html
<section class="infra-boundary boundary-region" data-ark-group data-model-id="tokyo-region">
  <span class="group-label" data-model-id="tokyo-region">Tokyo Region</span>
</section>
```

region / VPC / subnet の階層感が必要でも `groups[].nodes` に group id は入れない。
外側 group には配下 node の和集合を列挙し、projection class ごとに4つの
`--ark-harness-group-*` を `calc()` する padding 差で、重なる矩形として近似する。

```css
.boundary-region {
  left: calc(var(--ark-harness-group-x) - 8rem);
  top: calc(var(--ark-harness-group-y) - 5rem);
  width: calc(var(--ark-harness-group-width) + 16rem);
  height: calc(var(--ark-harness-group-height) + 10rem);
}
.boundary-vpc {
  left: calc(var(--ark-harness-group-x) - 5rem);
  top: calc(var(--ark-harness-group-y) - 3rem);
  width: calc(var(--ark-harness-group-width) + 10rem);
  height: calc(var(--ark-harness-group-height) + 6rem);
}
.boundary-subnet {
  left: calc(var(--ark-harness-group-x) - 1.5rem);
  top: calc(var(--ark-harness-group-y) - 2rem);
  width: calc(var(--ark-harness-group-width) + 3rem);
  height: calc(var(--ark-harness-group-height) + 3.5rem);
}
```

group nesting、group 一括 drag は未対応。この例は階層境界を固定するため auto layout を
使わない。完成例は `_examples/infrastructure.diagram.html` を
`board_open.path` の説明に示された正準 directory と組み合わせて参照する。

## 語彙: edge / ER

edge の core field は `id` / `from` / `to` / `label` である。`from` と `to` は同じ
graph に投影した実在 node の id を参照し、self-edge（同じ id 同士）も使える。
ER 図の多重度・矢印方向・線の用途は、core 語彙を増やさず `edge.ext` に置く。

- `from_card` / `to_card` は、それぞれ `from` / `to` node 側の cardinality
- cardinality は `one`（1）、`many`（N）、`zero-or-one`（0..1）、
  `one-or-many`（1..N）、`zero-or-many`（0..N）の5値
- `direction` は `forward`（from → to）、`reverse`（to → from）、`both`（双方向）、
  `none`（矢印なし）の4値。省略または未知値は `forward`
- `type` は lowercase kebab-case 推奨の opaque string。server enum ではない

1:N、0..1、N:M の例：

```json
{
  "edges": [
    {
      "id": "customer-orders",
      "from": "customer",
      "to": "order",
      "label": "places",
      "ext": {
        "from_card": "one",
        "to_card": "zero-or-many",
        "direction": "forward",
        "type": "identifying"
      }
    },
    {
      "id": "order-featured-product",
      "from": "order",
      "to": "product",
      "label": "features",
      "ext": {
        "from_card": "one",
        "to_card": "zero-or-one",
        "direction": "none",
        "type": "optional-reference"
      }
    },
    {
      "id": "order-products",
      "from": "order",
      "to": "product",
      "label": "contains",
      "ext": {
        "from_card": "zero-or-many",
        "to_card": "zero-or-many",
        "direction": "both",
        "type": "association"
      }
    }
  ]
}
```

edge の main line / path には、harness が解釈済みの
`data-ark-edge-direction` と string の `data-ark-edge-type` を付ける。authored CSS は
これらを selector に使える。harness の汎用線 style より詳細度を高くするため、graph
root と generated main class も組み合わせる。

```css
[data-ark-container="graph"] .ark-harness-edge-main[data-ark-edge-type="identifying"] {
  stroke: #f59e0b;
  stroke-width: 2.25;
}
[data-ark-container="graph"] .ark-harness-edge-main[data-ark-edge-type="association"] {
  stroke-dasharray: 7 5;
}
```

ER projection の最小 HTML は通常の graph / entity / field list だけを書く。edge line、
crow's foot 記号、端点 handle、drag preview、drop indicator は配信時に harness が生成する
ため、authored HTML に重複して書かない。

```html
<div class="er-graph" data-ark-container="graph">
  <section class="entity" data-model-id="customer" data-kind="entity">
    <h2 data-model-id="customer">Customer</h2>
    <ul>
      <li data-model-id="customer_id">id PK</li>
    </ul>
  </section>
  <section class="entity" data-model-id="order" data-kind="entity">
    <h2 data-model-id="order">Order</h2>
    <ul>
      <li data-model-id="order_id">id PK</li>
      <li data-model-id="order_customer_id">customer_id FK</li>
    </ul>
  </section>
</div>
```

通常は entity node の座標を省略し、`model.ext.layout` の auto layout を使う。ER 固有の
位置調整が必要な node だけ有限数の `ext.x` / `ext.y` を両方指定する。端点 handle の
drag は core の `edge.from` / `edge.to` だけを更新するため
会話へ関連変更として還流する。一方、cardinality / direction / type のような `edge.ext`
単独変更は diagram file と表示には保存されるが、自動で自然文へ還流しない。

ER projection でも外部 URL、stylesheet、font、image、script、外部 `<use href>` は使わず、
inline CSS / SVG の範囲に留める。完成例は `board_open.path` の説明に示された正準 directory と
組み合わせて参照する。cardinality/direction/type の最小デモは
`_examples/er-edge-semantics.diagram.html`、業務ドメインを題材に 1:N・1:1・N:M（関連エンティティ含む）を
座標なし auto-layout で並べた実例は `_examples/ec-domain-model.diagram.html` を見る。

## 語彙: group

複数 node をラベル付きの境界でまとめるときは group を使う。model shape は
`{ id, label, nodes, ext? }` で、`nodes` には同じ model に実在する node id を入れる。
field id や別 group の id は member にせず、group の入れ子も作らない。bounded context、
actor、VPC、region、subnet など図種固有の役割が必要なら `ext` に置き、server の
group kind enum や固定 palette は前提にしない。

graph 上の自動境界配置を使う projection root は、member node と sibling にする。
root の `data-model-id` は group id と一致させ、可視 label の leaf にも同じ id を
付けると既存 inline label edit を利用できる。

```html
<section class="group-boundary" data-ark-group data-model-id="ordering-context">
  <span class="group-label" data-model-id="ordering-context">Ordering Context</span>
</section>
<article class="node" data-model-id="order">…</article>
<article class="node" data-model-id="user">…</article>
```

ハーネスは member node の外接矩形を次の CSS custom properties として root に渡す。
余白、border、background、角丸、label 帯の位置と大きさは projection CSS が決める。

- `--ark-harness-group-x`
- `--ark-harness-group-y`
- `--ark-harness-group-width`
- `--ark-harness-group-height`

### Rectangle boundary の例

全周に余白を足し、label を上辺付近に置く例。geometry が解決できない group は
表示しないよう、harness class が付いたときだけ表示する。

```css
.group-boundary {
  display: none;
  box-sizing: border-box;
  position: absolute;
  left: calc(var(--ark-harness-group-x) - 1.5rem);
  top: calc(var(--ark-harness-group-y) - 2.25rem);
  width: calc(var(--ark-harness-group-width) + 3rem);
  height: calc(var(--ark-harness-group-height) + 3.75rem);
  border: 1px solid currentColor;
  border-radius: .75rem;
  background: rgba(125, 207, 255, .08);
}
.group-boundary.ark-harness-graph-group { display: block; }
.group-boundary .group-label {
  position: absolute;
  top: .5rem;
  left: .75rem;
  font-weight: 600;
}
```

### Swimlane の例

同じ model shape と DOM contract のまま projection class を変え、左側に大きな
label 帯を確保する例。上帯にしたい場合も同じ4変数から `top` / `height` を
`calc()` して表現する。

```html
<section class="group-swimlane" data-ark-group data-model-id="payment-lane">
  <span class="group-label" data-model-id="payment-lane">Payment</span>
</section>
```

```css
.group-swimlane {
  display: none;
  box-sizing: border-box;
  position: absolute;
  left: calc(var(--ark-harness-group-x) - 5rem);
  top: calc(var(--ark-harness-group-y) - 1rem);
  width: calc(var(--ark-harness-group-width) + 6rem);
  height: calc(var(--ark-harness-group-height) + 2rem);
  border: 1px solid currentColor;
  background: rgba(187, 154, 247, .06);
}
.group-swimlane.ark-harness-graph-group { display: block; }
.group-swimlane .group-label {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4.5rem;
  display: grid;
  place-items: center;
  border-right: 1px solid currentColor;
  writing-mode: vertical-rl;
}
```

group 自体の drag や member node の一括移動、snap / grid、自動レイアウト、
group nesting は未対応。node は従来どおり個別に drag し、境界だけが追従する。
group projection でも外部 stylesheet、font、image は使わず、Unicode、inline SVG、
data URI、生成 CSS の範囲で可視 label を必ず設ける。

## 表現

図種は問わない。エンティティ表、スイムレーン、状態機械など、問題に合うものを HTML と CSS で作る。
ただし一覧的な並びは `<ul>` や `<ol>` のような素直なコンテナで組む（編集ハーネスが並べ替えを扱えるようにするため）。

## 参照用ファイルの置き場

正準 directory 配下（任意の階層）の `_` 始まりのディレクトリ（例: `_examples/`）は
図スイッチャーの一覧に出ない。規約サンプルなど参照用の図はそこに置く。
`board_open` はサブディレクトリのパスでも開ける。
