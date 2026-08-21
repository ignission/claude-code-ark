#!/usr/bin/env bash
set -uo pipefail

out=${ARK_HOOK_FIXTURE_OUT:-}
[ -n "$out" ] || exit 64
[ ! -L "$out" ] || exit 65
[ -f "$out" ] || exit 66

owner=
if owner=$(stat -c '%u' "$out" 2>/dev/null); then
  :
elif owner=$(stat -f '%u' "$out" 2>/dev/null); then
  :
else
  exit 67
fi
[ "$owner" = "$(id -u)" ] || exit 68

lock=${out}.capture-lock
mkdir -m 700 "$lock" 2>/dev/null || exit 69

invocations=${ARK_HOOK_FIXTURE_INVOCATIONS:-}
if [ -n "$invocations" ]; then
  [ ! -L "$invocations" ] || exit 75
  [ -d "$invocations" ] || exit 76
  invocation_owner=
  if invocation_owner=$(stat -c '%u' "$invocations" 2>/dev/null); then
    :
  elif invocation_owner=$(stat -f '%u' "$invocations" 2>/dev/null); then
    :
  else
    exit 77
  fi
  [ "$invocation_owner" = "$(id -u)" ] || exit 78
  invocation_marker="$invocations/invocation-$$"
  (set -C; : >"$invocation_marker") 2>/dev/null || exit 79
  chmod 600 "$invocation_marker" 2>/dev/null || exit 80
fi

tmp=${out}.capture-$$
[ ! -e "$tmp" ] && [ ! -L "$tmp" ] || exit 70
umask 077
(
  IFS= read -r first || first=
  printf '%s' "$first"
  while IFS= read -r line; do
    printf '\n%s' "$line"
  done
  printf '\n'
) >"$tmp" || exit 71
[ -f "$tmp" ] && [ ! -L "$tmp" ] || exit 72
mv "$tmp" "$out" || exit 73
exit 0
