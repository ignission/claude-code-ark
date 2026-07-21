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

<div data-model-id="order" class="entity">…投影…</div>
</body>
</html>
```

## 守ること

- **モデルは必ず `id="ark-diagram-model"` の JSON ブロックに入れる。** 無いとサーバーが 422 を返す
- **語彙は node / edge / field / group / label と kind だけ使う。** 図種固有の意味は `ext` に入れる
- **id はファイル内で一意にする。** 重複するとサーバーが拒否する
- **edge の `from` と `to` は実在する node の id を指す。** 存在しない id を指すと 422 で拒否される
- **投影の各要素に `data-model-id` を付ける。** 編集ハーネスがモデルと対応づけるため
- **外部リソースを参照しない。** CSS も画像も自前で書き、画像は data URI として埋め込む（外部通信は遮断される）
- **`<meta http-equiv="Content-Security-Policy">` を自分で書かない。** Ark が注入する

## 語彙: kind

node の `kind` フィールドで図の要素型を指定する。サーバーは `kind` の値を解釈せず、投影側（HTML/CSS）と skill の取り決めに従う。

- `kind: "entity"` — エンティティ（ER図など）
- `kind: "step"` — プロセスステップ（フローチャートなど）
- `kind: "state"` — ステートマシンの状態
- その他の値でも可。投影側で CSS セレクタ `[kind="..."]` で見た目を分け替える

例：

```html
<div data-model-id="order" class="entity">…</div>
```

```css
[kind="entity"] { border-radius: 4px; }
[kind="state"] { border-radius: 50%; }
```

## 表現

図種は問わない。エンティティ表、スイムレーン、状態機械など、問題に合うものを HTML と CSS で作る。
ただし一覧的な並びは `<ul>` や `<ol>` のような素直なコンテナで組む（編集ハーネスが並べ替えを扱えるようにするため）。
