#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)

for test_script in \
  test-runtime.sh \
  test-config.sh \
  test-task-template.sh \
  test-review-template.sh \
  test-portable-commands.sh \
  test-stop-gate.sh \
  test-handoff.sh \
  test-failures-knowledge.sh \
  test-recite-todo.sh \
  test-capture-error.sh \
  test-summarize-errors.sh \
  test-claude-code-post-tool-use-failure.sh \
  test-claude-code-post-tool-batch.sh \
  test-claude-code-session-start.sh \
  test-claude-code-settings.sh \
  test-session-lifecycle.sh \
  test-claude-code-fixtures.sh; do
  if ! /bin/bash "$ROOT/ark/context/tests/$test_script"; then
    printf 'context harness failed: %s\n' "$test_script" >&2
    exit 1
  fi
done

printf 'context harness: PASS\n'
