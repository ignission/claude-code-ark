---
paths:
  - "packages/server/src/lib/diagram-*.ts"
  - "packages/server/src/lib/board-mcp-server.ts"
  - "packages/server/src/lib/board-session-start-hook.ts"
  - "packages/web/src/components/Diagram*.tsx"
  - "packages/web/src/lib/diagram-*.ts"
  - ".claude/skills/diagram-authoring/**"
  - "packages/web/src/lib/visualize-conversation.ts"
---

# セッションボード

worktreeの `.claude/diagrams/*.diagram.html` (意味モデル + HTMLの投影) を、PCの作業エリアの「図」のタブに出す。ClaudeはMCPツール `board_open` で開き、Arkはファイルの更新を検知して読み直す。

## 図種

- **内蔵の図種** `sequence` (時間順のやり取り) と `call-tree` (呼び出し経路と差分量) は、モデルだけ書けば投影が出る (`diagram-static-builtin.ts`)
- **doc** (`type: "doc"`) は本文を人間がその場で編集でき、変更をブロック単位で会話へ還流する
- **デッキ** (`type: "deck"`) は1ファイルに `blocks` (見出しと、カード、チップ、表など決まった部品の並び。`diagram-deck-blocks.ts`) / `sequence` / `call-tree` のページを並べる (`diagram-deck.ts`)。graphの図種とdocはページにできない
  - 全ページを積んで見せる (既定) か、1枚ずつめくらせる。積むときは、点の地のキャンバスにページをカードとして互い違いに置く。位置は持たず、ドラッグも保存も無い
  - **書くのはモデルのJSONだけ。** 見た目はArkが描き、明暗に追従する
  - **自由形の `html` ページは古い形で、`board_open` は拒否する。** 書く側のモデルごとに見た目がぶれるため。図の切り替えからは今までどおり開ける。絵が要るときは、`type` の無い1枚の図を別のファイルに描く
- 本文の `<a href="src/foo.ts#L10">` は、ファイルビューアで該当の行を開く
- 込み入った説明は、頼まれなくてもデッキ (1ページに1つのこと) で描く。この依頼はSessionStart hookで伝え、「会話を図解」ボタンも同じ依頼を送る

## コメントの操作ID (`operationId`)

コメントのmutation (create / reply / resolve / delete / send) は、transportのACKタイムアウトがサーバーの処理を取り消さないので、再試行で同じ操作が二重に適用されうる (#306)。

- mutationのpayloadには、クライアントが生成した `operationId` を必ず載せる。サーバーはプロセス内のLRU (`diagram-comment-operation-log.ts`) に適用済みのIDを記録し、同じIDの再送は適用し直さずに現在のsidecarを返す
- `operationId` は、iframeのコメント層が「ユーザーの操作」の単位で生成する。タイムアウトのあとにユーザーが同じ操作をやり直しても同じ値を送り、成功したら捨てる
- transportはACKが5秒戻らなければ、同じpayloadを1回だけ再送する (合計10秒。iframe側のwatchdogの15秒より短い)
- MCP経由 (Claudeの `board_reply` など) は `operationId` 無しで呼び、冪等化しない
- **記録はsidecarに持たせない** (成果物に再試行の都合を混ぜない)。そのため、サーバーの再起動をまたぐ再試行は冪等化の対象外とする (socketも切れるので稀)

## doc本文の書き手の印 (`data-ark-author`)

docの本文は、人間も別セッションのClaudeも同じファイルを書き換える (#319)。読み手が知りたいのは**どのブロックに人間が手を入れたか**の1点なので、`data-ark-id` を持つブロック要素に `data-ark-author="human"` を付けてそれだけを記す。本文のHTMLが正準のsourceなので、モデル側には持たせない。

- **Claude側の印 (`data-ark-author="claude"`) は廃止した。** 文書のほぼ全ブロックに付いて、唯一読みたい「人間が触った箇所」を埋めてしまうため。新しくは付けず、バッジも出さない。既存の文書に残る `claude` は語彙として受理する
- 語彙は `human` / `claude` の2値。語彙外の値、`data-ark-id` の無い要素への付与、1要素内の重複は、配信 (`readDiagram`) と保存 (`saveDiagramEdit`) の両方の境界で422にする (`diagram-doc-authorship.ts`)。無印は許容する (既存の文書を壊さない)
- 編集層は、人間が手を入れたブロックへ自動で `human` を付ける (誤字を1つ直しただけでも付く)。付ける先は、ほかの `data-ark-id` を内包しない最も内側の葉ブロックだけ。文書全体を包む容器へ丸ごと付く事故を防ぐため
- 読み手の規則は「`human` が付いたブロックは、人間が手を入れた本文である」の1つ。決定かどうかは、属性ではなく本文の記述で判断する。容器ブロックに `human` が無くても、その中身を人間が書いていないとは限らない
- **`human` はサーバーで検証できない** (ファイルはworktreeの外から自由に書き換えられる)。Claudeが自分で `human` を付けてよいのは、人間がコメントや会話で下した決定を転記するときだけ。この規約はSessionStart hookのcontextと `diagram-authoring` skillで配る
- コメント層は、`human` の付いたブロックにだけ「人間」のバッジを出す
- 「前回開いたときからの差分」の可視化と、複数エージェントの同時編集の競合 (last-write-wins) は範囲外

## 図の一覧

図のタブは「図の一覧」と「図」の2画面を行き来する (`DiagramSwitcher` / `lib/diagram-browser.ts`)。一覧で図を開くと図の画面へ替わり、上のバーの「戻る」で一覧へ、「進む」で開いていた図へ移る。以前のプルダウン1本では名前しか見えず、どれが新しい図かも分からなかった。

- **一覧の画面は図の上に重ねて描く。** 図のiframeを外さないので、戻ったときに作り直しにならない
- 一覧はリスト表示で、名前、種類、更新日時の列を持つ。**既定は更新の新しい順** (いま描いた図が先頭に来る)。列の見出しで並べ替え、選んだ並びはlocalStorageに覚える。上の欄で名前とパスを絞り込む
- 種類と更新日時は `diagram:list` が返す (`kind` / `mtimeMs`)。種類は「デッキ / 文書 / シーケンス / 呼び出し / 図」で、graphの図種と `type` の無い図は「図」にまとめる
- **見せる図が替わったら図の画面へ移る。** 復元やClaudeの `board_open` で図が開いたのに、一覧の画面のままにしない。図をまだ選んでいないときは、一覧の画面から始める
- 一覧は `role="listbox"` で、矢印、Home / End、PageUp / PageDown、Enterで動く。ノーマルモードの `j` / `k` / `gg` / `G` は、一覧が開いている間は図ではなく一覧へ届く
- 削除は行ごとのボタンから行い、確認のダイアログを挟む
