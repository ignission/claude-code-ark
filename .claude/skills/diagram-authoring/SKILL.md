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

`service` / `db` / `queue` / `lb` も推奨語彙の例として使える。Unicode の代わりに inline SVG や data URI を使ってもよいが、`<img src="https://...">`、外部 stylesheet、icon font / icon library、外部ファイルを指す `<use href>` は禁止する。

```css
[data-kind="service"] .kind-icon::before { content: "▣"; }
[data-kind="db"] .kind-icon::before { content: "◉"; }
[data-kind="queue"] .kind-icon::before { content: "≋"; }
[data-kind="lb"] .kind-icon::before { content: "⇄"; }
```

## 表現

図種は問わない。エンティティ表、スイムレーン、状態機械など、問題に合うものを HTML と CSS で作る。
ただし一覧的な並びは `<ul>` や `<ol>` のような素直なコンテナで組む（編集ハーネスが並べ替えを扱えるようにするため）。
