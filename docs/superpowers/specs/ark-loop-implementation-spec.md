# Ark ループエンジニアリング実装 spec

> ステータス: 確定 / Issue #332

## 目的

Manus の context engineering を Ark が起動する1セッション内の認知維持層へ写像し、後続 Issue が実装時に守る契約を固定する。実装対象は `ark/loop/` の配布物と Claude Code adapter に限定する。Issue #332 ではこの Markdown spec と既存 skill からの参照だけを変更し、実行コードは実装しない。

## 対象と非対象

- 対象: 後続 Issue #333〜#336 が実装する `ark/loop/`、XDG runtime、Claude Code adapter。
- 非対象: Ark アプリ本体の `packages/server/`、`packages/web/`、`packages/shared/`、`packages/desktop/`、既存 flow の運転仕様、Issue #332 での hook・settings・script 実装。

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
- https://rlancemartin.github.io/2025/10/15/manus/

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
- repo state: `${XDG_DATA_HOME:-$HOME/.local/share}/ark/loop/repos/$ARK_REPO_KEY/`
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
│   ├── handoff.md
│   └── stop_once
├── knowledge/
│   ├── failures.md
│   └── failures-inbox.md
└── repos/$ARK_REPO_KEY/
    ├── owner
    └── settings-ownership.json

${XDG_CACHE_HOME:-$HOME/.cache}/ark/loop/$ARK_SESSION_ID/
└── step_count
```

session data、knowledge、repo state は永続 data であり、cache は消失しても再生成できる `step_count` だけを持つ。cache に正しさに関わる状態を置かず、永続 data と相互に代用しない。`ARK_REPO_KEY` は対象 repo の canonical な絶対パスの UTF-8 bytes に対する SHA-256 lowercase hex とし、session ID に依存させない。

XDG 配下の session data、repo state、cache の各 directory は mode `0700`、その file は mode `0600` とする。使用前に各 path が期待する regular directory / regular file であり symlink でないことと、owner・mode を検証する。repo 内は `.claude`、`.claude/settings.local.json`、`.claude/settings.local.json.ark-loop-tmp` の3 pathを読み書きの直前に検証し、`.claude` は symlink でない regular directory、後二者は存在する場合に symlink でない regular file で、いずれも owner・mode が許可条件を満たさなければならない。後二者の不存在だけは許容する。検証は既存 `.claude/lib/flow-state-dir.sh` の secure default 規則に準拠し、不一致時は settings を変更せず loop を無効化する。

### §2-3 対象 repo への影響

実行時に対象 repo へ加えてよい一時変更は、注入中の `.claude/settings.local.json` と固定名の `.claude/settings.local.json.ark-loop-tmp` だけとする。両 path の ignore entry は、adapter の有効化前に versioned な repo 設定または明示的な一回限りの install で導入し、両 path が tracked でないことも確認する。entry 不足またはいずれかが tracked の対象 repo では、ignore 対象でも versioned file を変更せず、adapter は settings を変更せず loop を無効化して理由を返す。`session-init.sh` と `session-teardown.sh` は repo `.gitignore` を変更してはならない。認知維持の成果物本体と settings ownership manifest は XDG data 配下に置き、対象 repo 内に marker を作らない。

正常終了は settings 注入物と repo 側の一時 file を除去し、異常終了は次回 init が同じ回収を行う。どちらも session 中の非 Ark 変更を保持して Ark 所有 entry のない repo 設定へ収束し、実行だけで versioned file を dirty にしない。#333 では既存設定から注入、teardown、孤児回収までの round-trip fixture により内容と mode の復元を検証し、`test ! -e .claude/settings.local.json.ark-loop-tmp` と `git status --short --ignored` により ignored file を含む残留がないことを完了条件とする。

## §3 設定・状態・正本

### §3-1 config と環境変数

`session-init.sh` は Ark が tmux session を作成する前に実行し、config を読んで session ID と次の値を Ark へ返す。Ark は `CLAUDE_CONFIG_DIR` と同じ経路で `tmux new-session -e KEY=VALUE` により tmux session へ注入し、その子 process の Claude Code と hook が継承する。

| 変数 | 導出契約 |
| --- | --- |
| `ARK_SESSION_ID` | init が新規生成する衝突しない session ID。再実行時は既存 ID を保持 |
| `ARK_SESSION_DIR` | §2-2 の session data root + `$ARK_SESSION_ID` |
| `ARK_CACHE_DIR` | §2-2 の session cache root + `$ARK_SESSION_ID` |
| `ARK_RECITE_INTERVAL` | config 値。未指定時は `10` |
| `ARK_KNOWLEDGE_DIR` | §2-2 の host knowledge path |
| `ARK_REPO_KEY` | 対象 repo の canonical な絶対パスから §2-2 の規則で導出 |

tmux session は起動時の環境を生存中保持するため、稼働中 session の loop 設定は変更せず、反映には session の再起動を必要とする。将来 tmux 以外の adapter を追加する場合は、同じ継承を保証する別の伝播手段を adapter が定義する。

`ARK_SESSION_DIR` または必要な session 変数が未設定なら、全 hook は入力へ副作用を与えず即座に成功終了する。これにより Ark 外で起動した Claude Code を隔離する。config の既定は `[loop.summarize] llm = false` とする。同 table の `model = "<model-id>"` は LLM 要約に使う小型・低コストモデルの API model ID とし、`llm = true` の場合は必須、未指定または空なら機械 summary への成功 fallback とする。

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

選択肢 (a) を採用する。loop 有効セッションでは `task.md` を唯一の正本とし、作業項目を `TodoWrite` または native Task todo state に複製しない。Claude Code の native task state も `~/.claude/tasks/session-<id>/<n>.json` に `id`、`subject`、`description`、`activeForm`、`status`、`blocks`、`blockedBy` を持つ JSON file として永続化され、同 directory の `.lock` による排他がある。したがって hook や別 process から読め、process 再起動後も残る。

それでも `task.md` を正本とする根拠は次の3点である。

1. native schema には Goal、Constraints、`← NOW` に対応する field がなく、§4-1 の recitation と、§5-1 が固定する更新可能欄の不変条件を構造で表現できない。
2. native task state は Claude Code 固有の内部形式である。これを正本にすると、agent 非依存の template、ループ規約、file format と Claude Code 固有処理を分け、将来の `adapters/codex/` も同じ正本を共有する §2-1 の adapter 境界を壊す。
3. `~/.claude/tasks/` の directory 構成と JSON schema は公開契約ではなく、version 間で変わりうる。`task.md` は本 spec が定義し固定できる契約である。

native 側の `.lock` は native state 単体の排他を提供するが、選択肢 (c) の2つの表現間の整合性までは保証しないため、双方向同期は導入しない。native task の保存先の `session-<id>` は会話 transcript の session ID と別体系であり、実機でも `session-e4e83ed6` と `b32015e5-...` の不一致を確認した。hook から辿るには対応付けが必要で、解決可能だが自明ではない。

この選択は Claude Code の native todo が提供するユーザー可視の進捗表示を失う。そのコストを受け入れ、recitation schema と adapter 境界を満たす安定した単一正本を選ぶ。

この判断から次を拘束する。

- P1 の `recite-todo.sh` は `task.md` だけを読み、native todo を参照も更新もしない。
- P2 の `loop-rules.md` は native todo の使用禁止、Plan status と `← NOW` の現実に合わせた更新、Goal / Constraints の不変条件を含む。
- native todo が必要な作業は loop を無効化するか、項目を `task.md` へ移してから loop を継続する。
- 将来 adapter も native todo との同期を追加してはならない。
- Claude Code adapter の permission deny の対象は `TodoWrite`、`TaskCreate`、`TaskUpdate` の3件だけとし、指示だけで二重正本を防ごうとしてはならない。`TaskGet` / `TaskList` は read-only、`TaskOutput` / `TaskStop` は background task の参照・停止、`Task` / `Agent` は subagent 機能なので deny 対象外とする。対象 Claude Code version に tool が存在しない場合も設定エラーにせず、この制約を no-op として扱う。

### §3-4 flow state との所有権表

現行 `.claude/lib/state-io.sh:99-119` の progress は phase、gate 相当、safety、warning 等の制御面を、同 `:141-161` の context は WORK_ID、Issue、worktree 等の運転参照を持つ。本層はこの schema を拡張しない。

| 正本 | plane | 境界 |
| --- | --- | --- |
| `flow-progress-*.json` および flow state | control plane | phase、gate、safety、warning、run context |
| session `task.md` / `artifacts/` / `errors/` | data plane | 目標、進捗、作業内容、失敗原記録 |

両 plane の内容を相互コピー、双方向同期、自動マージしない。接続は WORK_ID と session path の参照だけに留め、flow state schema に認知維持用 field を追加しない。

## §4 hook 契約

hook input は非信頼データとして parse し、path、文字列、数値を検証する。全 script は loop 用環境変数が未設定なら no-op で成功し、counter を session cache 以外で共有せず、自身の失敗で本来の tool result を握りつぶさない。追加 hook の counter 更新などの fast path は合計100ms以内とする。

現行 `.claude/settings.json:52-70` の PostToolUse 2件を保持する。Claude Code は同一eventに一致する hook を並列実行し、並列 tool call では PostToolUse も呼出しごとに並行するため、adapter は settings 配列の記載順または hook 間の完了順を契約にしてはならない。

`capture-error` は実行開始後に失敗した tool だけを対象とする `PostToolUseFailure` に登録する。`recite-todo` は一連の tool call が完了して次のモデル呼出し前に一度だけ走る `PostToolBatch` に登録し、既存 PostToolUse hook・error captureの完了順へ依存しない。`PostToolBatch` の hook entry には非対応の `matcher` を付けず、生成 settings fixture でも不在を検証する。既存 hook の保持、各hookの個別100ms fast path、event種別と追加contextの実機fixtureを #333 / #335 の PR に記録する。

### §4-1 recite-todo.sh

`PostToolBatch` ごとに `ARK_CACHE_DIR/step_count` を排他的に1増加させ、`ARK_RECITE_INTERVAL`（既定10）batch ごとに次の固定形式だけを `additionalContext` へ出す。ここで batch は Claude Code が次のモデル呼出し前に完了させた tool call 群を指し、並列 tool call があっても復唱は最大1回とする。

interval 到達時は additionalContext の出力試行を1回だけ行い、host への delivery を保証しない。turn 終了や control stream close では host が block を破棄し得る。`step_count` は観測した batch 数であって delivery receipt ではない。hook には delivery acknowledgment がないため pending/retry state を作らない。10 batchごとの試行が欠落しても11回目には再送せず、欠落を次の interval まで補償しない。`task.md` が唯一の永続正本なので、配信欠落は進捗 state を変更しない。

```text
Goal: <1行>
NOW: <← NOW の付いた1行>
Remaining: <未完了件数>
```

task 全文、timestamp、artifact 本文、native todo は注入しない。概念上は1回200 token以下とし、tokenizer に依存しない実装上の代理指標として UTF-8 で600 bytes以下であることを #333 で検証する。

compaction 直後も `task.md` 正本から同じ key、同じ順序、同じ行数で再構成し、変動する prefix を加えない。interval の変更と hook の無効化だけで、他の足場に触れず recitation を撤去できなければならない。

### §4-2 capture-error.sh

`PostToolUseFailure` で通知される、実行を開始した後に失敗した tool event だけを `errors/raw.log` へ、次の field を持つ1物理行の JSONL として append する。

```json
{"at":"RFC3339","tool":"tool name","error_type":"input field or tool_error","exit_code":null,"is_interrupt":false,"error":"original error text","details":{}}
```

top-level key は例の順で固定し、`details` 内の key は bytewise 昇順とする。`error` は原文を欠落なく保存して改行だけを JSON escape する。`exit_code` は `error` から抽出できた場合だけ数値、それ以外は `null` とし、`is_interrupt` は入力値を保ち、不在時は `null` とする。`details` はこれら以外の失敗 field を元の型と値のまま保持する。成功 event は書き込まず、1 entry を必ず1物理行に収めて `L{n}-L{n}` の参照を安定させる。#335 の fixture は Bash / PowerShell、MCP failure、process 起動失敗、interrupt に同じ変換規則を適用し、原文と失敗情報が失われないことを検証する。

capture は入力にある型の正規化以外の分類、要約、「禁止手」の生成を行わず、原 tool error の表示・終了状態を変更しない。permission deny と tool input のschema / tool固有validation拒否は `PostToolUseFailure` の対象外であるため、P3では raw.log に記録しない。これらを将来の学習対象にする場合は `PermissionDenied`等の別eventを使う独立した契約を追加する。hook input の実 field 名と成功・失敗判定は #335 で実機ダンプを fixture 化して確定し、fixture にない field を推測して補わない。

### §4-3 Stop

新しい Stop hook は登録しない。現行 `.claude/settings.json:72-80` の登録先を保ち、現在 no-op の `.claude/hooks/stop-gate.sh:1-8` の実体を `on-stop.sh` 相当へ置換する。

未完了 Plan があり、`ARK_SESSION_DIR/stop_once` がなく、Stop input の `stop_hook_active` が false なら、flag を原子的に作成して `additionalContext` により1回だけ継続を要求する。同じ session の2回目以降、または `stop_hook_active` が true の場合は未完了でも Stop を通し、flag は teardown まで保持して無限 Stop loop を防ぐ。handoff生成またはflag操作に失敗しても、Stopを永久にblockしてはならない。

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

Claude Code adapter だけが、既存 `.claude/settings.local.json` の有無の記録・非破壊な loop settings 注入・復元、hook matcher、hook input JSON、`additionalContext` output、Claude Code の `allowed-tools` / permission deny を扱う。agent 非依存の template、規約、session file format に Claude Code 固有 key を入れない。

repo state directory の `settings-ownership.json` は、注入前の settings file の有無と、Ark が実際に追加した entry ごとの配列／key pathおよび canonical な permission 文字列または hook objectだけを記録し、従来の元ファイル有無 markerを置き換える。追加候補と同一の entry が既にあれば追加も記録もせず、存在しない場合だけ非破壊に追加して manifest に記録する。settings schema に所有判定用の `id` 等を加えてはならない。

復元は manifest に記録された entry のうち現在も注入時と同一内容のものだけを除去する。変更された entry は所有を放棄して残し、manifest の該当 entry に `abandoned` と記録する。manifest が元ファイルなしを示し、除去後に Ark 以外の entry が1つも残らない場合だけ settings file を削除する。既存の MCP、permission、hook、その他の key を削除・置換・並べ替えてはならない。解析不能、§2-2 の path・ownership・mode 検証失敗、または§2-3の事前ignore・tracked検証失敗の場合は、settingsを変更せずloopを無効化する。#333 は既存設定・注入・teardown・孤児回収を通す round-trip fixture と、`PostToolBatch` entry に `matcher` がない fixture を完了条件とする。

adapter は §3-3 の単一正本を変えてはならない。将来の Codex adapter も AGENTS.md と wrapper の接続に留め、native todo 同期や別の進捗正本を持ち込んではならない。

## §6 セッションライフサイクル script

### §6-1 session-init.sh

init の順序を次で固定する。

1. XDG path と対象 repo の canonical な絶対パスを解決し、§2-2 の `ARK_REPO_KEY` と repo state directory を導出する。
2. session ID を生成または再取得し、session ID と Ark が管理する owner process の PID を持つ repo state directory の `owner` marker を検査する。別 session の owner が生存中なら孤児回収と settings 注入を行わず、loop を無効化して起動を続ける。
3. owner が存在しないか消滅している場合は ownership を原子的に取得し、同じ session が owner の場合は保持する。owner は settings に触れる前に `.claude`、settings file、一時 file の§2-2の安全性と、両 file の§2-3のignore・tracked状態を検証する。失敗時は settings を変更せず loop を無効化する。成功時だけ manifest に従って孤児 Ark entry を回収し、安全性を確認済みの regular な一時 file を除去してから、session directory と cache directory を作る。
4. config を読み、§3-1 の値を Ark へ返す。
5. 新規 session に限って template を展開する。
6. host の `failures.md` を session へ read-only copy する。
7. 既存settingsのJSON schemaを検証してから、manifestへ記録するArk所有entryだけを非破壊に追加する。前提を満たさない場合は settings を変更せず loop を無効化する。

`owner` marker の取得・生存確認・消滅 owner からの引継ぎは per-repo で排他的に行う。同じ session の再実行だけは既存 ownership を継続できる。repo state directory と file は owner のみ読み書き可能にする。`settings-ownership.json` は§5-3の契約に従い、注入前の有無とArkが実際に追加したentryだけを所有の根拠とする。

注入時は現在の `.claude/settings.local.json` を読み、§5-3 の構文・型を検証する。同一 entry がない候補だけを追加対象としてmanifestへ原子的に記録し、deep mergeする。結果は repo 側の固定名 `.claude/settings.local.json.ark-loop-tmp` に書き、既存 file の mode を保持し、新規 file は mode `0600` として、同 filesystem 上の `mv` で原子的に確定する。`mktemp` 等による可変名を使わない。

復元時は現在の `.claude/settings.local.json` を読み、manifest に記録された entry と同一内容のものだけを除去し、その他の key・値・順序を保持する。変更された entry は残して manifest に `abandoned` と記録する。manifest が元設定なしを示し、除去後に Ark 以外の entry が残らない場合に限り settings file を削除し、それ以外は内容と mode を保持して固定名一時 file 経由の同 filesystem 上の `mv` で原子的に書き戻す。session 中に Claude Code やユーザーが settings.local を更新しうるため、backup による置換はそれらを失う。repo と XDG data が異なる filesystem でも rename に依存せず、安全性を確認できた孤児一時 fileだけを中間状態として除去する。

teardown を通らない kill を通常系として扱う。連続する2回の kill 後も、現在の settings、ownership manifest、破棄可能な一時 file から状態を解釈でき、次回 init の手順3で session 中の非 Ark 変更を保持したまま元の有無へ収束させる。repo state は session directory の外にあり `ARK_REPO_KEY` が session ID に依存しないため、次回 init が前回の session ID を知らなくても manifest を発見して孤児 Ark entry を回収できる。

repo `.gitignore` の `.claude/settings.local.json` と `.claude/settings.local.json.ark-loop-tmp` の完全一致2行は、adapterを有効化する前にversionedな設定または明示的な一回限りのinstallで導入する。両 path が tracked でないことも確認し、ignore entry があってもいずれかが tracked なら settings に触れず loop を無効化する。`session-init.sh`と`session-teardown.sh`は `.gitignore` を変更せず、対象 repo にそれ以外の永続変更を残さない。

`--restart <session-id>` は指定 session の `errors/summary.md` から UTF-8 で最大2000 bytesの抜粋と `errors/raw.log` の path を `{{PREV_FAILURE_SUMMARY}}` に埋める。通常 init は固定文 `なし（通常起動）` を埋める。`step_count` は新 session ごとに0から始めるが、同じ init の再実行では既存 `task.md` と進捗を上書きしない。

### §6-2 session-teardown.sh

teardown の順序を次で固定し、各段階を単独で再実行可能にする。

1. 機械的 error summary を生成する。
2. `handoff.md` を更新する。
3. 再発性のある候補を host の `failures-inbox.md` へ重複なく追記する。
4. 自分の session ID が repo state directory の `owner` marker と一致する場合に限り、manifest 記録と現在の settings.local が同一の Ark 所有 entry だけを除去し、非 Ark 変更を保持して §6-1 の原子的手順で内容と mode を書き戻す。変更済み entry は所有を放棄して残し、その結果をmanifestへ記録する。manifest が元設定なしを示し、Ark 以外の entry が残らない場合に限り file を削除する。
5. `stop_once` 等の transient flag を cleanup し、手順4の書き戻しまたは削除が成功した自分が owner の場合に限って `owner` marker を除去する。

`handoff.md` の固定項目は Goal、完了 Plan、未完了 Plan、現在の `← NOW`、artifact path と1行要約、直近の error summary path、次の最小 action、WORK_ID、session ID とする。artifact 本文と flow JSON は複製しない。

`handoff.md` は次のモデルへ意味的文脈を渡す data plane である。`/flow --resume` は現行 `.claude/skills/flow/SKILL.md:152-168` と `.claude/lib/state-io.sh` に従って phase / gate を復元する control plane である。競合時は flow state を phase の正本とし、handoff は助言情報として扱う。自動マージも相互上書きもしない。

teardown が未実行なら、次回 init は summary、handoff、ownership manifest と現在の settings が一致する Ark 所有 entry の除去をこの順で補償してから新しい注入へ進む。session 中の非 Ark 変更を保持し、最終的な repo 状態は teardown 実行済みの場合と同じでなければならない。

### §6-3 summarize-errors.sh

既定の summary は LLM を呼ばない機械的 compaction とする。JSONL を `tool`、次に `error_type` の bytewise 昇順で決定的に集計し、各 group に件数、最初の行番号、最後の行番号、`詳細: errors/raw.log:L{n}-L{m}` を出す。同じ bytes の input からは時刻や locale に依存しない同じ本文を生成する。

`config.toml` の `[loop.summarize] llm = true` のときだけ、同 table の `model` で指定した小型・低コストモデルの API に機械 summary と raw 行参照を渡し、「禁止手」付き要約を機械 summary の後へ追加する。実装にモデル名を直書きしない。config の `llm` 行の直前には `# API 従量課金が発生し、Claude プラン枠の対象外` と記す。API key 不在、model 未指定、5秒 timeout、非0終了、JSON schema 不一致、raw 行参照欠落を含む invalid output は、すべて機械 summary を保持したまま成功 fallback とする。

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
