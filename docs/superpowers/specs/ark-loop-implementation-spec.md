# Ark ループエンジニアリング実装 spec

> ステータス: 確定 / Issue #332

## 目的

Manus の context engineering を Ark が起動する1セッション内の認知維持層へ写像し、後続 Issue が実装時に守る契約を固定する。実装対象は `ark/loop/` の配布物と Claude Code adapter に限定する。Issue #332 ではこの Markdown spec と既存 skill からの参照だけを変更し、実行コードは実装しない。

## 対象と非対象

- 対象: 後続 Issue #333〜#336 が実装する `ark/loop/`、XDG runtime、Claude Code adapter。
- 非対象: Ark アプリ本体の `server/`、`client/`、`shared/`、既存 flow の運転仕様、Issue #332 での hook・settings・script 実装。

## Issue 参照表

| Issue | 固定参照 |
| --- | --- |
| #333 | §1, §2, §3, §4-1, §5-1, §5-3, §6-1 |
| #334 | §5-2 |
| #335 | §4-2, §6-3, task.md.tmpl の `{{PREV_FAILURE_SUMMARY}}` |
| #336 | §4-3, §6-2, §7 |

## §1 概要と設計原則

### §1-1 目的と非ゴール

本層は、長い tool loop で起きるゴールドリフト（goal drift）、lost-in-the-middle、compaction 後の失敗再発を減らすための、現在のモデル向けの撤去可能な足場である。この spec 自体も、モデルまたはホスト機能の進歩で不要になれば撤去する。

推論スタック、独自 agent runtime、動的 tool masking、Ark UI は追加しない。Claude Code の既存 loop と filesystem に限定し、モデルの能力そのものは変更しない。

### §1-2 Manus 原則の写像

| Manus 原則 | Ark で守る契約 |
| --- | --- |
| 安定 prefix / append-only | 固定 template と決定的な直列化を使い、時刻などの変動値を recitation に入れない。原記録は追記し、過去 entry を書き換えない |
| Mask, don't remove | tool 定義を途中で消さず、Claude Code の `allowed-tools` でセッション開始時から制約する。動的 masking は実装しない |
| filesystem 外部メモリ | 長い内容は `artifacts/` と `errors/raw.log` に保存し、context には path と固定長要約を置く |
| attention through recitation | `task.md` の Goal、現在地、未完了件数だけを一定間隔で固定長注入する |
| keep the wrong stuff in | 原エラーを append-only JSONL に残し、再試行前と次セッションから参照可能にする |
| don't get few-shotted | review 観点の集合を固定したまま提示順だけを session ごとに変える |
| compaction-first / summarization-last | path と行参照を残す可逆な機械処理を先に行い、不可逆な LLM 要約は明示 opt-in の最終手段にする |

出典:

- https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- https://www.youtube.com/watch?v=6_BcCthVvb8

### §1-3 層の定義

本 spec は、tool step、compaction、再起動に対して認知状態を保つ「1セッション内の認知維持ループ」を定義する。`/flow-loop` は Issue の pick から PR、CI、deploy までを複数セッションにまたがって進める「複数セッション・PR・CI・deploy をまたぐ運転ループ」である。

認知維持層は運転ループの下層として補完するだけで、`flow` / `flow-x` / `flow-loop` の phase、gate、安全装置、再開判断を奪わない。

### §1-4 課金と単純性

機械的 compaction を既定とし、LLM 要約はユーザーが明示した opt-in でのみ有効にする。LLM 要約は API 従量課金を伴い、失敗時は機械処理へ戻る。

recitation、error capture、summary、handoff、knowledge 配布は個別に無効化・撤去できなければならず、いずれかの撤去が他の足場や flow の運転を壊してはならない。

## §2 配置と XDG ディレクトリ契約

## §3 設定・状態・正本

## §4 hook 契約

## §5 テンプレート・ループ規約・アダプタ

## §6 セッションライフサイクル script

## §7 横断知識・flow 接続・足場撤去
