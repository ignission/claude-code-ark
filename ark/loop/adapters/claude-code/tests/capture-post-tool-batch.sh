#!/usr/bin/env bash
set -uo pipefail

out=${ARK_HOOK_FIXTURE_OUT:-}
[ -n "$out" ] || exit 64
[ ! -L "$out" ] || exit 65
[ -f "$out" ] || exit 66

IFS= read -r first || first=
{
  printf '%s' "$first"
  while IFS= read -r line; do
    printf '\n%s' "$line"
  done
  printf '\n'
} >"$out"

