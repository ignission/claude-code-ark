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
│   ├── knowledge/
│   │   └── failures.md
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

hook input は非信頼データとして parse し、path、文字列、数値を検証する。全 script は loop 用環境変数が未設定なら no-op で成功し、counter を session cache 以外で共有せず、自身の失敗で本来の tool result を握りつぶさない。追加 hook の counter 更新などの fast path は合計100ms以内とする。

現行 `.claude/settings.json:52-70` の PostToolUse 2件を保持する。後続実装での論理順は、同一 tool event ごとに次とする。

1. `capture-error`
2. 既存の該当 hook（Bash は `post-push-monitor.sh`、Write / Edit は `post-edit-lint.sh`）
3. `recite-todo`

Claude Code が配列内の command hook を実際に直列実行するかは #333 と #335 で実機確認し、既存分を含む計測値を両 PR に残す。直列性が成立しなければ、この論理順を保証する単一 dispatcher に adapter 内で束ねる。

### §4-1 recite-todo.sh

成功した tool step ごとに `ARK_CACHE_DIR/step_count` を排他的に1増加させ、`ARK_RECITE_INTERVAL`（既定10）step ごとに次の固定形式だけを `additionalContext` へ出す。

```text
Goal: <1行>
NOW: <← NOW の付いた1行>
Remaining: <未完了件数>
```

task 全文、timestamp、artifact 本文、native todo は注入しない。概念上は1回200 token以下とし、tokenizer に依存しない実装上の代理指標として UTF-8 で600 bytes以下であることを #333 で検証する。

compaction 直後も `task.md` 正本から同じ key、同じ順序、同じ行数で再構成し、変動する prefix を加えない。interval の変更と hook の無効化だけで、他の足場に触れず recitation を撤去できなければならない。

### §4-2 capture-error.sh

PostToolUse の失敗 event だけを `errors/raw.log` へ、次の field を持つ1物理行の JSONL として append する。

```json
{"at":"RFC3339","tool":"tool name","error_type":"input field or tool_error","exit_code":1,"message":"escaped message"}
```

`at`、`tool`、`error_type`、`exit_code`、`message` は常に同じ key 順で出力する。message の改行は JSON escape し、UTF-8 で4096 bytesを上限として code point 境界で切る。成功 event は書き込まない。1 entry を必ず1行に収め、`L{n}-L{n}` の参照を安定させる。

capture は入力にある型の正規化以外の分類、要約、「禁止手」の生成を行わず、原 tool error の表示・終了状態を変更しない。同一 tool event の capture は recite より先に完了させる。hook input の実 field 名と成功・失敗判定は #335 で実機ダンプを fixture 化して確定し、fixture にない field を推測して補わない。

### §4-3 Stop

新しい Stop hook は登録しない。現行 `.claude/settings.json:72-80` の登録先を保ち、現在 no-op の `.claude/hooks/stop-gate.sh:1-8` の実体を `on-stop.sh` 相当へ置換する。

未完了 Plan があり、`ARK_CACHE_DIR/stop_once` がなければ flag を原子的に作成して1回だけ継続を要求する。同じ session の2回目以降は未完了でも Stop を通し、flag は teardown まで保持して無限 Stop loop を防ぐ。

Stop 通過時は `handoff.md` を生成するが、Stop hook は teardown 完了を保証しない。tmux kill、pm2 restart、process crash を含め、teardown を通らない終了では次回 init が同じ収束処理を担う。

## §5 テンプレート・ループ規約・アダプタ

### §5-1 task.md.tmpl

通常 task の schema は次で固定する。

```markdown
# Task

## Goal
<1行>

## Constraints
- <不変条件>

Previous failure summary: {{PREV_FAILURE_SUMMARY}}

## Plan
- [ ] <未完了項目> ← NOW
- [ ] <未完了項目>

## Artifacts
- <path> — <1行要約>
```

Plan には checkbox を使い、`← NOW` は常にちょうど1個だけ置く。全項目完了時は完了した最後の項目に残す。Goal と Constraints は init 後に編集してはならず、作業中に更新できるのは Plan の項目、status、`← NOW` と artifact 参照だけとする。

`task-review.md.tmpl` は、diff 全ファイルの通読、規約遵守、artifact / index の整合、エラー握りつぶし、Goal 逸脱、再発性のある指摘の inbox 候補化を、同じ checkbox schema の Plan に持つ。session ID の SHA-256 を seed にした決定的な順列で提示順だけを変え、観点集合を削らず、同一 session 内では順序を安定させる。

### §5-2 loop-rules.md

規約は次の10則で固定する。

タスク管理:

1. `task.md` だけを正本にし、native todo を使用しない。
2. 各 tool step の前後で Plan status と `← NOW` を現実に合わせる。
3. Goal / Constraints を書き換えず、逸脱が必要なら作業を停止する。

エラー:

1. 失敗 action と原文を `errors/raw.log` に残す。
2. 再試行前に直前の失敗と既知の禁止手を読む。
3. 回復結果と再発性のある知見を `failures-inbox.md` 候補にする。

外部化:

1. 20行を超える中間成果は `artifacts/` に外部化する。
2. `artifacts/index.md` に path と1行要約を append する。
3. artifact 本文の再掲より path 参照を優先する。
4. 可逆な compaction を尽くした後にだけ不可逆な summary を行う。

### §5-3 Claude Code adapter

Claude Code adapter だけが、既存 `.claude/settings.local.json` の退避・loop settings の注入・復元、hook matcher、hook input JSON、`additionalContext` output、Claude Code の `allowed-tools` を扱う。agent 非依存の template、規約、session file format に Claude Code 固有 key を入れない。

adapter は §3-3 の単一正本を変えてはならない。将来の Codex adapter も AGENTS.md と wrapper の接続に留め、native todo 同期や別の進捗正本を持ち込んではならない。

## §6 セッションライフサイクル script

### §6-1 session-init.sh

init の順序を次で固定する。

1. XDG path を解決する。
2. `.claude/settings.local.json.ark-loop-original` という孤児 backup を検出したら、注入設定を除去して original を `mv` で復元する。
3. session ID を生成または再取得し、session directory と cache directory を作る。
4. config を読み、§3-1 の環境変数を export する。
5. 新規 session に限って template を展開する。
6. host の `failures.md` を session へ read-only copy する。
7. 現在の settings.local を再退避し、loop settings を注入する。

settings.local の退避と復元は同一 filesystem 上の `mv` を使い、各境界で存在確認する。teardown を通らない kill を通常系として扱う。連続する2回の kill 後も、「元設定1個」または「注入設定1個と backup 1個」だけが存在する解釈可能な状態を保ち、次回 init の手順2で元設定へ収束させる。元設定がなかった場合は専用 marker でその事実を保持し、復元時に settings.local を残さない。

repo `.gitignore` には `.claude/settings.local.json` を完全一致の1行として重複なく追加し、グローバル ignore に依存しない。対象 repo にそれ以外の永続変更を残さない。

`--restart <session-id>` は指定 session の `errors/summary.md` から UTF-8 で最大2000 bytesの抜粋と `errors/raw.log` の path を `{{PREV_FAILURE_SUMMARY}}` に埋める。通常 init は固定文 `なし（通常起動）` を埋める。`step_count` は新 session ごとに0から始めるが、同じ init の再実行では既存 `task.md` と進捗を上書きしない。

### §6-2 session-teardown.sh

teardown の順序を次で固定し、各段階を単独で再実行可能にする。

1. 機械的 error summary を生成する。
2. `handoff.md` を更新する。
3. 再発性のある候補を host の `failures-inbox.md` へ重複なく追記する。
4. settings.local の loop 注入物を除去し、original を `mv` で復元する。元設定なし marker の場合は注入 file を除去する。
5. `stop_once` 等の transient flag を cleanup する。

`handoff.md` の固定項目は Goal、完了 Plan、未完了 Plan、現在の `← NOW`、artifact path と1行要約、直近の error summary path、次の最小 action、WORK_ID、session ID とする。artifact 本文と flow JSON は複製しない。

`handoff.md` は次のモデルへ意味的文脈を渡す data plane である。`/flow --resume` は現行 `.claude/skills/flow/SKILL.md:152-168` と `.claude/lib/state-io.sh` に従って phase / gate を復元する control plane である。競合時は flow state を phase の正本とし、handoff は助言情報として扱う。自動マージも相互上書きもしない。

teardown が未実行なら、次回 init は summary、handoff、settings 復元をこの順で補償してから新しい注入へ進む。最終的な repo 状態は teardown 実行済みの場合と同じでなければならない。

### §6-3 summarize-errors.sh

既定の summary は LLM を呼ばない機械的 compaction とする。JSONL を `tool`、次に `error_type` の bytewise 昇順で決定的に集計し、各 group に件数、最初の行番号、最後の行番号、`詳細: errors/raw.log:L{n}-L{m}` を出す。同じ bytes の input からは時刻や locale に依存しない同じ本文を生成する。

`config.toml` の `[loop.summarize] llm = true` のときだけ、Haiku API に機械 summary と raw 行参照を渡し、「禁止手」付き要約を機械 summary の後へ追加する。config の該当行の直前には `# API 従量課金が発生し、Claude プラン枠の対象外` と記す。API key 不在、5秒 timeout、非0終了、JSON schema 不一致、raw 行参照欠落を含む invalid output は、すべて機械 summary を保持したまま成功 fallback とする。

LLM 出力の各項目にも `errors/raw.log:L{n}-L{m}` 形式の参照を必須とする。`raw.log` は削除も書換えもしない。次 session の `task.md.tmpl` への継承は summary 本文の UTF-8 で最大2000 bytesの抜粋と raw path だけとし、原ログ全体を注入しない。

## §7 横断知識・flow 接続・足場撤去

### §7-1 failures 横断共有

host knowledge の `failures.md` だけを curated 正本とする。session 開始時に `$ARK_SESSION_DIR/knowledge/failures.md` へ copy して read-only にし、実行中の agent と hook は書き換えない。session 終了時は候補を host の `failures-inbox.md` へ追記する。

昇格は人間だけが行う。人間は inbox の候補について重複、機密情報、再現性を確認し、採用した項目を inbox から `failures.md` へ移す。session output や raw log から直接 `failures.md` へ昇格する経路を作らない。

### §7-2 flow-loop 接続

現行 `.claude/skills/flow-loop/SKILL.md:67-73,107-112` のブレーカーと `loop-exclude` は失敗 run を止める隔離側、`failures.md` は失敗を知識化して次の run で避ける学習側である。学習側はブレーカー、kill switch、`loop-exclude`、flow-x の safety を解除も迂回もしない。

ブレーカー event には配布した `failures.md` の SHA-256 と、その run が file を参照したかを記録する。知識注入 cohort について consecutive halt、breaker 発動、`loop-exclude` 適用の頻度が下がるかを観察する。この計測は安全装置の作動条件を変更しない。

| 認知維持層 | flow / flow-loop | 関係と同期禁止 |
| --- | --- | --- |
| `artifacts/`（data plane） | `flow-progress-*.json`（control plane） | 作業内容と運転状態を分離し、内容を重複保存・同期しない |
| `handoff.md`（意味文脈） | `/flow --resume`（phase 復元） | resume の判断は flow state を正とし、自動マージ・相互上書きしない |
| `failures.md`（学習） | breaker / `loop-exclude`（隔離） | 知識は再発を減らすだけで、安全状態やラベルを同期・解除しない |

### §7-3 足場撤去プロトコル

撤去 gate の既定は人間の判断とする。recitation、summary 継承、artifact / index、review rotation、Stop / handoff のうち1要素だけを実セッションで無効化し、少なくとも3日かつ3セッション運用する。人間の体感上または明らかな劣化がなければ撤去してよい。

定量計測を取得できる場合も判断の補強材料に留め、統計的有意性、最低 sample 数、閾値達成を撤去条件にしない。軽量な観察指標は次とする。

| 足場 | 観察する劣化 |
| --- | --- |
| recitation | ゴールドリフトと Goal から外れた action |
| summary 継承 | 同種 error の再発 |
| artifact / index | 長出力後の path・根拠の参照回収失敗 |
| review rotation | 固定順の後半を含む観点漏れ |
| Stop / handoff | 再開後の誤 action と未完了 Plan の放置 |

既定方針は「疑わしきは外す」とする。効果が不明な足場を保守し続けるより、撤去後に問題が確認された時点で git 履歴から復元する方が安い。撤去判断、観察期間、見えた劣化だけを commit または Issue に残す。
