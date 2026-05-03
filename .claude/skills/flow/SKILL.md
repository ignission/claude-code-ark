---
name: flow
description: ark 用の自走期間最大化型自律実装 skill。worktree 作成 → plan (codex DDD) → 実装 (TDD) → ローカル検証 → push 前 codex review → push → CI/CodeRabbit 監視 → 自律修正 → マージ前 codex review → マージ確認 (人間) → cleanup → pm2 deploy 監視 (30 秒間隔・最大 3 分) を 1 セッション内で連続実行する。GitHub Issue 連携 (#NNN) または slug ベースの両方に対応。worktree は P11 で削除せず、deploy 結果を確認したユーザーが手動で削除する運用。
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Agent, Skill, AskUserQuestion, Monitor, CronCreate, CronDelete, CronList, PushNotification, WebSearch, WebFetch
argument-hint: [#<issue> | <slug>] [--resume | --from PHASE | --dry-run | --plan-only | --kpi]
---

# /flow

旧 pre-push-review / review-pr / check-coderabbit / pr-lifecycle / merge-and-cleanup を統合した ark 専用の自走 skill。**KPI は自走期間 (= ユーザー介入なしで連続して進行できる時間)**。

## 起動モード

```
/flow #123                          # GitHub Issue #123 を起点に P-1 → P12 自走
/flow html-viewer-tab               # Issue 無し: slug ベースで P-1 → P12 自走
/flow #123 --resume                 # 既存 state を読んで継続
/flow #123 --from P5                # 特定 phase から再開
/flow #123 --dry-run                # 想定動作のみ表示、実 commit/push/merge せず
/flow #123,#124 --plan-only         # 複数 Issue plan のみ作成 (旧 multi-task 互換)
/flow --kpi                         # 過去実行の KPI レポート (4 指標 markdown table)
```

## 前提・共通ルール

- main worktree からのみ起動可 (追加 worktree からの起動は P1 で物理拒否)
- 全 phase で `.claude/lib/state-io.sh` の 3 ファイル分離 state を使う (progress / kpi / context)
- AI ゲート (P2 / P5 / P8 / P9) は `.claude/lib/codex-gate.sh` を使い、fingerprint で重複抑止
- worktree は `<repo-parent>/ark-<sanitized-branch>/` のみ (Ark/Conductor 規約)
- ブランチ名:
  - Issue 紐付けあり: `feature/issue-<N>/<slug>` (例: `feature/issue-123/html-viewer-tab`)
  - Issue 紐付けなし: `feature/<slug>` / `fix/<slug>` / `chore/<slug>`
- CodeRabbit 対応の助走は `.claude/lib/check-cr-threads.sh` を使う
- マージ + main pull は `.claude/lib/cleanup.sh` を使う (worktree 削除関数は flow からは呼ばない)
- deploy 監視は `.claude/lib/deploy-watch.sh` を使う (P12)
- **deploy 対象**: ark の本番は `pm2 restart claude-code-ark`。P12 は pm2 が稼働中の場合のみ実行し、`pnpm dev` 想定なら no-target finalize する

## 介入の 2 段化

| 種別 | 動作 | 例 |
|---|---|---|
| **必須 (halt)** | `AskUserQuestion` で停止 | マージ実行 / DB スキーマ変更 / `[P0]` / scope drift 重度 / max iter / Issue 本文完全空 |
| **警告 (warn)** | `flow_state_update progress '.warnings += [...]'`、自走継続、P11 で集約確認 | Issue 本文薄い (`<TBD>`) / Issue 紐付けなし / `[P1]` 1 件 / 軽微 lint 失敗 |

## 安全装置 3 段階 (`progress.safety_level`)

| level | 動作 |
|---|---|
| `ok` | 通常自走 |
| `warn` | warnings 配列に追記し継続 |
| `limited` | 新規修正禁止、CodeRabbit 返信のみ可 (scope drift 軽度 / iter 3-4 / [P1] 検出) |
| `halt` | 自走停止、AskUserQuestion (scope drift 重度 / iter 5 / [P0] / DB schema) |

---

## STEP 0: state ロード

```bash
source "$CLAUDE_PROJECT_DIR/.claude/lib/state-io.sh"
source "$CLAUDE_PROJECT_DIR/.claude/lib/codex-gate.sh"
source "$CLAUDE_PROJECT_DIR/.claude/lib/check-cr-threads.sh"
source "$CLAUDE_PROJECT_DIR/.claude/lib/cleanup.sh"
source "$CLAUDE_PROJECT_DIR/.claude/lib/worktree/setup-worktree.sh"

# 引数パース。state-io.sh / codex-gate.sh は set -euo pipefail を有効化するので、
# 未初期化変数を参照すると abort する。MODE / FROM_PHASE / TARGET を必ず初期化してから判定する。
MODE=""
FROM_PHASE=""
TARGET=""           # ユーザー指定の引数 (#NNN または slug)
ISSUE_NUMBER=""     # 数値のみ。Issue 紐付けなしなら空
WORK_ID=""          # state SCOPE_KEY のベース。issue-<N> または slug
TICKETS_LIST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --resume)    MODE="--resume" ;;
    --from)      MODE="--resume"; FROM_PHASE="${2:?--from requires phase}"; shift ;;
    --dry-run)   MODE="--dry-run" ;;
    --plan-only) MODE="--plan-only" ;;
    --kpi)       MODE="--kpi" ;;
    --tickets)   TICKETS_LIST="$2"; shift ;;
    *)           [ -z "$TARGET" ] && TARGET="$1" || halt "unexpected arg: $1" ;;
  esac
  shift
done

# TARGET から WORK_ID と ISSUE_NUMBER を導出
if [[ "$TARGET" =~ ^#?([0-9]+)$ ]]; then
  ISSUE_NUMBER="${BASH_REMATCH[1]}"
  WORK_ID="issue-${ISSUE_NUMBER}"
elif [ -n "$TARGET" ]; then
  # slug 形式: 英数 + ハイフンのみ許可
  if ! [[ "$TARGET" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    halt "TARGET must be #<issue-number> or kebab-case slug: $TARGET"
  fi
  WORK_ID="$TARGET"
fi

SCOPE_KEY=$(flow_state_scope_key "$WORK_ID")

if flow_state_exists "$SCOPE_KEY"; then
  if flow_state_is_stale "$SCOPE_KEY"; then
    flow_state_cleanup_stale "$SCOPE_KEY"
  fi
fi

if [ "${MODE:-}" = "--resume" ] && flow_state_exists "$SCOPE_KEY"; then
  CURRENT_PHASE=$(flow_state_read progress '.phase' "$SCOPE_KEY")
  echo "resume from phase: $CURRENT_PHASE"
else
  CURRENT_PHASE="P-1"
fi

if [ -n "${FROM_PHASE:-}" ]; then
  if ! flow_state_exists "$SCOPE_KEY"; then
    halt "--from は既存 state がある場合のみ使用できます (--resume と併用 or 同 SCOPE_KEY の進行中 state が必要)"
  fi
  CURRENT_PHASE="$FROM_PHASE"
fi
```

---

## P-1: hook 互換実証

**初回のみ実行**。`<repo-parent>/ark-*` worktree で hook (post-edit-lint / pre-bash-guard / post-push-monitor 等) が壊れないか静的・動的に確認する。

### 静的チェック
- 各 hook で `CLAUDE_PROJECT_DIR` / `dirname $0` のどちらで PROJECT_ROOT を解決しているかをスポットチェックで確認

### 通過判定
- 既に Conductor / Ark で `<repo-parent>/ark-*` worktree が稼働実績ありなら通過扱い
- `--strict` モードでは hook compat test の出力を必須化 (将来拡張)

---

## P1: 着手

### 1-1. 入力検証
- `WORK_ID` が `issue-[0-9]+` または kebab-case slug 形式か検証 (不一致 → halt)
- 現在地が main worktree か検証 (`.claude/lib/worktree/setup-worktree.sh` の `create_worktree` 内で再検証あり)

### 1-2. Issue 取得 (紐付けある場合のみ)
- `ISSUE_NUMBER` が空の場合: スキップ。warn で `progress.warnings += ["Issue 紐付けなし"]`
- `ISSUE_NUMBER` がある場合:
  ```bash
  ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --json number,title,body,state,assignees,labels 2>/dev/null) \
    || halt "Issue #$ISSUE_NUMBER の取得に失敗"
  ISSUE_TITLE=$(printf '%s' "$ISSUE_JSON" | jq -r '.title')
  ISSUE_BODY=$(printf '%s' "$ISSUE_JSON" | jq -r '.body')
  ISSUE_STATE=$(printf '%s' "$ISSUE_JSON" | jq -r '.state')
  [ "$ISSUE_STATE" = "CLOSED" ] && halt "Issue #$ISSUE_NUMBER は既にクローズ済みです"
  ```
- Issue 本文完全空 → **必須介入** (halt)
- Issue 本文が `<TBD>` 含むなど薄い → **警告 (warn)**
- 未アサインなら `gh issue edit "$ISSUE_NUMBER" --add-assignee @me`

### 1-3. ブランチ命名 + 確認
- Issue タイトル (またはユーザー指定の TARGET) から slug を生成 (英数 + ハイフン、30 字以内)
- ブランチ名:
  - Issue あり: `feature/issue-<N>/<slug>`
  - Issue なし: ユーザーに `AskUserQuestion` で `feature/` `fix/` `chore/` のいずれかを選ばせる
- 命名確認は warn 扱い (halt しない)

### 1-4. worktree 作成
```bash
MAIN_ROOT=$(git rev-parse --show-toplevel)
create_worktree "$MAIN_ROOT" "$BRANCH" || halt "worktree 作成失敗"
WORKTREE_PATH=$(compute_worktree_path "$MAIN_ROOT" "$BRANCH")
cd "$WORKTREE_PATH"
```

### 1-5. state 初期化
```bash
SCOPE_KEY=$(flow_state_init "$WORK_ID" "$BRANCH" "$WORKTREE_PATH" "$ISSUE_NUMBER")
flow_state_update progress '.phase = "P2"' "$SCOPE_KEY"
```

---

## P2: プラン (codex DDD ゲート)

### 2-1. plan 作成 subagent
- `Agent` ツール (subagent_type: `flow-plan-writer`) を spawn
- プロンプトは `.claude/skills/flow/references/subagent-plan-prompt.md` のテンプレを埋めて渡す
- subagent は plan を `<WORKTREE_PATH>/docs/superpowers/plans/<TODAY>-<WORK_ID>.md` に保存して返す

### 2-2. plan ファイル存在確認
```bash
[ -f "$PLAN_PATH" ] || halt "plan ファイル未保存"
```

### 2-3. codex DDD レビュー (P2 ゲート)
```bash
if ! codex_gate_review_plan "$PLAN_PATH" "$SCOPE_KEY"; then
  case "$CODEX_GATE_REASON" in
    *"[P0]"*) halt "$CODEX_GATE_REASON" ;;
    *"[P1]"*) flow_state_update progress '.iter += 1' "$SCOPE_KEY"
              if [ "$(flow_state_read progress '.iter' "$SCOPE_KEY")" -ge 3 ]; then
                halt "P2 plan 修正サイクル 3 回超過: $CODEX_GATE_REASON"
              fi
              # subagent に plan 修正を依頼してから再実行 ;;
    *)        halt "P2 codex gate failed: $CODEX_GATE_REASON" ;;
  esac
fi
```
- PASS → P3
- `[P0]` → halt
- `[P1]` → 自動修正サイクル (subagent に plan 修正を依頼) を最大 3 回、解消しなければ halt

### 2-4. 遷移
```bash
flow_state_update progress '.phase = "P3"' "$SCOPE_KEY"
```

---

## P3: 実装 (subagent + TDD)

### 3-1. subagent-driven-development
- `Agent` ツール (subagent_type: `general-purpose` or `Explore`) を必要に応じて spawn
- subagent への指示文に必ず以下を明示:
  - **TDD (Red → Green → Refactor) 必須**
  - サーバ側 (`server/`) の変更は vitest テストを優先 (`server/lib/*.test.ts` パターン)
  - フロントエンド (`client/`) の変更は新規 vitest テストの追加は不要、必要なら e2e (Playwright) を追加
  - 共通型 (`shared/types.ts`) と Socket.IO ハンドラー (`server/index.ts`) は同時に更新する

### 3-2. DB スキーマ変更検出
ark の SQLite スキーマは `server/lib/database.ts` の `CREATE TABLE` 群で定義される。
スキーマ変更 (テーブル追加・カラム追加・rename・削除) は人間レビュー必須。
```bash
if git diff --name-only origin/main...HEAD -- 'server/lib/database.ts' | grep -q . \
  && git diff origin/main...HEAD -- 'server/lib/database.ts' | grep -qE '(CREATE TABLE|ALTER TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN)'; then
  halt "DB スキーマ変更検出 (server/lib/database.ts、人間レビュー必須)"
fi
```

### 3-3. tmux/ttyd セッションライフサイクル変更検出
セッション周りは安全装置の塊。SessionOrchestrator / TmuxManager / TtydManager のいずれかが変わったら warn:
```bash
if git diff --name-only origin/main...HEAD \
  -- 'server/lib/session-orchestrator.ts' 'server/lib/tmux-manager.ts' 'server/lib/ttyd-manager.ts' \
  | grep -q .; then
  flow_state_update progress '.warnings += ["tmux/ttyd セッションライフサイクル変更あり、再起動時の挙動を確認すること"]' "$SCOPE_KEY"
fi
```

### 3-4. 遷移
```bash
flow_state_update progress '.phase = "P4"' "$SCOPE_KEY"
```

---

## P4: ローカル検証

変更ファイルに応じて以下を実行:

| 変更対象 | コマンド (作業ディレクトリ: `$WORKTREE_PATH`) |
|---|---|
| `server/`, `client/`, `shared/` の `.ts` / `.tsx` | `pnpm check`  (= `biome check . && tsc --noEmit`) |
| `server/lib/*.test.ts` 追加・変更時 | `pnpm exec vitest run` |
| `e2e/*.spec.ts` 追加・変更時 | `pnpm test:e2e` (実機が必要なため、CI で十分なら warn でスキップ可) |
| `package.json` / `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` で整合性確認 |

失敗時は subagent で修正 → 最大 3 retry、超過したら halt。

frontend/server/e2e 変更時は `.claude/rules/` の関連ルールに従い E2E 確認 (gstack `/qa` または手動 Playwright)。

---

## P5: push 前 codex ゲート

```bash
if ! codex_gate_review "P5" "$SCOPE_KEY"; then
  case "$CODEX_GATE_REASON" in
    *"[P0]"*) halt "$CODEX_GATE_REASON" ;;
    *"[P1]"*) flow_state_update progress '.iter += 1' "$SCOPE_KEY"
              if [ "$(flow_state_read progress '.iter' "$SCOPE_KEY")" -ge 2 ]; then
                halt "P5 修正サイクル 2 回超過: $CODEX_GATE_REASON"
              fi
              # P3 に戻る (呼び出し側のループで処理) ;;
    *)        halt "P5 codex gate failed: $CODEX_GATE_REASON" ;;
  esac
fi
```

- PASS → P6
- `[P0]` → halt
- `[P1]` → 自動修正サイクル (max 2)、解消しなければ halt

PASS 後、`pre-bash-guard.sh` の `gh pr create` ガード用フラグを作成:
```bash
touch "$(git rev-parse --git-dir)/claude-pre-push-review-done"
```

このフラグは `pre-bash-guard.sh` の正規パターン (touch + git rev-parse のみ) に準拠している。

---

## P6: push

### 6-1. push 前 PR 説明同期
既存 PR がある場合は、最新コミットとの差分に合わせて PR description を確認・更新する。
```bash
PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null) || PR_NUMBER=""
if [ -n "$PR_NUMBER" ]; then
  echo "PR #$PR_NUMBER と最新コミットの差分を確認してください"
fi
```

### 6-2. push (フォアグラウンド必須)
```bash
git push origin "$(git branch --show-current)"
HEAD_SHA=$(git rev-parse --short HEAD)
flow_state_update progress ".phase = \"P7\"" "$SCOPE_KEY"
flow_state_update context ".head_sha = \"$HEAD_SHA\"" "$SCOPE_KEY"
```

**push はフォアグラウンド必須** (CodeRabbit 返信が先行するのを防ぐ、CLAUDE.md ルール)。

### 6-3. PR 未存在なら作成
PR が無ければ `gh pr create` で作成:
- タイトル: Issue 紐付けあり → `<簡潔なタイトル> (#<issue>)`、Issue なし → `<簡潔なタイトル>`
- 本文に Issue 紐付けある場合は `Closes #<issue>` を含める

---

## P7: CI / CodeRabbit 監視

```bash
check_cr_action_state
case "$CR_ACTION" in
  stop_monitoring_success)  flow_state_update progress '.phase = "P9"' "$SCOPE_KEY" ;;
  stop_monitoring_failure)  halt "CI または CodeRabbit が failure" ;;
  run_check_coderabbit)     flow_state_update progress '.phase = "P8"' "$SCOPE_KEY" ;;
  continue_monitoring)
    # Monitor で待つか、長期化なら CronCreate で +1 minute 後に skill 再起動
    schedule_p7_recheck
    ;;
esac
```

### 7-1. cron 7 日失効対応
- `flow_state_read context '.cron_task_history'` で 6 日 23 時間以上経過した task があれば `CronDelete` で削除し、新規 `CronCreate` で再作成

### 7-2. no-catch-up 対策
- `expected_fires[]` に予定時刻を記録、再起動時に missed を検出して補償処理 (CI 状態を直接 poll)

---

## P8: CodeRabbit 自律修正

### 8-1. 未解決スレッド取得
```bash
check_cr_unresolved_threads
[ "$UNRESOLVED_THREADS_COUNT" = "0" ] && { flow_state_update progress '.phase = "P7"' "$SCOPE_KEY"; return; }
```

### 8-2. 並列分類 subagent
各スレッドを `auto-fixable` / `needs-human` / `borderline` に分類。

### 8-3. 分岐
- 全件 auto-fixable → 8-4 へ
- needs-human / borderline 1 件以上 → halt

### 8-4. scope drift / iter チェック (3 段階)
```bash
# scope drift 軽度 (新規 1-2 / 1.5x) → safety_level=limited
# scope drift 重度 (新規 3+ / 2x)   → halt
ITER=$(flow_state_read progress '.iter' "$SCOPE_KEY")
[ "$ITER" -ge 5 ] && halt "max iter (5) 到達"
```

### 8-5. 修正 subagent → コミット → P8 ゲート → push → 返信

P8 codex ゲートは「直前の auto-fix commit が CodeRabbit 指摘への直接応答として成立しているか」を検証する。**修正 → コミットを先に行い、その直後に P8 ゲートを実行**する。

1. 修正 subagent で各 auto-fixable 指摘を修正
2. `git commit -m "CodeRabbit指摘対応: <要約>"`
3. P8 codex ゲートで検証:
   ```bash
   codex_gate_review "P8" "$SCOPE_KEY" || halt "P8 codex gate failed: $CODEX_GATE_REASON"
   ```
4. PASS 後に push → 各スレッドへ返信

**返信時の禁止表現** (`pre-bash-guard.sh` で検出される): 「次回」「今後」「後日」「将来的に」「スコープ外」「見送り」等。Issue 番号 (`#NNN`) を含めれば許可される。

### 8-6. iter インクリメント、P7 へ戻る
```bash
flow_state_update progress '.iter += 1 | .phase = "P7"' "$SCOPE_KEY"
```

---

## P9: マージ前 codex ゲート

```bash
codex_gate_review "P9" "$SCOPE_KEY" || halt "P9 codex gate failed: $CODEX_GATE_REASON"
```
- PASS → P10
- `[P0]` / `[P1]` → halt (マージ前は P1 でも halt)

---

## P10: マージ確認 (必須介入)

`AskUserQuestion` で「マージする / 保留する」を選ばせる。マージは破壊的なので必ず人間判断。

**質問文には必ず PR URL を含める** (ユーザーが実物を確認してから判断できるようにするため)。

```bash
PR_URL=$(gh pr view --json url -q .url)
PR_NUMBER=$(gh pr view --json number -q .number)
PR_TITLE=$(gh pr view --json title -q .title)
# AskUserQuestion の question に以下を含める:
#   "${WORK_ID} のマージ確認です。
#    PR #${PR_NUMBER}: ${PR_TITLE}
#    ${PR_URL}
#    マージしますか？"
flow_state_update kpi '.intervention_timestamps += ['$(date +%s)']' "$SCOPE_KEY"
```

---

## P11: cleanup (worktree は残す)

deploy 結果を残った worktree から追跡できるよう **worktree 削除を撤廃** し、deploy 監視 (P12) に引き継ぐ。

```bash
PR_NUMBER=$(gh pr view --json number -q .number)

# 1) PR squash merge
cleanup_merge_pr "$PR_NUMBER"

# 2) PR の merge commit SHA を gh から直接取得 (race-free)
MERGE_SHA=$(gh pr view "$PR_NUMBER" --json mergeCommit -q '.mergeCommit.oid' 2>/dev/null)
if [ -z "$MERGE_SHA" ] || [ "$MERGE_SHA" = "null" ]; then
  halt "P11: PR #$PR_NUMBER の merge commit SHA が取得できません (gh pr view 失敗)"
fi
flow_state_update context ".merge_sha = \"$MERGE_SHA\"" "$SCOPE_KEY"

# 3) main pull
MAIN_WT_ROOT=$(cleanup_pull_main)

# 4) Issue クローズヒント
ISSUE_NUMBER_FROM_STATE=$(flow_state_read context '.issue_number' "$SCOPE_KEY")
cleanup_issue_close_hint "$ISSUE_NUMBER_FROM_STATE"
# PR 本文に `Closes #<issue>` を入れていれば squash merge で自動クローズされる
```

**worktree は削除しない**。deploy 失敗時の調査やマージ後検証のため、`P12` 完了後にユーザーが
手動で `git worktree remove <path>` するか、cleanup-orphan サブコマンド (将来拡張) で削除する。

### 11-1. 警告集約確認
P11 完了直前に、`progress.warnings` に蓄積した警告をまとめて `AskUserQuestion` で表示 (1 回のみ)。

### 11-2. KPI 集計 (`end_at` は記録しない)
P11 完了時点では `kpi.end_at` を書かない。P12 (deploy 監視) が最大 3 分動く可能性があるため、
ここで end_at を記録すると KPI が deploy 待機を含まず短く出る。
**`end_at` は P12 terminal (success/failure/timeout/poll-error/no-target) で記録する。**

### 11-3. P12 へ遷移
```bash
flow_state_update progress '.phase = "P12"' "$SCOPE_KEY"
```

---

## P12: pm2 deploy 監視 (30 秒間隔・最大 3 分)

ark の本番デプロイは `pkill -f ttyd && pnpm build && pm2 restart claude-code-ark`。
P12 では以下の判定で動作を分ける:

| 条件 | 動作 |
|---|---|
| merge commit が `server/`, `client/`, `shared/`, `package.json`, `ecosystem.config.cjs`, `vite.config.ts` 等を含まない | **no-target finalize** (deploy 不要) |
| `pm2 jlist` で `claude-code-ark` が `online` でない | **no-target finalize** (`pnpm dev` 想定、デプロイ不要) |
| 上記以外 | **deploy 実行 + health 監視** (30 秒 × 5 = 最大 2.5 分) |

### 12-1. 初期化 + cron 起動

```bash
source "$CLAUDE_PROJECT_DIR/.claude/lib/deploy-watch.sh"

MERGE_SHA=$(flow_state_read context '.merge_sha' "$SCOPE_KEY")
deploy_watch_init "$SCOPE_KEY" "$MERGE_SHA"

HAS_TARGET=$(flow_state_read context '.deploy_watch.has_target' "$SCOPE_KEY")
PM2_ONLINE=$(flow_state_read context '.deploy_watch.pm2_online' "$SCOPE_KEY")

if [ "$HAS_TARGET" != "true" ] || [ "$PM2_ONLINE" != "true" ]; then
  # no-target で即 finalize (deploy_watch_tick の呼び出しで no-target 判定 + state 更新)
  deploy_watch_tick "$SCOPE_KEY"  # RESULT=no-target, fires++, result="no-target"
  flow_state_update kpi ".deploy_status = \"no-target\" | .end_at = $(date +%s)" "$SCOPE_KEY"
  flow_state_update progress '.phase = "done"' "$SCOPE_KEY"
  if [ -n "$ISSUE_NUMBER_FROM_STATE" ] && [ "$ISSUE_NUMBER_FROM_STATE" != "null" ]; then
    gh issue comment "$ISSUE_NUMBER_FROM_STATE" --body "deploy 対象 path 変更なし or pm2 未稼働、deploy 監視はスキップ" || true
  fi
  echo "deploy 対象なし、P12 を no-target で finalize"
else
  # CronCreate で 30 秒間隔の監視ジョブを起動
  CRON_PROMPT="flow P12 pm2 deploy 監視 tick (WORK_ID=$WORK_ID, SCOPE_KEY=$SCOPE_KEY)。\
以下を順に実行:\
\
1. Bash で次を実行し、stdout を取得する:\
   source $CLAUDE_PROJECT_DIR/.claude/lib/deploy-watch.sh && deploy_watch_tick \"$SCOPE_KEY\"\
\
2. 出力の最終行から RESULT を抽出: 'RESULT=<success|failure|timeout|continue|no-target|poll-error> CRON_ID=<id> FIRES=<n>'\
   RESULT 値で分岐 (terminal 系は全て kpi.end_at + progress.phase=done + CronDelete を必ず実行):\
   - success: gh issue comment (deploy_watch_format_summary 出力) + flow_state_update kpi '.deploy_status = \"success\" | .end_at = <now>' + flow_state_update progress '.phase = \"done\"' + CronDelete(CRON_ID)\
   - failure: gh issue comment + PushNotification + flow_state_update kpi '.deploy_status = \"failure\" | .end_at = <now>' + flow_state_update progress '.phase = \"done\"' + CronDelete\
   - timeout: gh issue comment + PushNotification + flow_state_update kpi '.deploy_status = \"timeout\" | .end_at = <now>' + flow_state_update progress '.phase = \"done\"' + CronDelete\
   - poll-error: gh issue comment + PushNotification + flow_state_update kpi '.deploy_status = \"poll-error\" | .end_at = <now>' + flow_state_update progress '.phase = \"done\"' + CronDelete\
   - no-target: flow_state_update kpi '.deploy_status = \"no-target\" | .end_at = <now>' + flow_state_update progress '.phase = \"done\"' + CronDelete\
   - continue: 何もせず終了 (次の fire を待つ)\
\
3. tick が exit 1 で失敗した場合: cron は残し、次回 fire で復帰を試みる。poll_failures が cap に達すると tick は exit 0 + RESULT=failure を返す。\
\
重要: terminal 系の RESULT (success/failure/timeout/poll-error/no-target) では必ず progress.phase=\"done\" に更新する。\
更新を怠ると --resume で P12 を再入してしまい cron 二重起動 / 通知再送が発生する。"

  # ↓ Claude tool call: CronCreate cron="*/30 * * * * *" prompt="$CRON_PROMPT"
  #   (30 秒間隔は cron の 6 フィールド形式)
  #   返ってきた cron_id を deploy_watch_set_cron_id "$SCOPE_KEY" "$CRON_ID" で保存
fi
```

### 12-2. tick 時の動作 (cron prompt が起動するたびに実行)

cron が発火するたびに Claude が起き、上記 prompt の指示通りに以下を実行する:

1. Bash で `source ... && deploy_watch_tick "$SCOPE_KEY"` を実行
2. **stdout 最終行の `RESULT=<value> CRON_ID=<id> FIRES=<n>` を grep して抽出**
3. RESULT 値で分岐 (**terminal 系は全て `kpi.end_at` + `progress.phase="done"` 更新 + `CronDelete` 必須**):
   - `success` → 初回 fire の build 完了後、`http://localhost:4001/api/settings` が HTTP 200 を返した
   - `failure` → build/restart 失敗、または health が 5 回連続で 200 以外
   - `timeout` → fires cap (5) または wall-clock cap (180s) 到達
   - `no-target` → has_target=false または pm2_online=false (init 時に finalize 済みの保険発火)
   - `continue` → 次の fire を待つ
4. terminal で `kpi.end_at` を必ず記録 + `progress.phase="done"` 更新

### 12-3. terminal 後のフォロー

- worktree はそのまま残す。ユーザーが結果を見て手動で `git worktree remove <path>` する
- deploy 失敗時は worktree 内で原因調査 → 追加 fix を `/flow --resume` で続行できる

### 12-4. session 終了時の挙動

`CronCreate` は durable でないため Claude session 終了で cron も消える。3 分以内に
セッションを閉じる場合は P12 が完走しない点に注意。ユーザーが session を継続している前提のフロー。

---

## --plan-only モード (旧 multi-task 互換)

`/flow #501,#502 --plan-only`:
- 各 Issue に対して P1 (worktree + Issue 取得) と P2 (plan + codex DDD) のみ実行
- supervisor は subagent を **並列** に spawn (max 5 件)
- 実装 (P3 以降) は手動運用

---

## --kpi モード

```bash
/flow --kpi
```
全 `/tmp/flow-kpi-*.json` を集計して以下の markdown table を出力:

```
| Work | 最大連続 | 総自走率 | 初介入中央値 | 待機除外 | 状態 | deploy |
|---|---|---|---|---|---|---|
| issue-123 | 145m | 78% | 12m | 89m | MERGED | success |
| html-viewer-tab | 42m | 92% | n/a | 30m | MERGED | no-target |
```

---

## 関連ファイル

- `.claude/lib/state-io.sh` — 状態 3 ファイル管理 (progress / kpi / context)
- `.claude/lib/codex-gate.sh` — codex review ゲート (P2/P5/P8/P9) + fingerprint 抑止
- `.claude/lib/check-cr-threads.sh` — CodeRabbit 未解決スレッド取得 + action 判定
- `.claude/lib/cleanup.sh` — PR squash merge + main pull + Issue クローズヒント (worktree 削除関数 `cleanup_remove_worktree` も残置するが flow P11 からは呼ばない)
- `.claude/lib/deploy-watch.sh` — P12 pm2 deploy 監視 (has_target / pm2_online 判定 + tick 状態確認 + 通知サマリ生成)
- `.claude/lib/worktree/{sanitize-branch,compute-worktree-path,setup-worktree}.sh` — worktree 規約共通 lib
- `.claude/agents/flow-plan-writer.md` — P2 plan 作成 subagent
- `.claude/skills/flow/references/subagent-plan-prompt.md` — subagent への plan 作成プロンプトテンプレ
- `.claude/hooks/check-ci-coderabbit.sh` / `.claude/hooks/fetch-unresolved-threads.sh` — 既存 hook ヘルパー
