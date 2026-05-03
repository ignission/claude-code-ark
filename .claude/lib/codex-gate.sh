#!/usr/bin/env bash
# .claude/lib/codex-gate.sh
# flow の codex review ゲート (P2/P5/P8/P9)。
#
# 利用想定:
#   source "$CLAUDE_PROJECT_DIR/.claude/lib/codex-gate.sh"
#   if codex_gate_review "P5" "$SCOPE_KEY"; then echo PASS; else echo "FAIL: $CODEX_GATE_REASON"; fi
#
# 設計判断:
#   - ゲート位置 (P2/P5/P8/P9) ごとに検査観点を固定
#   - codex CLI の exit non-zero / [P0] / [P1] 検出は fail
#   - サイクル管理 (max_p1_cycles) は呼び出し側 (flow SKILL.md の iter) で行う

set -euo pipefail

_run_codex() {
  if command -v codex >/dev/null 2>&1; then
    codex "$@"
    return
  fi
  if command -v mise >/dev/null 2>&1 && mise exec -- codex --version >/dev/null 2>&1; then
    mise exec -- codex "$@"
    return
  fi
  return 127
}

_codex_available() {
  command -v codex >/dev/null 2>&1 && return 0
  command -v mise >/dev/null 2>&1 && mise exec -- codex --version >/dev/null 2>&1 && return 0
  return 1
}

_codex_phase_focus() {
  case "$1" in
    P2) echo "DDD: 集約境界 / 値オブジェクト / ユビキタス言語 / 責務分離" ;;
    P5) echo "差分の品質 / セキュリティ / 命名 / Assertive Programming" ;;
    P8) echo "直前の auto-fix commit が CodeRabbit 指摘への直接応答として成立しているか" ;;
    P9) echo "P0 のみの sanity check (P1 は P5 で検出済み前提)" ;;
    *)  echo "general code review" ;;
  esac
}

_codex_gate_max_p1_cycles() {
  case "$1" in
    P2) echo 3 ;;
    P5) echo 2 ;;
    P8) echo 0 ;;
    P9) echo 0 ;;
    *)  echo 1 ;;
  esac
}

_codex_fingerprint() {
  local file="$1" line="$2" msg="$3"
  local input="${file}:${line}:${msg:0:80}"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$input" | sha256sum | head -c 12
  else
    printf '%s' "$input" | shasum -a 256 | head -c 12
  fi
}

# === 公開関数 ===

# codex review を起動して結果を判定する。
# 引数: $1 phase (P5/P8/P9), $2 scope_key
# 戻り値: 0=PASS, 1=FAIL
codex_gate_review() {
  local phase="$1"
  local scope_key="$2"
  local focus
  focus=$(_codex_phase_focus "$phase")

  CODEX_GATE_REASON=""
  CODEX_GATE_OUTPUT=$(mktemp "/tmp/codex-gate-${phase}-${scope_key}-XXXXXX.txt")

  if ! _codex_available; then
    CODEX_GATE_REASON="codex CLI が利用できません (PATH にも mise にも見つかりません)"
    return 1
  fi

  if [ "$phase" = "P2" ]; then
    CODEX_GATE_REASON="P2 plan レビューは codex_gate_review_plan を使用してください"
    return 1
  fi

  local repo_root
  repo_root=$(git rev-parse --show-toplevel) || {
    CODEX_GATE_REASON="git repo として認識できません"
    return 1
  }

  local prompt
  prompt="以下の git diff を「${focus}」の観点でレビューしてください。"
  prompt+=$'\n各指摘に [P0] / [P1] / [P2] の重要度マーカーを付けてください。'
  prompt+=$'\n他の観点には触れず、上記 focus に限定して判定してください。'
  prompt+=$'\nファイル探索は禁止、stdin の差分のみを根拠にしてください。'

  local exit_code
  set +e
  (
    cd "$repo_root"
    git diff --no-ext-diff origin/main...HEAD \
      | _run_codex exec --skip-git-repo-check -s read-only \
          -c 'model_reasoning_effort="high"' \
          "$prompt" 2>&1
  ) | tee "$CODEX_GATE_OUTPUT" >/dev/null
  exit_code=${PIPESTATUS[0]}
  set -e

  if [ "$exit_code" -ne 0 ]; then
    CODEX_GATE_REASON="codex review が exit $exit_code で終了"
    return 1
  fi

  if grep -qE '\[P0\]' "$CODEX_GATE_OUTPUT"; then
    CODEX_GATE_REASON="[P0] 検出 (phase=$phase)"
    return 1
  fi
  if grep -qE '\[P1\]' "$CODEX_GATE_OUTPUT"; then
    CODEX_GATE_REASON="[P1] 検出 (phase=$phase, 自動修正サイクル管理は呼び出し側)"
    return 1
  fi
  return 0
}

codex_gate_max_p1_cycles() {
  _codex_gate_max_p1_cycles "$1"
}

# P2 plan ファイルに対する DDD レビュー。
codex_gate_review_plan() {
  local plan_path="$1"
  local scope_key="$2"
  local focus
  focus=$(_codex_phase_focus "P2")

  CODEX_GATE_REASON=""
  CODEX_GATE_OUTPUT=$(mktemp "/tmp/codex-gate-P2-${scope_key}-XXXXXX.txt")

  if ! _codex_available; then
    CODEX_GATE_REASON="codex CLI が利用できません"
    return 1
  fi
  if [ ! -f "$plan_path" ]; then
    CODEX_GATE_REASON="plan ファイルが見つかりません: $plan_path"
    return 1
  fi

  local prompt
  prompt="あなたは設計レビュアです。以下の plan を ${focus} の観点でレビューしてください。"
  prompt+=$'\n各指摘に [P0] / [P1] / [P2] の重要度マーカーを付けてください。'
  prompt+=$'\nファイル探索は禁止、plan 本文 (stdin) のみを根拠にしてください。'

  local exit_code
  set +e
  _run_codex exec --skip-git-repo-check -s read-only \
    -c 'model_reasoning_effort="medium"' \
    "$prompt" < "$plan_path" \
    > "$CODEX_GATE_OUTPUT" 2>&1
  exit_code=$?
  set -e

  if [ "$exit_code" -ne 0 ]; then
    CODEX_GATE_REASON="codex exec が exit $exit_code で終了"
    return 1
  fi

  if grep -qE '\[P0\]' "$CODEX_GATE_OUTPUT"; then
    CODEX_GATE_REASON="[P0] 検出 (P2 plan)"
    return 1
  fi
  if grep -qE '\[P1\]' "$CODEX_GATE_OUTPUT"; then
    CODEX_GATE_REASON="[P1] 検出 (P2 plan, 自動修正サイクル管理は呼び出し側)"
    return 1
  fi
  return 0
}

codex_gate_collect_new_findings() {
  local scope_key="$1"
  local seen_json
  seen_json=$(jq -r '.gate_findings_seen | join("\n")' \
    "/tmp/flow-progress-${scope_key}.json" 2>/dev/null || echo "")

  grep -oE '[a-zA-Z0-9_./-]+:[0-9]+' "$CODEX_GATE_OUTPUT" 2>/dev/null \
    | sort -u \
    | while IFS=: read -r file line; do
        local msg
        msg=$(grep -F "$file:$line" "$CODEX_GATE_OUTPUT" | head -1)
        local fp
        fp=$(_codex_fingerprint "$file" "$line" "$msg")
        if ! grep -qF "$fp" <<<"$seen_json"; then
          echo "$fp"
        fi
      done
}

codex_gate_record_finding() {
  local scope_key="$1"
  local fingerprint="$2"
  if ! command -v flow_state_update >/dev/null 2>&1; then
    echo "ERROR: state-io.sh を先に source してください" >&2
    return 1
  fi
  flow_state_update progress \
    ".gate_findings_seen += [\"$fingerprint\"]" \
    "$scope_key"
}
