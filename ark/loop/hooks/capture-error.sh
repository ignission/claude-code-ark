#!/usr/bin/env bash

# Keep this guard before stdin reads and optional environment use.
if [ -z "${ARK_SESSION_DIR:-}" ]; then
  exit 0
fi

capture_stat() {
  local value uid mode size extra
  value=$(stat -c '%u %a %s' "$1" 2>/dev/null) \
    || value=$(stat -f '%u %Lp %z' "$1" 2>/dev/null) \
    || return 1
  IFS=' ' read -r uid mode size extra <<EOF
$value
EOF
  [ -n "$uid" ] && [ -n "$mode" ] && [ -n "$size" ] && [ -z "$extra" ] || return 1
  case "$uid" in ''|*[!0-9]*) return 1 ;; esac
  case "$mode" in ''|*[!0-7]*) return 1 ;; esac
  case "$size" in ''|*[!0-9]*) return 1 ;; esac
  while [ "${mode#0}" != "$mode" ]; do mode=${mode#0}; done
  printf '%s %s %s\n' "$uid" "${mode:-0}" "$size"
}

capture_safe_dir() {
  local value uid mode size extra target=$1
  [ -n "$target" ] && [ "${target#/}" != "$target" ] || return 1
  case "$target" in *"
"*|*""*|*"	"*) return 1 ;; esac
  [ ! -L "$target" ] && [ -d "$target" ] || return 1
  value=$(capture_stat "$target") || return 1
  IFS=' ' read -r uid mode size extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$uid" = "$CAPTURE_UID" ] && [ "$mode" = 700 ]
}

capture_safe_file() {
  local value uid mode size extra target=$1
  [ ! -L "$target" ] && [ -f "$target" ] || return 1
  value=$(capture_stat "$target") || return 1
  IFS=' ' read -r uid mode size extra <<EOF
$value
EOF
  [ -z "$extra" ] && [ "$uid" = "$CAPTURE_UID" ] && [ "$mode" = 600 ]
}

capture_file_size() {
  local value uid mode size extra
  value=$(capture_stat "$1") || return 1
  IFS=' ' read -r uid mode size extra <<EOF
$value
EOF
  [ -z "$extra" ] || return 1
  printf '%s\n' "$size"
}

CAPTURE_INPUT=
CAPTURE_ENTRY=
CAPTURE_LOCK=
CAPTURE_LOCK_OWNER=
CAPTURE_LOCK_TOKEN=
CAPTURE_HAVE_LOCK=0

capture_cleanup() {
  if [ "$CAPTURE_HAVE_LOCK" -eq 1 ] && [ -n "$CAPTURE_LOCK_OWNER" ] \
    && [ ! -L "$CAPTURE_LOCK_OWNER" ] && [ -f "$CAPTURE_LOCK_OWNER" ]; then
    current_owner=$(sed -n '1p' "$CAPTURE_LOCK_OWNER" 2>/dev/null) || current_owner=
    if [ "$current_owner" = "$$ $CAPTURE_LOCK_TOKEN" ]; then
      command rm -f "$CAPTURE_LOCK_OWNER" >/dev/null 2>&1 || :
      rmdir "$CAPTURE_LOCK" >/dev/null 2>&1 || :
      CAPTURE_HAVE_LOCK=0
    fi
  elif [ "$CAPTURE_HAVE_LOCK" -eq 1 ] && [ -n "$CAPTURE_LOCK" ] \
    && [ ! -L "$CAPTURE_LOCK" ] && [ -d "$CAPTURE_LOCK" ]; then
    rmdir "$CAPTURE_LOCK" >/dev/null 2>&1 || :
    CAPTURE_HAVE_LOCK=0
  fi
  if [ -n "$CAPTURE_INPUT" ] && [ ! -L "$CAPTURE_INPUT" ] && [ -f "$CAPTURE_INPUT" ]; then
    command rm -f "$CAPTURE_INPUT" >/dev/null 2>&1 || :
  fi
  if [ -n "$CAPTURE_ENTRY" ] && [ ! -L "$CAPTURE_ENTRY" ] && [ -f "$CAPTURE_ENTRY" ]; then
    command rm -f "$CAPTURE_ENTRY" >/dev/null 2>&1 || :
  fi
}

capture_try_recover_dead_lock() {
  local owner_value owner_pid owner_token owner_extra confirmed_owner
  capture_safe_dir "$CAPTURE_LOCK" || return 1
  capture_safe_file "$CAPTURE_LOCK_OWNER" || return 1
  owner_value=$(sed -n '1p' "$CAPTURE_LOCK_OWNER" 2>/dev/null) || return 1
  IFS=' ' read -r owner_pid owner_token owner_extra <<EOF
$owner_value
EOF
  [ -n "$owner_pid" ] && [ -n "$owner_token" ] && [ -z "$owner_extra" ] || return 1
  case "$owner_pid" in ''|*[!0-9]*) return 1 ;; esac
  case "$owner_token" in *[!0-9-]*|'') return 1 ;; esac
  kill -0 "$owner_pid" >/dev/null 2>&1 && return 1
  capture_safe_file "$CAPTURE_LOCK_OWNER" || return 1
  confirmed_owner=$(sed -n '1p' "$CAPTURE_LOCK_OWNER" 2>/dev/null) || return 1
  [ "$confirmed_owner" = "$owner_value" ] || return 1
  command rm -f "$CAPTURE_LOCK_OWNER" >/dev/null 2>&1 || return 1
  rmdir "$CAPTURE_LOCK" >/dev/null 2>&1
}

capture_main() {
  local session errors raw canonical_session sequence input_size entry_size
  local at attempt raw_size marker_value
  CAPTURE_UID=$(id -u) || return 1
  session=${ARK_SESSION_DIR:-}
  capture_safe_dir "$session" || return 1
  canonical_session=$(cd "$session" 2>/dev/null && pwd -P) || return 1
  [ "$canonical_session" = "$session" ] || return 1
  errors="$session/errors"
  capture_safe_dir "$errors" || return 1
  raw="$errors/raw.log"
  if [ -e "$raw" ] || [ -L "$raw" ]; then
    capture_safe_file "$raw" || return 1
  fi

  umask 077
  sequence=0
  while [ "$sequence" -lt 100 ]; do
    CAPTURE_INPUT="$errors/.raw-input-$$-$sequence"
    if (set -C; : >"$CAPTURE_INPUT") 2>/dev/null; then break; fi
    CAPTURE_INPUT=
    sequence=$((sequence + 1))
  done
  [ -n "$CAPTURE_INPUT" ] || return 1
  chmod 600 "$CAPTURE_INPUT" || return 1
  head -c 1048577 >"$CAPTURE_INPUT" 2>/dev/null || return 1
  input_size=$(capture_file_size "$CAPTURE_INPUT") || return 1
  [ "$input_size" -le 1048576 ] || return 1
  command -v iconv >/dev/null 2>&1 || return 1
  iconv -f UTF-8 -t UTF-8 "$CAPTURE_INPUT" >/dev/null 2>&1 || return 1

  sequence=0
  while [ "$sequence" -lt 100 ]; do
    CAPTURE_ENTRY="$errors/.raw-entry-$$-$sequence"
    if (set -C; : >"$CAPTURE_ENTRY") 2>/dev/null; then break; fi
    CAPTURE_ENTRY=
    sequence=$((sequence + 1))
  done
  [ -n "$CAPTURE_ENTRY" ] || return 1
  chmod 600 "$CAPTURE_ENTRY" || return 1

  at=$(date -u '+%Y-%m-%dT%H:%M:%SZ') || return 1
  case "$at" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  LC_ALL=C jq -ce --arg at "$at" '
    select(
      type == "object"
      and keys_unsorted == ["tool","error_type","exit_code","is_interrupt","error","details"]
      and (.tool | type) == "string"
      and (.error_type | type) == "string"
      and ((.exit_code == null) or ((.exit_code | type) == "number" and .exit_code == (.exit_code | floor)))
      and ((.is_interrupt == null) or ((.is_interrupt | type) == "boolean"))
      and (.error | type) == "string"
      and (.details | type) == "object"
    )
    | {
        at:$at,
        tool:.tool,
        error_type:.error_type,
        exit_code:.exit_code,
        is_interrupt:.is_interrupt,
        error:.error,
        details:(.details | to_entries | sort_by(.key) | from_entries)
      }
  ' "$CAPTURE_INPUT" >"$CAPTURE_ENTRY" || return 1
  [ "$(wc -l <"$CAPTURE_ENTRY" | tr -d ' ')" = 1 ] || return 1
  entry_size=$(capture_file_size "$CAPTURE_ENTRY") || return 1
  [ "$entry_size" -le 1048576 ] || return 1

  CAPTURE_LOCK="$errors/.raw.lock"
  CAPTURE_LOCK_OWNER="$CAPTURE_LOCK/owner"
  CAPTURE_LOCK_TOKEN="$$-$sequence"
  attempt=0
  while [ "$attempt" -lt 200 ]; do
    if mkdir -m 700 "$CAPTURE_LOCK" 2>/dev/null; then
      CAPTURE_HAVE_LOCK=1
      (set -C; printf '%s %s\n' "$$" "$CAPTURE_LOCK_TOKEN" >"$CAPTURE_LOCK_OWNER") 2>/dev/null \
        || return 1
      chmod 600 "$CAPTURE_LOCK_OWNER" || return 1
      break
    fi
    capture_try_recover_dead_lock >/dev/null 2>&1 || :
    attempt=$((attempt + 1))
  done
  [ "$CAPTURE_HAVE_LOCK" -eq 1 ] || return 1
  capture_safe_dir "$CAPTURE_LOCK" || return 1
  capture_safe_file "$CAPTURE_LOCK_OWNER" || return 1
  marker_value=$(sed -n '1p' "$CAPTURE_LOCK_OWNER") || return 1
  [ "$marker_value" = "$$ $CAPTURE_LOCK_TOKEN" ] || return 1

  if [ -e "$raw" ] || [ -L "$raw" ]; then
    capture_safe_file "$raw" || return 1
  else
    (set -C; : >"$raw") 2>/dev/null || return 1
    chmod 600 "$raw" || return 1
    capture_safe_file "$raw" || return 1
  fi
  raw_size=$(capture_file_size "$raw") || return 1
  [ "$raw_size" -le 67108864 ] || return 1
  [ "$entry_size" -le $((67108864 - raw_size)) ] || return 1
  command cat "$CAPTURE_ENTRY" >>"$raw" || return 1
  capture_cleanup
  return 0
}

trap capture_cleanup EXIT HUP INT TERM
capture_main >/dev/null 2>&1 || :
exit 0
