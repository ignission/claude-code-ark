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
- **語彙は node / edge / field / group と label だけ使う。** 図種固有の意味は `ext` に入れる
- **id はファイル内で一意にする。** 重複するとサーバーが拒否する
- **投影の各要素に `data-model-id` を付ける。** 編集ハーネスがモデルと対応づけるため
- **外部リソースを参照しない。** CSS も画像も自前で書く（外部通信は遮断される）
- **`<meta http-equiv="Content-Security-Policy">` を自分で書かない。** Ark が注入する

## 表現

図種は問わない。エンティティ表、スイムレーン、状態機械など、問題に合うものを HTML と CSS で作る。
ただし一覧的な並びは `<ul>` や `<ol>` のような素直なコンテナで組む（編集ハーネスが並べ替えを扱えるようにするため）。
