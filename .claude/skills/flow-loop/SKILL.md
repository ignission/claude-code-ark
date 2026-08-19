---
name: flow-loop
description: /flow-x の外殻となる運転ループ (loop engineering)。自分にアサインされた open な GitHub Issue を WIP 上限内で自動 pick して flow-x (--async-gates) で走らせ、人間承認 (GitHub PR 上のシグナル)・CI/CodeRabbit・deploy 監視・run の停滞を冪等な tick で検知して前進させる。人間ゲート (P2.5 設計承認・P10 マージ確認) は廃止せず、待ち方を「AskUserQuestion」から「PR 上の状態」に変える。
disable-model-invocation: true
argument-hint: "[tick | status | start | stop] [--dry-run | --force]"
allowed-tools: Bash, PushNotification, Read, Edit, Write, Glob, Grep, Agent, Skill, AskUserQuestion
---

# /flow-loop

`/flow-x` の**外殻となる運転ループ**。1 作業の自走 (flow-x) を「バックログを回し続ける」に昇華する。

- **原則 1: tick は何も待たない。** 毎回 state (`$FLOW_LOOP_RUNS_DIR/flow-progress-*.json`) と外部状態 (PR Review・CI・CodeRabbit・deploy) を突き合わせ、シグナルが揃った run だけ前進させて終わる (冪等)。人間の判断は「AskUserQuestion への返答」ではなく「PR 上の状態」としてループが拾う。Monitor / CronCreate による run ごとのセッション内待機 (P7 / P12) も tick のポーリングに置き換わるため、**セッションを拘束しない**。
- **原則 2: 人間ゲートは不変。** P2.5 設計承認と P10 マージ確認の 2 つは廃止しない。待ち方だけが変わる (コメント「承認」`ok` `lgtm` `approve` /「修正: …」・PR Review・Close。検知仕様は flow-x「非同期ゲートモード」)。設計承認は **plan をコミットした draft PR** で取る (plan/spec は成果物としてコミットし作業の PR に含める)。**author 本人の PR は GitHub 仕様で Approve 不可・draft も Approve 不可**のため本人はコメントで判断する (ready 化後の merge-review はチームメンバーの PR Review でも可)。
- **原則 3: run 単位の安全機構は置き換えず外側に重ねる。** flow-x の介入 2 段化・safety_level・iter 上限・pre-bash-guard はそのまま。flow-loop はブレーカー・kill switch を追加するだけ。

## 起動モード
```
/flow-loop tick            # 1 周実行 (既定。引数なしも同じ)
/flow-loop tick --dry-run  # 判定のみ。ラベル遷移 / push / PR 操作 / merge / 新規着手をしない
/flow-loop tick --force    # active_hours (稼働時間帯) 外でも実行する
/flow-loop status          # 読み取り専用ダッシュボード (run 一覧・ゲート状況・loop 設定)
/flow-loop stop            # resolved kill switch ($FLOW_LOOP_STOP) を設置
/flow-loop start           # kill switch 撤去 + ブレーカーリセット (consecutive_halts=0)
```

## 常駐運用 (自動 tick)

tick は冪等・再入安全なので、そのまま定期起動してよい。

- **対話セッションで回す (推奨)**: `/loop 30m /flow-loop tick`。
- **抑制**: `active_hours` (例 `"09-19"`・ローカル時刻・空=常時) 外の tick は何もせず終了 (`--force` で無視)。新規着手は 1 日 `daily_budget` 件 (既定 3) まで (tick 単位の 1 件制限と併用。走査・前進・マージは予算外)。
- 初回や `pick_query` 変更後は必ず `tick --dry-run` で判定を確認してから本 tick を回す。
- 停止はいつでも `/flow-loop stop` (kill switch)。ブレーカー (連続 halt 3) 発動時は通知して自動停止する。

## 状態

```bash
source "$CLAUDE_PROJECT_DIR/.claude/skills/flow-loop/lib/loop.sh"
flow_loop_init   # 冪等 (既存 loop.json は上書きしない)
```

`$FLOW_LOOP_JSON` (run state・kpi 履歴と同じ resolved runtime directory 規約)。再起動で消えたら init が既定値で再生成する。**恒久化したい設定変更 (`wip_limit` / `pick_query` 等) は `lib/loop.sh` の既定値を PR で変える**。resolved directory の loop.json 直接編集は一時的な調整用:

kill switch を直接操作する場合も resolver を迂回しない:

```bash
source "$CLAUDE_PROJECT_DIR/.claude/skills/flow-loop/lib/loop.sh"
touch "$FLOW_LOOP_STOP"    # stop
rm -f "$FLOW_LOOP_STOP"    # start
```

| フィールド | 既定 | 意味 |
| --- | --- | --- |
| `wip_limit` | 2 | 同時進行 run 数の上限 (ボトルネックは人間のレビュー帯域) |
| `engine` | `"codex"` | 新規 pick の実行エンジン (`codex`=/flow-x。`claude`=/flow は将来対応) |
| `pick_query` | 下記 | pick クエリ (`gh issue list --search` の GitHub 検索構文)。運用に合わせて手で編集してよい (init は保持する) |
| `active_hours` | `""` | 自動 tick の稼働時間帯 (`"09-19"` 形式・ローカル時刻・空=常時。`--force` で無視) |
| `daily_budget` | 3 | 1 日の新規着手 (pick) 予算。`picks_today` / `pick_date` で消費を記録 (日付跨ぎで自然リセット) |
| `consecutive_halts` | 0 | ブレーカー用の連続 halt 数 |
| `last_tick_at` | 0 | 最終 tick の unix time |

既定 pick_query: `assignee:@me is:open is:issue -label:loop-exclude -label:in-progress -label:review sort:created-asc`

slug 運用 (Issue 紐付けなし) の run は pick クエリに乗らないため pick 対象外 (手動 `/flow-x <slug> --async-gates` で起動すれば tick は走査・前進する)。

### `loop-exclude` ラベル (キュー衛生)

loop で処理**できない / させたくない** Issue には GitHub ラベル `loop-exclude` を付けて pick 対象から外す (人間が付け外しする運用マーカー)。対象の典型: 外部提供・デザイン確定待ち / DB スキーマ変更 (`packages/server/src/lib/database.ts`) が主作業の Issue (flow-x P3 で必ず halt するため loop に乗せる意味がない) / `.claude/` 配下のハーネス自改修 (ループ稼働中の自己書き換えは挙動が予測しにくい。人間同席の単発 `/flow-x` か直接作業を推奨)。

- **目的はブレーカー保護**: 処理不能 Issue を pick → 即 halt が続くと連続 halt 3 でブレーカーが落ち、処理可能な Issue まで止まる。ラベルで入口を絞る方が安い。
- ブロッカーが解消したら**ラベルを外すだけ**で次 tick から自然に候補へ戻る。state もフラグも不要。
- 除外理由は Issue 本文かコメントに残す (ラベルだけだと外してよい条件が分からなくなる)。

## tick の手順

**STEP 0 前提**: `flow_loop_stopped` が真 → 「停止中。`/flow-loop start` で再開」と報告して終了。`flow_loop_within_active_hours` が偽 (かつ `--force` なし) → 「稼働時間外 (active_hours)」と報告して終了。
**STEP 1 排他**: `flow_loop_lock` 失敗 → 「別 tick 実行中 (owner pid が死亡し、かつ lock が 1h 超なら自動回収)」と報告して終了。取得した shell の `FLOW_LOOP_LOCK_PID` / `FLOW_LOOP_LOCK_TOKEN` を tick 中保持する。**以降どの経路で終わる場合も、取得時の値を `flow_loop_unlock "$FLOW_LOOP_LOCK_PID" "$FLOW_LOOP_LOCK_TOKEN"` に渡して必ず解錠する** (別 Bash invocation からの解錠、halt 提示で中断する場合も含む)。取得 token が異なる他 tick の lock は解錠しない。
**STEP 2 ブレーカー**: `flow_loop_init` 後、`flow_loop_breaker_tripped` が真 → unlock して「ブレーカー作動中 (連続 halt ≥ 3)。原因を確認し `/flow-loop start` でリセット」と報告・終了。
**STEP 3 run 走査**: `flow_loop_active_scope_keys` で全 run を列挙し、各 state (`flow_state_read progress '.phase / .gate / .gate_mode / .safety_level / .work_id / .branch'` と `context '.worktree_path / .pr_number / .codex_pid'`) を読み、下の**シグナル判定表**に従って前進できるものから処理する。1 つの run が halt しても tick 全体は止めず、記録して次の run へ。**cwd 規律**: セッションの cwd は main worktree から動かさない。run の worktree 内の操作はサブシェル `(cd "$WT" && ...)` または `git -C "$WT"` で行う (flow-x 共通ルールと同じ。cwd を worktree に置き去りにすると以後の run 処理を壊す)。
**STEP 4 pick**: アクティブ run 数 (`flow_loop_active_count`) < `wip_limit` **かつ** `flow_loop_pick_budget_left` > 0 なら `pick_query` で候補を検索し (`gh issue list --search "$(flow_loop_read '.pick_query')" --json number,title,body,labels --limit 20`)、除外 (同 Issue の進行中 state 既存 / body 空 = DoR 未達) を除いた先頭 1 件を新規着手する。**依存検出**: 採用前に候補 Issue 本文の「連携/依存」と open PR (`gh pr list` → `gh pr diff <n> --name-only`) の変更ファイル群を照合し、作業対象が重なるものは「依存待ち」として skip (ダイジェストに列挙。ブロッカー PR のマージ後に自然に候補へ戻る)。着手は `$CLAUDE_PROJECT_DIR/.claude/skills/flow-x/SKILL.md` を Read し、`--async-gates` 相当 (`GATE_MODE="async"`) で STEP 0 から実行、**P2.5 の設計承認 park (plan コミット済み draft PR) まで**進める。着手したら `flow_loop_record_pick` で予算を消費し、metrics に `pick` を記録。**1 tick の新規着手は 1 件まで** (時間予算・暴走防止)。
**STEP 5 集計と計測**: この tick のイベントを `flow_loop_metrics_append` で記録する — pick (`pick`) / 新規 park (`park`・gate 付き) / 設計承認 (`plan-approved`) / 差し戻し検知 (`fix`) / マージ (`merged`) / 新規 halt (`halt`・理由付き) / P12 terminal (`done`・deploy_status 付き)。`flow_loop_update '.last_tick_at = '"$(date +%s)"` で更新。この tick で**新たに halt が発生**したら `.consecutive_halts += 1`、**前進があれば** (フェーズ遷移・マージ・pick 成功のいずれか) `.consecutive_halts = 0`。
**STEP 6 解錠**: `flow_loop_unlock "$FLOW_LOOP_LOCK_PID" "$FLOW_LOOP_LOCK_TOKEN"`。
**STEP 7 ダイジェスト報告と通知**: 表で報告 — 前進した run / 設計承認待ち (PR URL) / マージ承認待ち (PR URL) / halt 中 (理由) / 実装中 (detached codex) / CI・CodeRabbit 監視中 / deploy 監視中 / pick・skip (DoR 未達・依存待ち・予算到達含む)。最後に「人間が次にやること」を 1〜2 行で明示する。
**通知 (イベント駆動・スパム防止)**: この tick で**新規 park (plan-review / merge-review)・新規 halt・ブレーカー発動**が起きた場合のみ `PushNotification` を送る (本文例: 「設計承認待ち 1 件: PR #90」)。イベントの無い tick では通知しない。

`--dry-run` 時: STEP 3/4 の判定までを行い、実行する予定のアクションを列挙するだけ (ラベル遷移・push・PR 操作・merge・worktree 作成・codex 起動をしない)。

## シグナル判定表 (STEP 3)

phase は flow-x の run state (`progress.phase`)。async モードで park する点は P2.5 (plan-review)・P3 (detached codex)・P7 (CI/CodeRabbit)・P10 (merge-review)・P12 (deploy) の 5 つ (flow-x「非同期ゲートモード」参照)。

| state の状況 | 検知するシグナル | アクション |
| --- | --- | --- |
| `phase=P2.5` かつ `gate=plan-review` (設計承認待ち) | plan PR (draft) の review と会話コメント (`gh pr view <n> --json reviews,comments`) のうち **HEAD commit より後**のもの。鮮度判定・判定語彙はマージ承認と同一 (epoch 比較・最新勝ち) | 承認 → `.gate = "" \| .iter = 0`、metrics `plan-approved` → P3 (detached codex 起動・park) へ。修正 (「修正:」`fix:` / CHANGES_REQUESTED) → 本文を指摘として P2 (codex plan 再起案) → 改訂 plan を commit + push (鮮度基準の HEAD が自然に進む) → 再依頼コメント → 再 park (`iter` max 3・超過 halt)。CLOSED (unmerged) → 下記 **abort 処理** |
| `phase=P3` かつ `gate=codex-impl` (detached 実装中) | `flow_loop_pid_alive "$(flow_state_read context '.codex_pid' <KEY>)"` | alive → skip (「実装中」)。dead → `.codex_pid = 0 \| .gate = ""` にクリアし、flow-x P3 の「codex 終了後」判定 (tree 整合性・DB スキーマ検出・Claude 実装レビュー) から P4→P6 push→P7 park まで継続 |
| `phase=P7` (CI / CodeRabbit 監視) | `(cd "$WT" && check_cr_action_state)` (`.claude/lib/check-cr-threads.sh`) | `stop_monitoring_success` → P9 (Claude マージ前レビュー) を実行し P10 park へ。`run_check_coderabbit` → P8 (codex 修正 → Claude レビュー → push) を実行して P7 park に戻す。`stop_monitoring_failure` → halt。`continue_monitoring` → skip (「CI/CR 監視中」。Monitor は張らない) |
| `phase=P10` かつ `gate=merge-review` (マージ承認待ち) | PR の review と会話コメント (`gh pr view <n> --json reviews,comments`) のうち **HEAD commit より後**のもの。**投稿者権限の検証はコメント・review の両方に必須** (write 以上のみ有効。詳細は flow-x「承認検知仕様」)。**鮮度判定は epoch 比較必須** = `flow_signal_after "$sigTime" "$(flow_head_epoch "$WT")"` (`%cI` の ISO 文字列比較は TZ 差で承認を取りこぼす)。有効なシグナルが複数あれば**最新が勝つ** | 承認 (APPROVED review / 「承認」`approve` 先頭一致 / `ok` `lgtm` `👍` 単体) → P11 (merge + cleanup) を実行、metrics `merged` → P12 へ。修正 (CHANGES_REQUESTED / 「修正:」`fix:` コメント) → 本文を指摘として codex 差し戻し (P8 相当・iter 上限は flow-x 準拠)、metrics `fix`、push 後に PR へ再依頼コメント → 再 park。CLOSED (unmerged) → 下記 **abort 処理** |
| `phase=P12` (deploy 監視) | `(cd "$WT" && deploy_watch_tick "$KEY")` の stdout 最終行 `RESULT=...` (async モードでは CronCreate を張らないため tick が代行) | terminal (success/failure/timeout/poll-error/no-target) → flow-x 12-2 の terminal 手順 (Issue コメント・kpi.end_at・phase=done・cleanup_post_deploy。failure 系は PushNotification) + metrics `done`。`continue` → skip (「deploy 監視中」) |
| その他 phase (P2/P4/P5/P6/P8/P9) | **停滞判定 = `flow_state_is_stale <KEY>`** (updated_at 1h 超 + owner_pid 死亡)。fresh なら**別セッションが所有中**とみなす | fresh → skip (「進行中 (別セッション)」で列挙。横取りしない)。stale かつ `safety_level != "halt"` → flow-x の `--resume` 手順で継続。halt ならダイジェスト列挙のみ |
| シグナルなし | — | skip (ダイジェストに「待機中」として列挙) |

**重い前進は 1 tick に 1 run まで**: codex 終了後の P4→P7 継続・P2/P8 差し戻し・stale resume は時間がかかるため、1 tick では 1 run に留める。設計承認 → P3 detached 起動・マージ (P10→P11)・deploy tick などの軽い前進は複数 run 処理してよい。

**abort 処理** (PR が Close された場合): ① Issue に「中止 (PR Close による)。再開する場合は loop-exclude ラベルを外してください」をコメントし、**`loop-exclude` ラベルを付与**した上で `in-progress` ラベルを外す (Issue は open のまま = 人間が振り直す。`in-progress` を外すだけだと既定 pick_query の条件に戻って**次 tick で即再 pick されてしまう**ため、loop-exclude で明示的に隔離する)。② state 回収 `cleanup_flow_state_files "$KEY" final` (`.claude/lib/cleanup.sh`)。③ worktree は**残置** (本プロジェクトの運用どおり人間が手動で `git worktree remove` する)。

## 安全装置

- **ブレーカー**: 連続 halt が 3 に達したら tick を拒否 (STEP 2)。同じ壁に無限に突撃しない。復帰は人間が原因を見てから `/flow-loop start`。
- **kill switch**: `/flow-loop stop` (= `loop.sh` source 後に `touch "$FLOW_LOOP_STOP"`)。tick 冒頭で検知して即終了。ファイルを直接 touch する場合も resolved path を使う (「停止指示も状態」)。
- **dry-run**: 初回導入時・pick_query 変更後は `--dry-run` で判定を確認してから実行する。
- **run 単位の安全**: flow-x の介入 2 段化 (halt/warn)・safety_level 3 段階・iter 上限・DB スキーマ変更検出・pre-bash-guard (push 品質ゲート・PR コメント前 push マーカー) はそのまま効く。

## 制約 (このバージョン)

- エンジンは `codex` (= /flow-x --async-gates) のみ。`claude` (= /flow) の非同期ゲート対応は将来拡張。
- pick は GitHub Issue (assignee = 自分) のみ。slug 運用 (Issue 紐付けなし) は手動起動した run の走査・前進のみ対応。
- メトリクスの週次集計は `bash .claude/skills/flow-loop/lib/report.sh` (人間待ち vs 機械時間)。既存の `/flow-x --kpi` (自走時間 4 指標) とはレイヤが別で、両方使う。

## 関連ファイル

- `lib/loop.sh` — loop.json・lock・kill switch・ブレーカー・アクティブ run 列挙・metrics・シグナル鮮度判定 (テストは `tests/test-loop.sh`)
- `lib/report.sh` — リードタイム内訳レポート (テストは `tests/test-report.sh`)
- `../flow-x/SKILL.md` — 実行エンジン (`--async-gates` の非同期ゲート仕様は flow-x 側に定義)
- `../../lib/state-io.sh` — run state (flow / flow-x と共用。loop は読み取りが主)
- `../../lib/check-cr-threads.sh` / `../../lib/deploy-watch.sh` / `../../lib/cleanup.sh` — P7 / P12 / abort で再利用
- `../../../docs/superpowers/specs/ark-loop-implementation-spec.md` — 1セッション内認知維持ループの下層 spec
