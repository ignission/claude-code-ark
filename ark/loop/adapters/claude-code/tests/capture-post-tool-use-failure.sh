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
trap 'rmdir "$lock" >/dev/null 2>&1 || :' EXIT HUP INT TERM

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
trap - EXIT HUP INT TERM
rmdir "$lock" >/dev/null 2>&1 || exit 74
exit 0
