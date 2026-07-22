---
name: diagram-authoring
description: 図解を求められたときに .diagram.html を生成する規約。「図解して」「図で説明して」「ドメインモデリングして」等で使う。
---

# 図の書き方

図は `<worktree>/docs/diagrams/<名前>.diagram.html` に 1 ファイルで書く。
書いたら `board_open` でペインを開かせる。

## ファイルの構造

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

`command` / `event` / `aggregate` / `policy` は event storming で使える推奨語彙の例であり、server が制限する enum ではない。色だけに依存せず、Unicode icon と可視 label を併用する。

```html
<div class="node" data-model-id="place-order" data-kind="command">
  <span class="kind-icon" aria-hidden="true"></span><span>Place order</span>
</div>
<div class="node" data-model-id="order-placed" data-kind="event">
  <span class="kind-icon" aria-hidden="true"></span><span>Order placed</span>
</div>
<div class="node" data-model-id="order" data-kind="aggregate">
  <span class="kind-icon" aria-hidden="true"></span><span>Order</span>
</div>
<div class="node" data-model-id="payment-policy" data-kind="policy">
  <span class="kind-icon" aria-hidden="true"></span><span>Payment policy</span>
</div>
```

```css
.node {
  --kind-color: #565f89;
  --kind-bg: #1e202b;
  border: 1px solid var(--kind-color);
  background: var(--kind-bg);
}
[data-kind="command"] { --kind-color: #7aa2f7; --kind-bg: #1f2a44; }
[data-kind="event"] { --kind-color: #9ece6a; --kind-bg: #203222; }
[data-kind="aggregate"] { --kind-color: #e0af68; --kind-bg: #332b1f; }
[data-kind="policy"] { --kind-color: #bb9af7; --kind-bg: #302640; }
[data-kind="command"] .kind-icon::before { content: "▶"; }
[data-kind="event"] .kind-icon::before { content: "⚡"; }
[data-kind="aggregate"] .kind-icon::before { content: "◆"; }
[data-kind="policy"] .kind-icon::before { content: "◇"; }
```

### Infrastructure の例

`service` / `db` / `queue` / `lb` / `cache` / `external` はインフラ構成図で
使える推奨語彙であり、server が制限する enum ではない。未知 kind にも共通
`.infra-node` style を fallback として適用し、model の `node.kind` と node projection
root の `data-kind` は一致させる。

#228 の auto-layout に依存せず、graph 内のすべての node に有限数の `ext.x` / `ext.y`
を指定して手動配置する。外部クライアントも graph 外の特別要素にはせず、
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

group nesting、group 一括 drag、auto-layout は未対応で、インフラ構成図でも導入しない。
完成例は `docs/diagrams/infrastructure.diagram.html` を参照する。

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
