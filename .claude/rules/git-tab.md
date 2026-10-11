---
paths:
  - "packages/server/src/lib/git-view*.ts"
  - "packages/web/src/components/git/**"
  - "packages/web/src/lib/git-*.ts"
---

# Gitタブ

PCの作業エリアの「Git」のタブ (`GitPane`) は、セッションのworktreeのコミットグラフ、ref、差分、未コミットの変更を見せる。手本はForkのメイン画面で、ファーストビューはコミット一覧。読み取りと入力の検証の決まりは `git-view.ts` の冒頭と各関数のコメント、追従は `GitPane.tsx`、グラフの割り当ては `lib/git-graph.ts` の `layoutGraph` と `lib/git-graph-rows.ts` の冒頭にある。

## 範囲

- **いまは見るだけ。** ステージ、コミット、破棄、チェックアウト、fetch / pull / pushは持たない。破棄やチェックアウトは取り消せず、確認の設計が要るので、見た目と閲覧を先に実機で固める
