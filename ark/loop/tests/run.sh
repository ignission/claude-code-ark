#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)

for test_script in \
  test-runtime.sh \
  test-config.sh \
  test-task-template.sh \
  test-recite-todo.sh \
  test-capture-error.sh \
  test-summarize-errors.sh \
  test-claude-code-post-tool-use-failure.sh \
  test-claude-code-post-tool-batch.sh \
  test-claude-code-settings.sh \
  test-session-lifecycle.sh \
  test-claude-code-fixtures.sh; do
  if ! /bin/bash "$ROOT/ark/loop/tests/$test_script"; then
    printf 'loop harness failed: %s\n' "$test_script" >&2
    exit 1
  fi
done

printf 'loop harness: PASS\n'
