#!/usr/bin/env bash
# =============================================================================
# flow / flow-x safety path contract regression test
# =============================================================================
set -uo pipefail

TESTS=0
PASSES=0
FAILURES=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

assert_eq() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  TESTS=$((TESTS + 1))
  if [ "$expected" = "$actual" ]; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

assert_success() {
  local description="$1"
  shift
  TESTS=$((TESTS + 1))
  if "$@"; then
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
  fi
}

assert_failure() {
  local description="$1"
  shift
  TESTS=$((TESTS + 1))
  if "$@"; then
    FAILURES=$((FAILURES + 1))
    echo -e "${RED}FAIL${NC}: $description"
  else
    PASSES=$((PASSES + 1))
    echo -e "${GREEN}PASS${NC}: $description"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SAFETY_PATHS_LIB="$SCRIPT_DIR/../flow-safety-paths.sh"

if [ ! -f "$SAFETY_PATHS_LIB" ]; then
  echo -e "${RED}FAIL${NC}: flow-safety-paths.sh が存在しない"
  exit 1
fi

# shellcheck disable=SC1090
source "$SAFETY_PATHS_LIB"

echo "=== guard path contract ==="
assert_eq "DB schema path は 1 件" "1" "${#FLOW_GUARD_DB_SCHEMA_PATHS[@]}"
assert_eq "DB schema path" \
  "packages/server/src/lib/database.ts" "${FLOW_GUARD_DB_SCHEMA_PATHS[0]}"
assert_eq "session lifecycle path は 3 件" "3" "${#FLOW_GUARD_SESSION_LIFECYCLE_PATHS[@]}"
assert_eq "session orchestrator path" \
  "packages/server/src/lib/session-orchestrator.ts" "${FLOW_GUARD_SESSION_LIFECYCLE_PATHS[0]}"
assert_eq "tmux manager path" \
  "packages/server/src/lib/tmux-manager.ts" "${FLOW_GUARD_SESSION_LIFECYCLE_PATHS[1]}"
assert_eq "ttyd manager path" \
  "packages/server/src/lib/ttyd-manager.ts" "${FLOW_GUARD_SESSION_LIFECYCLE_PATHS[2]}"

for guard_path in "${FLOW_GUARD_DB_SCHEMA_PATHS[@]}" "${FLOW_GUARD_SESSION_LIFECYCLE_PATHS[@]}"; do
  assert_success "guard path が実在する: $guard_path" test -f "$PROJECT_DIR/$guard_path"
done

ZSH_DB_PATH=$(cd "$PROJECT_DIR" && zsh -c \
  'source .claude/lib/flow-safety-paths.sh; print -r -- ${FLOW_GUARD_DB_SCHEMA_PATHS[1]}')
assert_eq "zsh でも DB schema path を参照できる" \
  "packages/server/src/lib/database.ts" "$ZSH_DB_PATH"

TMP_REPO=$(mktemp -d "/tmp/test-flow-safety-paths.XXXXXX")
trap 'rm -rf "$TMP_REPO"' EXIT

git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" config user.email harness-test@example.invalid
git -C "$TMP_REPO" config user.name 'harness test'

for guard_path in "${FLOW_GUARD_DB_SCHEMA_PATHS[@]}" "${FLOW_GUARD_SESSION_LIFECYCLE_PATHS[@]}"; do
  mkdir -p "$TMP_REPO/$(dirname "$guard_path")"
  printf '%s\n' '// baseline' > "$TMP_REPO/$guard_path"
done
printf '%s\n' '# baseline' > "$TMP_REPO/README.md"
git -C "$TMP_REPO" add .
git -C "$TMP_REPO" commit -q -m baseline
BASELINE_SHA=$(git -C "$TMP_REPO" rev-parse HEAD)
git -C "$TMP_REPO" update-ref refs/remotes/origin/main "$BASELINE_SHA"

assert_eq "repository-local user.email" \
  "harness-test@example.invalid" "$(git -C "$TMP_REPO" config --local user.email)"
assert_eq "repository-local user.name" \
  "harness test" "$(git -C "$TMP_REPO" config --local user.name)"

reset_to_baseline() {
  git -C "$TMP_REPO" reset -q --hard "$BASELINE_SHA"
}

db_schema_changed() {
  (cd "$TMP_REPO" && flow_guard_db_schema_changed 'origin/main...HEAD')
}

db_schema_invalid_range_status() {
  local guard_status
  (cd "$TMP_REPO" && flow_guard_db_schema_changed 'nonexistent/ref...HEAD')
  guard_status=$?
  printf '%s' "$guard_status"
}

echo ""
echo "=== DB schema guard ==="
printf '%s\n' 'ALTER TABLE sessions ADD COLUMN archived INTEGER;' \
  >> "$TMP_REPO/packages/server/src/lib/database.ts"
git -C "$TMP_REPO" add packages/server/src/lib/database.ts
git -C "$TMP_REPO" commit -q -m 'database schema change'
assert_success "database.ts の schema diff を検出する" db_schema_changed
assert_eq "DB schema halt message" \
  "DB スキーマ変更検出 (packages/server/src/lib/database.ts、人間レビュー必須)" \
  "$(flow_guard_db_schema_halt_message)"

reset_to_baseline
printf '%s\n' 'CREATE TABLE ignored' >> "$TMP_REPO/README.md"
git -C "$TMP_REPO" add README.md
git -C "$TMP_REPO" commit -q -m 'unrelated schema words'
assert_failure "対象外 path の schema 語句では検出しない" db_schema_changed

reset_to_baseline
printf '%s\n' '// no schema keyword here' \
  >> "$TMP_REPO/packages/server/src/lib/database.ts"
git -C "$TMP_REPO" add packages/server/src/lib/database.ts
git -C "$TMP_REPO" commit -q -m 'database comment only'
assert_failure "database.ts の schema 語句なし diff では検出しない" db_schema_changed
assert_eq "不正な diff range の DB schema 判定は 2" "2" \
  "$(db_schema_invalid_range_status)"

FLOW_STATE_UPDATE_CALLS=0
FLOW_STATE_UPDATE_TYPE=''
FLOW_STATE_UPDATE_EXPR=''
FLOW_STATE_UPDATE_SCOPE=''

flow_state_update() {
  FLOW_STATE_UPDATE_CALLS=$((FLOW_STATE_UPDATE_CALLS + 1))
  FLOW_STATE_UPDATE_TYPE="$1"
  FLOW_STATE_UPDATE_EXPR="$2"
  FLOW_STATE_UPDATE_SCOPE="$3"
}

warn_session_lifecycle() {
  local original_dir
  original_dir=$(pwd)
  cd "$TMP_REPO" || return 1
  flow_guard_warn_session_lifecycle_change 'test-scope' 'origin/main...HEAD'
  cd "$original_dir" || return 1
}

session_lifecycle_invalid_range_status() {
  local guard_status
  (cd "$TMP_REPO" && flow_guard_session_lifecycle_changed 'nonexistent/ref...HEAD')
  guard_status=$?
  printf '%s' "$guard_status"
}

warn_session_lifecycle_invalid_range() {
  local original_dir
  local guard_status
  original_dir=$(pwd)
  cd "$TMP_REPO" || return 1
  flow_guard_warn_session_lifecycle_change 'test-scope' 'nonexistent/ref...HEAD'
  guard_status=$?
  cd "$original_dir" || return 1
  return "$guard_status"
}

echo ""
echo "=== session lifecycle guard ==="
reset_to_baseline
printf '%s\n' '// lifecycle change' \
  >> "$TMP_REPO/packages/server/src/lib/tmux-manager.ts"
git -C "$TMP_REPO" add packages/server/src/lib/tmux-manager.ts
git -C "$TMP_REPO" commit -q -m 'tmux lifecycle change'
assert_success "session lifecycle warning を発行する" warn_session_lifecycle
assert_eq "flow_state_update call count" "1" "$FLOW_STATE_UPDATE_CALLS"
assert_eq "flow_state_update type" "progress" "$FLOW_STATE_UPDATE_TYPE"
assert_eq "flow_state_update expression" \
  '.warnings += ["tmux/ttyd セッションライフサイクル変更あり、再起動時の挙動を確認すること"]' \
  "$FLOW_STATE_UPDATE_EXPR"
assert_eq "flow_state_update scope" "test-scope" "$FLOW_STATE_UPDATE_SCOPE"

reset_to_baseline
printf '%s\n' 'unrelated change' >> "$TMP_REPO/README.md"
git -C "$TMP_REPO" add README.md
git -C "$TMP_REPO" commit -q -m 'unrelated change'
assert_success "対象外 diff の warning 判定は正常終了する" warn_session_lifecycle
assert_eq "対象外 diff では warning を追加しない" "1" "$FLOW_STATE_UPDATE_CALLS"

assert_eq "不正な diff range の session lifecycle 判定は 2" "2" \
  "$(session_lifecycle_invalid_range_status)"
warn_session_lifecycle_invalid_range
assert_eq "評価不能時は warning を 1 件追加する" "2" "$FLOW_STATE_UPDATE_CALLS"
assert_eq "評価不能 warning は通常の変更 warning と区別できる" \
  '.warnings += ["tmux/ttyd セッションライフサイクル変更を判定不能 (git diff が失敗)、origin/main と diff range を確認すること"]' \
  "$FLOW_STATE_UPDATE_EXPR"

count_literal() {
  local file="$1"
  local literal="$2"
  grep -F -c -- "$literal" "$file" || true
}

echo ""
echo "=== flow / flow-x connection audit ==="
LEGACY_SERVER_LIB="server""/lib"
for skill_path in \
  "$PROJECT_DIR/.claude/skills/flow/SKILL.md" \
  "$PROJECT_DIR/.claude/skills/flow-x/SKILL.md"; do
  skill_name=$(basename "$(dirname "$skill_path")")
  assert_eq "$skill_name は共有 safety lib を 1 回 source する" "1" \
    "$(count_literal "$skill_path" 'source "$CLAUDE_PROJECT_DIR/.claude/lib/flow-safety-paths.sh"')"
  assert_eq "$skill_name は DB schema 述語を 1 回呼ぶ" "1" \
    "$(count_literal "$skill_path" "flow_guard_db_schema_changed 'origin/main...HEAD'")"
  assert_eq "$skill_name は session warning を 1 回呼ぶ" "1" \
    "$(count_literal "$skill_path" "flow_guard_warn_session_lifecycle_change \"\$SCOPE_KEY\" 'origin/main...HEAD'")"
  assert_eq "$skill_name の DB branch は halt 指示を維持する" "1" \
    "$(count_literal "$skill_path" 'halt "DB スキーマ変更検出 (${FLOW_GUARD_DB_SCHEMA_PATHS[*]}、人間レビュー必須)"')"
  assert_eq "$skill_name の P3-2 は exit code 2 で halt する" "1" \
    "$(count_literal "$skill_path" '2) halt "DB スキーマ変更の判定に失敗しました (git diff が失敗)。origin/main の存在と diff range を確認すること" ;;')"
  assert_eq "$skill_name の P3-3 は exit code 2 を扱う" "1" \
    "$(count_literal "$skill_path" "2) printf '%s\\n' 'warning: セッションライフサイクル変更を判定不能 (state に warning 記録済み)' >&2 ;;")"
  assert_eq "$skill_name の P3 に旧 DB pathspec がない" "0" \
    "$(count_literal "$skill_path" "'$LEGACY_SERVER_LIB/database.ts'")"
  assert_eq "$skill_name の P3 に旧 session pathspec がない" "0" \
    "$(count_literal "$skill_path" "'$LEGACY_SERVER_LIB/session-orchestrator.ts'")"
  assert_eq "$skill_name の P3 に旧 tmux pathspec がない" "0" \
    "$(count_literal "$skill_path" "'$LEGACY_SERVER_LIB/tmux-manager.ts'")"
  assert_eq "$skill_name の P3 に旧 ttyd pathspec がない" "0" \
    "$(count_literal "$skill_path" "'$LEGACY_SERVER_LIB/ttyd-manager.ts'")"
done

echo ""
echo "========================================"
echo "Tests: $TESTS, Passed: $PASSES, Failed: $FAILURES"
echo "========================================"
[ "$FAILURES" -eq 0 ]
