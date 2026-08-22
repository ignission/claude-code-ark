#!/usr/bin/env bash

ctx_error() {
  printf '%s\n' "$*" >&2
  return 1
}

ctx_has_control() {
  case "$1" in *"
"*|*""*|*"	"*) return 0 ;; *) return 1 ;; esac
}

ctx_resolve_repo() {
  local resolved top
  [ -n "${1:-}" ] || { ctx_error "unsafe repo path"; return 1; }
  ctx_has_control "$1" && { ctx_error "unsafe repo path"; return 1; }
  [ "${1#/}" != "$1" ] || { ctx_error "unsafe repo path"; return 1; }
  [ ! -L "$1" ] && [ -d "$1" ] || { ctx_error "unsafe repo path"; return 1; }
  resolved=$(cd "$1" 2>/dev/null && pwd -P) || { ctx_error "unsafe repo path"; return 1; }
  top=$(git -C "$resolved" rev-parse --show-toplevel 2>/dev/null) || { ctx_error "not a git repository"; return 1; }
  top=$(cd "$top" 2>/dev/null && pwd -P) || { ctx_error "unsafe repo path"; return 1; }
  [ "$resolved" = "$top" ] || { ctx_error "repo must be its git toplevel"; return 1; }
  printf '%s\n' "$resolved"
}

ctx_sha256() {
  local value=${1-}
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$value" | openssl dgst -sha256 | sed 's/^.*= //'
  else
    ctx_error "sha256 command unavailable"
    return 1
  fi
}

ctx_stat() {
  local stat_value uid mode extra
  stat_value=$(stat -c '%u %a' "$1" 2>/dev/null) \
    || stat_value=$(stat -f '%u %Lp' "$1" 2>/dev/null) \
    || { ctx_error "stat failed"; return 1; }
  IFS=' ' read -r uid mode extra <<EOF
$stat_value
EOF
  [ -n "$uid" ] && [ -n "$mode" ] && [ -z "$extra" ] \
    || { ctx_error "stat failed"; return 1; }
  case "$uid" in ''|*[!0-9]*) ctx_error "stat failed"; return 1 ;; esac
  case "$mode" in ''|*[!0-7]*) ctx_error "stat failed"; return 1 ;; esac
  while [ "${mode#0}" != "$mode" ]; do mode=${mode#0}; done
  printf '%s %s\n' "$uid" "${mode:-0}"
}

ctx_validate_xdg_dir() {
  local target=${1:-}
  local values uid mode extra
  [ -n "$target" ] && [ ! -L "$target" ] && [ -d "$target" ] \
    || { ctx_error "unsafe XDG directory"; return 1; }
  values=$(ctx_stat "$target") || { ctx_error "unsafe XDG directory"; return 1; }
  IFS=' ' read -r uid mode extra <<EOF
$values
EOF
  [ -z "$extra" ] && [ "$uid" = "$(id -u)" ] && [ "$mode" = 700 ] \
    || { ctx_error "unsafe XDG directory"; return 1; }
}

ctx_validate_xdg_file() {
  local target=${1:-}
  local values uid mode extra
  [ -n "$target" ] && [ ! -L "$target" ] && [ -f "$target" ] \
    || { ctx_error "unsafe XDG file"; return 1; }
  values=$(ctx_stat "$target") || { ctx_error "unsafe XDG file"; return 1; }
  IFS=' ' read -r uid mode extra <<EOF
$values
EOF
  [ -z "$extra" ] && [ "$uid" = "$(id -u)" ] && [ "$mode" = 600 ] \
    || { ctx_error "unsafe XDG file"; return 1; }
}

_ctx_missing_jq_recover_lock() {
  local lock=$1 owner=$2 owner_value owner_pid owner_token owner_extra confirmed_owner
  local now lock_mtime
  ctx_validate_xdg_dir "$lock" || return 1
  if [ ! -e "$owner" ] && [ ! -L "$owner" ]; then
    now=$(date +%s) || return 1
    lock_mtime=$(stat -c '%Y' "$lock" 2>/dev/null) \
      || lock_mtime=$(stat -f '%m' "$lock" 2>/dev/null) \
      || return 1
    case "$now$lock_mtime" in *[!0-9]*) return 1 ;; esac
    [ $((now - lock_mtime)) -ge 30 ] || return 1
    rmdir "$lock" >/dev/null 2>&1
    return $?
  fi
  ctx_validate_xdg_file "$owner" || return 1
  owner_value=$(sed -n '1p' "$owner" 2>/dev/null) || return 1
  IFS=' ' read -r owner_pid owner_token owner_extra <<EOF
$owner_value
EOF
  [ -n "$owner_pid" ] && [ -n "$owner_token" ] && [ -z "$owner_extra" ] || return 1
  case "$owner_pid" in ''|*[!0-9]*) return 1 ;; esac
  case "$owner_token" in *[!0-9-]*|'') return 1 ;; esac
  kill -0 "$owner_pid" >/dev/null 2>&1 && return 1
  ctx_validate_xdg_file "$owner" || return 1
  confirmed_owner=$(sed -n '1p' "$owner" 2>/dev/null) || return 1
  [ "$confirmed_owner" = "$owner_value" ] || return 1
  command rm -f "$owner" >/dev/null 2>&1 || return 1
  rmdir "$lock" >/dev/null 2>&1
}

_ctx_record_once_locked() {
  local raw=$1 dedupe_marker=$2 fields=$3 at raw_size entry entry_size
  if [ -e "$raw" ] || [ -L "$raw" ]; then
    ctx_validate_xdg_file "$raw" || return 1
  else
    (set -C; : >"$raw") 2>/dev/null || return 1
    chmod 600 "$raw" || return 1
    ctx_validate_xdg_file "$raw" || return 1
  fi
  if grep -F "$dedupe_marker" "$raw" >/dev/null 2>&1; then
    return 0
  fi
  raw_size=$(stat -c '%s' "$raw" 2>/dev/null) \
    || raw_size=$(stat -f '%z' "$raw" 2>/dev/null) \
    || return 1
  case "$raw_size" in ''|*[!0-9]*) return 1 ;; esac
  at=$(date -u '+%Y-%m-%dT%H:%M:%SZ') || return 1
  case "$at" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  entry=$(printf '{"at":"%s",%s' "$at" "$fields") || return 1
  entry_size=$((${#entry} + 1))
  [ "$entry_size" -le $((67108864 - raw_size)) ] || return 1
  printf '%s\n' "$entry" >>"$raw" || return 1
}

_ctx_record_once() {
  local dedupe_marker=$1 fields=$2
  local session errors raw lock owner token attempt owner_value record_status old_umask
  session=${ARK_SESSION_DIR:-}
  [ -n "$session" ] && [ "${session#/}" != "$session" ] || return 1
  ctx_has_control "$session" && return 1
  ctx_validate_xdg_dir "$session" || return 1
  errors="$session/errors"
  ctx_validate_xdg_dir "$errors" || return 1
  raw="$errors/raw.log"
  if [ -e "$raw" ] || [ -L "$raw" ]; then
    ctx_validate_xdg_file "$raw" || return 1
  fi

  lock="$errors/.raw.lock"
  owner="$lock/owner"
  token="$$-0"
  attempt=0
  while [ "$attempt" -lt 200 ]; do
    old_umask=$(umask)
    umask 077
    if mkdir -m 700 "$lock" 2>/dev/null; then
      (set -C; printf '%s %s\n' "$$" "$token" >"$owner") 2>/dev/null || {
        umask "$old_umask"
        rmdir "$lock" >/dev/null 2>&1 || :
        return 1
      }
      chmod 600 "$owner" || {
        umask "$old_umask"
        command rm -f "$owner" >/dev/null 2>&1 || :
        rmdir "$lock" >/dev/null 2>&1 || :
        return 1
      }
      umask "$old_umask"
      break
    fi
    umask "$old_umask"
    _ctx_missing_jq_recover_lock "$lock" "$owner" >/dev/null 2>&1 || :
    attempt=$((attempt + 1))
  done
  [ "$attempt" -lt 200 ] || return 1
  ctx_validate_xdg_dir "$lock" || return 1
  ctx_validate_xdg_file "$owner" || return 1
  owner_value=$(sed -n '1p' "$owner") || return 1
  [ "$owner_value" = "$$ $token" ] || return 1

  _ctx_record_once_locked "$raw" "$dedupe_marker" "$fields"
  record_status=$?
  owner_value=$(sed -n '1p' "$owner" 2>/dev/null) || owner_value=
  if [ "$owner_value" = "$$ $token" ]; then
    command rm -f "$owner" >/dev/null 2>&1 || return 1
    rmdir "$lock" >/dev/null 2>&1 || return 1
  fi
  return "$record_status"
}

_ctx_record_missing_jq() {
  local fields
  fields='"tool":"ark/context","error_type":"missing_prerequisite","exit_code":null,"is_interrupt":null,"error":"jq command unavailable","details":{}}'
  _ctx_record_once '"tool":"ark/context","error_type":"missing_prerequisite"' "$fields"
}

ctx_record_missing_jq() {
  _ctx_record_missing_jq >/dev/null 2>&1 || :
  return 0
}

ctx_record_task_parse_failure() {
  local goal_lines=${1:-} now_items=${2:-} reason=${3:-} fields
  case "$goal_lines" in ''|*[!0-9]*) return 0 ;; esac
  case "$now_items" in ''|*[!0-9]*) return 0 ;; esac
  case "$reason" in
    unsafe_task|iconv_unavailable|invalid_utf8|goal_missing|remaining_overflow|sanitize_failed|limit_failed) ;;
    *) return 0 ;;
  esac
  fields=$(printf '%s' \
    '"tool":"ark/context","error_type":"task_parse_failed","exit_code":null,"is_interrupt":null,"error":"task.md parse failed","details":{' \
    '"goal_lines":' "$goal_lines" ',"now_items":' "$now_items" ',"reason":"' "$reason" '"}}') \
    || return 0
  _ctx_record_once '"tool":"ark/context","error_type":"task_parse_failed"' "$fields" \
    >/dev/null 2>&1 || :
  return 0
}

_ctx_task_trim_marker_space() {
  local value=$1 original=$1 tab
  tab=$(printf '\t') || return 1
  while :; do
    case "$value" in
      *' ') value=${value% } ;;
      *"$tab") value=${value%"$tab"} ;;
      *'　') value=${value%　} ;;
      *) break ;;
    esac
  done
  [ "$value" != "$original" ] || return 1
  CTX_TASK_TRIMMED=$value
}

_ctx_task_extract_now() {
  local item=$1 before_now before_arrow
  case "$item" in
    *NOW) before_now=${item%NOW} ;;
    *) return 1 ;;
  esac
  _ctx_task_trim_marker_space "$before_now" || return 1
  case "$CTX_TASK_TRIMMED" in
    *'←') before_arrow=${CTX_TASK_TRIMMED%←} ;;
    *'<-') before_arrow=${CTX_TASK_TRIMMED%<-} ;;
    *) return 1 ;;
  esac
  _ctx_task_trim_marker_space "$before_arrow" || return 1
  CTX_TASK_PARSED_ITEM=$CTX_TASK_TRIMMED
}

_ctx_task_sanitize_line() {
  local cleaned expression
  cleaned=$(printf '%s' "$1" | LC_ALL=C tr '\001-\037\177' ' ') || return 1
  expression=$(printf 's/\302[\200-\237]/ /g')
  printf '%s' "$cleaned" | LC_ALL=C sed "$expression"
}

_ctx_task_limit_utf8() {
  local value=$1 maximum=$2 bytes count candidate
  bytes=$(printf '%s' "$value" | wc -c | tr -d ' ')
  if [ "$bytes" -le "$maximum" ]; then printf '%s' "$value"; return 0; fi
  count=$maximum
  while [ "$count" -ge $((maximum - 3)) ]; do
    candidate=$(printf '%s' "$value" | dd bs=1 count="$count" 2>/dev/null \
      | iconv -f UTF-8 -t UTF-8 2>/dev/null) && {
      printf '%s' "$candidate"
      return 0
    }
    count=$((count - 1))
  done
  return 1
}

ctx_parse_task_state() {
  local task=$1 section line item
  CTX_TASK_PARSED_GOAL=
  CTX_TASK_PARSED_NOW=
  CTX_TASK_PARSED_REMAINING=0
  CTX_TASK_PARSED_GOAL_COUNT=0
  CTX_TASK_PARSED_NOW_COUNT=0
  CTX_TASK_PARSE_REASON=unsafe_task
  ctx_validate_xdg_file "$task" >/dev/null 2>&1 || return 1
  CTX_TASK_PARSE_REASON=iconv_unavailable
  command -v iconv >/dev/null 2>&1 || return 1
  CTX_TASK_PARSE_REASON=invalid_utf8
  iconv -f UTF-8 -t UTF-8 "$task" >/dev/null 2>&1 || return 1
  section=
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      '## Goal') section=goal; continue ;;
      '## Plan') section=plan; continue ;;
      '## '*) section=other; continue ;;
    esac
    if [ "$section" = goal ] && [ -n "$line" ]; then
      CTX_TASK_PARSED_GOAL_COUNT=$((CTX_TASK_PARSED_GOAL_COUNT + 1))
      if [ -n "$CTX_TASK_PARSED_GOAL" ]; then
        CTX_TASK_PARSED_GOAL="$CTX_TASK_PARSED_GOAL $line"
      else
        CTX_TASK_PARSED_GOAL=$line
      fi
    elif [ "$section" = plan ]; then
      case "$line" in '- [ ] '*) CTX_TASK_PARSED_REMAINING=$((CTX_TASK_PARSED_REMAINING + 1)) ;; esac
      case "$line" in
        '- [ ] '*|'- [x] '*)
          item=${line#- \[ \] }
          [ "$item" != "$line" ] || item=${line#- \[x\] }
          if _ctx_task_extract_now "$item"; then
            CTX_TASK_PARSED_NOW_COUNT=$((CTX_TASK_PARSED_NOW_COUNT + 1))
            if [ "$CTX_TASK_PARSED_NOW_COUNT" -eq 1 ]; then
              CTX_TASK_PARSED_NOW=$CTX_TASK_PARSED_ITEM
            fi
          fi
          ;;
      esac
    fi
  done <"$task"
  CTX_TASK_PARSE_REASON=goal_missing
  [ "$CTX_TASK_PARSED_GOAL_COUNT" -ge 1 ] || return 1
  CTX_TASK_PARSE_REASON=remaining_overflow
  [ "$CTX_TASK_PARSED_REMAINING" -le 999999 ] || return 1
  CTX_TASK_PARSE_REASON=sanitize_failed
  CTX_TASK_PARSED_GOAL=$(_ctx_task_sanitize_line "$CTX_TASK_PARSED_GOAL") || return 1
  CTX_TASK_PARSED_NOW=$(_ctx_task_sanitize_line "$CTX_TASK_PARSED_NOW") || return 1
  CTX_TASK_PARSE_REASON=limit_failed
  CTX_TASK_PARSED_GOAL=$(_ctx_task_limit_utf8 "$CTX_TASK_PARSED_GOAL" 180) || return 1
  CTX_TASK_PARSED_NOW=$(_ctx_task_limit_utf8 "$CTX_TASK_PARSED_NOW" 300) || return 1
  CTX_TASK_PARSE_REASON=
}

ctx_validate_repo_path() {
  local target=${1:-}
  local expected=${2:-file}
  local presence=${3:-optional}
  local display=${4:-repo path}
  local values uid mode extra group
  CTX_VALIDATION_ERROR=
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    [ "$presence" = optional ] && return 0
    CTX_VALIDATION_ERROR="unsafe repo path: $display is missing"
    ctx_error "$CTX_VALIDATION_ERROR"
    return 1
  fi
  if [ -L "$target" ]; then
    CTX_VALIDATION_ERROR="unsafe repo path: $display is a symlink"
    ctx_error "$CTX_VALIDATION_ERROR"
    return 1
  fi
  case "$expected" in
    directory) [ -d "$target" ] || {
      CTX_VALIDATION_ERROR="unsafe repo path: $display is not a directory"
      ctx_error "$CTX_VALIDATION_ERROR"
      return 1
    } ;;
    file) [ -f "$target" ] || {
      CTX_VALIDATION_ERROR="unsafe repo path: $display is not a regular file"
      ctx_error "$CTX_VALIDATION_ERROR"
      return 1
    } ;;
    *)
      CTX_VALIDATION_ERROR="unsafe repo path: $display has an invalid expected type"
      ctx_error "$CTX_VALIDATION_ERROR"
      return 1
      ;;
  esac
  values=$(ctx_stat "$target") || {
    CTX_VALIDATION_ERROR="unsafe repo path: $display metadata unavailable"
    ctx_error "$CTX_VALIDATION_ERROR"
    return 1
  }
  IFS=' ' read -r uid mode extra <<EOF
$values
EOF
  if [ -n "$extra" ] || [ "$uid" != "$(id -u)" ]; then
    CTX_VALIDATION_ERROR="unsafe repo path: $display owner mismatch"
    ctx_error "$CTX_VALIDATION_ERROR"
    return 1
  fi
  while [ "${#mode}" -lt 3 ]; do mode="0$mode"; done
  group=${mode#${mode%??}}
  case "$group" in
    *[2367]*)
      CTX_VALIDATION_ERROR="unsafe repo path: $display is group/other writable (mode $mode)"
      ctx_error "$CTX_VALIDATION_ERROR"
      return 1
      ;;
  esac
}

ctx_secure_dir() {
  local target=$1
  local old_umask create_status
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    old_umask=$(umask)
    umask 077
    mkdir -p "$target"
    create_status=$?
    umask "$old_umask"
    [ "$create_status" -eq 0 ] || { ctx_error "cannot create XDG directory"; return 1; }
  fi
  ctx_validate_xdg_dir "$target"
}

ctx_runtime_paths() {
  local repo_arg=${1:-}
  local session_id=${2:-}
  local config_home data_home cache_home managed
  case "$session_id" in ''|*[!0-9a-f]*) ctx_error "invalid session id"; return 1 ;; esac
  [ "${#session_id}" -eq 32 ] || { ctx_error "invalid session id"; return 1; }

  ARK_REPO=$(ctx_resolve_repo "$repo_arg") || return 1
  ARK_REPO_KEY=$(ctx_sha256 "$ARK_REPO") || return 1
  case "$ARK_REPO_KEY" in *[!0-9a-f]*) ctx_error "invalid repo key"; return 1 ;; esac
  [ "${#ARK_REPO_KEY}" -eq 64 ] || { ctx_error "invalid repo key"; return 1; }

  config_home=${XDG_CONFIG_HOME:-${HOME:-}/.config}
  data_home=${XDG_DATA_HOME:-${HOME:-}/.local/share}
  cache_home=${XDG_CACHE_HOME:-${HOME:-}/.cache}
  [ -n "$config_home" ] && [ -n "$data_home" ] && [ -n "$cache_home" ] || { ctx_error "XDG home unavailable"; return 1; }
  ctx_has_control "$config_home$data_home$cache_home" && { ctx_error "unsafe XDG path"; return 1; }

  CTX_CONFIG_DIR="$config_home/ark/context"
  CTX_CONFIG_FILE="$CTX_CONFIG_DIR/config.toml"
  CTX_DATA_ROOT="$data_home/ark/context"
  CTX_CACHE_ROOT="$cache_home/ark/context"
  ARK_SESSION_ID=$session_id
  ARK_SESSION_DIR="$CTX_DATA_ROOT/sessions/$session_id"
  ARK_CACHE_DIR="$CTX_CACHE_ROOT/$session_id"
  ARK_KNOWLEDGE_DIR="$CTX_DATA_ROOT/knowledge"
  CTX_REPO_STATE_DIR="$CTX_DATA_ROOT/repos/$ARK_REPO_KEY"

  export ARK_REPO ARK_REPO_KEY ARK_SESSION_ID ARK_SESSION_DIR ARK_CACHE_DIR ARK_KNOWLEDGE_DIR
  export CTX_CONFIG_DIR CTX_CONFIG_FILE CTX_DATA_ROOT CTX_CACHE_ROOT CTX_REPO_STATE_DIR
}

ctx_runtime_prepare_base() {
  local managed
  for managed in "$CTX_CONFIG_DIR" "$CTX_DATA_ROOT" "$CTX_DATA_ROOT/sessions" \
    "$ARK_KNOWLEDGE_DIR" "$CTX_DATA_ROOT/repos" "$CTX_REPO_STATE_DIR" "$CTX_CACHE_ROOT"; do
    ctx_secure_dir "$managed" || return 1
  done
}

ctx_runtime_prepare_session() {
  local managed
  for managed in "$ARK_SESSION_DIR" "$ARK_SESSION_DIR/artifacts" "$ARK_SESSION_DIR/errors" \
    "$ARK_SESSION_DIR/knowledge" "$ARK_CACHE_DIR"; do
    ctx_secure_dir "$managed" || return 1
  done
}

ctx_runtime_resolve() {
  ctx_runtime_paths "$1" "$2" || return 1
  ctx_runtime_prepare_base || return 1
  ctx_runtime_prepare_session
}
