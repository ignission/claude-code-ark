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

### §2-1 配布物

配布物の境界は次で固定する。

```text
ark/loop/
├── templates/
├── hooks/
├── scripts/
└── adapters/
    └── claude-code/
```

`templates/`、ループ規約、file format は agent 非依存とする。settings 注入、hook matcher、hook 入出力 JSON の解釈は `adapters/claude-code/` に閉じ込める。将来の `adapters/codex/` は同じ正本と format を使い、AGENTS.md 注入と実行 wrapper だけを追加すればよい構造とする。

### §2-2 XDG runtime

正規配置は次のとおりとする。

- config: `${XDG_CONFIG_HOME:-$HOME/.config}/ark/loop/config.toml`
- session data: `${XDG_DATA_HOME:-$HOME/.local/share}/ark/loop/sessions/$ARK_SESSION_ID/`
- host knowledge: `${XDG_DATA_HOME:-$HOME/.local/share}/ark/loop/knowledge/`
- session cache: `${XDG_CACHE_HOME:-$HOME/.cache}/ark/loop/$ARK_SESSION_ID/`

```text
${XDG_DATA_HOME:-$HOME/.local/share}/ark/loop/
├── sessions/$ARK_SESSION_ID/
│   ├── task.md
│   ├── artifacts/
│   │   └── index.md
│   ├── errors/
│   │   ├── raw.log
│   │   └── summary.md
│   └── handoff.md
└── knowledge/
    ├── failures.md
    └── failures-inbox.md

${XDG_CACHE_HOME:-$HOME/.cache}/ark/loop/$ARK_SESSION_ID/
├── step_count
└── stop_once
```

session data と knowledge は永続 data であり、cache は消失しても再生成できる counter と one-shot Stop flag だけを持つ。両者を相互に代用しない。

### §2-3 対象 repo への影響

実行時に対象 repo へ加えてよい一時変更は、注入中の `.claude/settings.local.json` と、repo `.gitignore` の `.claude/settings.local.json` 明示 entry だけとする。認知維持の成果物本体は XDG data 配下に置く。

正常終了は settings 注入物を除去し、異常終了は次回 init が同じ復元を行う。どちらも元の repo 設定へ収束し、それ以外の永続変更を残さない。

## §3 設定・状態・正本

### §3-1 config と環境変数

`session-init.sh` は config を読み、次を同じ process tree の hook へ export する。

| 変数 | 導出契約 |
| --- | --- |
| `ARK_SESSION_ID` | init が新規生成する衝突しない session ID。再実行時は既存 ID を保持 |
| `ARK_SESSION_DIR` | §2-2 の session data root + `$ARK_SESSION_ID` |
| `ARK_CACHE_DIR` | §2-2 の session cache root + `$ARK_SESSION_ID` |
| `ARK_RECITE_INTERVAL` | config 値。未指定時は `10` |
| `ARK_KNOWLEDGE_DIR` | §2-2 の host knowledge path |

`ARK_SESSION_DIR` または必要な session 変数が未設定なら、全 hook は入力へ副作用を与えず即座に成功終了する。これにより Ark 外で起動した Claude Code を隔離する。config の既定は `[loop.summarize] llm = false` とする。

### §3-2 file ownership

| file | 所有権と更新規則 |
| --- | --- |
| `task.md` | session 内の進捗の唯一の正本。init と作業 agent が契約された欄だけを更新 |
| `artifacts/` | context に保持しない大きな中間成果。`index.md` が path と要約の目次 |
| `errors/raw.log` | capture hook だけが追記する append-only 原記録 |
| `errors/summary.md` | raw log から再生成可能な派生物 |
| `handoff.md` | task、artifact index、error summary から再生成可能な派生物 |
| `knowledge/failures.md` | 人間がキュレーションした host 正本。session へ read-only 配布 |
| `knowledge/failures-inbox.md` | session の候補を受け取る昇格待ち。配布正本として扱わない |

### §3-3 native todo との関係

選択肢 (a) を採用する。loop 有効セッションでは `task.md` を唯一の正本とし、作業項目を `TodoWrite` または native Task todo state に複製しない。hook と別セッションから読めること、process 再起動後も残ること、双方向の同期競合がないこと、現行 `.claude/` に先行利用がないことを優先する。

この選択は Claude Code の native todo が提供するユーザー可視の進捗表示を失う。そのコストを受け入れ、hook、再起動、別セッションで一貫して扱える単一正本を選ぶ。

この判断から次を拘束する。

- P1 の `recite-todo.sh` は `task.md` だけを読み、native todo を参照も更新もしない。
- P2 の `loop-rules.md` は native todo の使用禁止、Plan status と `← NOW` の現実に合わせた更新、Goal / Constraints の不変条件を含む。
- native todo が必要な作業は loop を無効化するか、項目を `task.md` へ移してから loop を継続する。
- 将来 adapter も native todo との同期を追加してはならない。

### §3-4 flow state との所有権表

現行 `.claude/lib/state-io.sh:99-119` の progress は phase、gate 相当、safety、warning 等の制御面を、同 `:141-161` の context は WORK_ID、Issue、worktree 等の運転参照を持つ。本層はこの schema を拡張しない。

| 正本 | plane | 境界 |
| --- | --- | --- |
| `flow-progress-*.json` および flow state | control plane | phase、gate、safety、warning、run context |
| session `task.md` / `artifacts/` / `errors/` | data plane | 目標、進捗、作業内容、失敗原記録 |

両 plane の内容を相互コピー、双方向同期、自動マージしない。接続は WORK_ID と session path の参照だけに留め、flow state schema に認知維持用 field を追加しない。

## §4 hook 契約

## §5 テンプレート・ループ規約・アダプタ

## §6 セッションライフサイクル script

## §7 横断知識・flow 接続・足場撤去
