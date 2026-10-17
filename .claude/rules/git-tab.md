---
paths:
  - "packages/server/src/lib/git-view*.ts"
  - "packages/server/src/lib/git-ops*.ts"
  - "packages/web/src/components/git/**"
  - "packages/web/src/lib/git-*.ts"
---

# Gitタブ

PCの作業エリアの「Git」のタブ (`GitPane`) は、セッションのworktreeのコミットグラフ、ref、差分、未コミットの変更を見せ、ブランチとリモートを操作する。手本はForkのメイン画面で、ファーストビューはコミット一覧。読み取りと入力の検証の決まりは `git-view.ts` の冒頭と各関数のコメント、書き込みの決まりは `git-ops.ts` の冒頭、追従は `GitPane.tsx`、グラフの割り当ては `lib/git-graph.ts` の `layoutGraph` と `lib/git-graph-rows.ts` の冒頭にある。

## 範囲

- **書き込みは、refを触る操作とリモートの操作に限る。** ブランチの作成、名前変更、削除、リモートのブランチの削除、fetch、pull、push。入口はサイドバーとコミット一覧の右クリックと、一覧の上部のボタン
- **作業ツリーとindexを書き換える操作は持たない。** チェックアウト、ステージ、コミット、破棄、stashの適用。同じworktreeでClaudeがgitを動かしているので、取り消せない書き換えがClaudeの作業とぶつかる
- **例外はpullの1つだけで、`--ff-only` に限る。** マージコミットや競合を作らず、ローカルの変更とぶつかるならgitが断る
- **作業ツリーで使用中のブランチは、作業ツリーごと消せる** (いまのブランチなら、このセッションのworktreeごと)。中身を書き換えるのではなく、サイドバーのworktreeの削除と同じ後始末 (セッションを止めて `git worktree remove --force`) を通す。未コミットの変更も消えるので、確認のダイアログを必ず出す。リポジトリ本体の作業ツリーは消せないので、そこで使っているブランチは消さない
- **forceの付く操作は持たない** (`push --force`)。未マージのブランチの削除だけは、確認のダイアログを経て強制で消し、消したあとのtoastから戻せるようにする
