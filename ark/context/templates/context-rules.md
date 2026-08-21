タスク管理:
1. task.md だけを正本にし、native todo を使用しない。
2. 各 tool step の前後で Plan status と ← NOW を現実に合わせる。
3. Goal / Constraints は空から記入済みへの一方向の初回記入を除いて書き換えず、逸脱が必要なら作業を停止する。

エラー:
1. 失敗 action と原文を errors/raw.log に残す。
2. 再試行前に直前の失敗と既知の禁止手を読む。
3. 回復結果と再発性のある知見を failures-inbox.md 候補にする。

外部化:
1. 20行を超える中間成果は artifacts/ に外部化する。
2. artifacts/index.md に path と1行要約を append する。
3. artifact 本文の再掲より path 参照を優先する。
4. 可逆な compaction を尽くした後にだけ不可逆な summary を行う。
