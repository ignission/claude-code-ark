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
  local stat_value mode
  stat_value=$(stat -c '%u %a' "$1" 2>/dev/null) \
    || stat_value=$(stat -f '%u %Lp' "$1" 2>/dev/null) \
    || { ctx_error "stat failed"; return 1; }
  set -- $stat_value
  [ "$#" -eq 2 ] || { ctx_error "stat failed"; return 1; }
  case "$1" in ''|*[!0-9]*) ctx_error "stat failed"; return 1 ;; esac
  case "$2" in ''|*[!0-7]*) ctx_error "stat failed"; return 1 ;; esac
  mode=$2
  while [ "${mode#0}" != "$mode" ]; do mode=${mode#0}; done
  printf '%s %s\n' "$1" "${mode:-0}"
}

ctx_validate_xdg_dir() {
  local target=${1:-}
  local values
  [ -n "$target" ] && [ ! -L "$target" ] && [ -d "$target" ] \
    || { ctx_error "unsafe XDG directory"; return 1; }
  values=$(ctx_stat "$target") || { ctx_error "unsafe XDG directory"; return 1; }
  set -- $values
  [ "$1" = "$(id -u)" ] && [ "$2" = 700 ] || { ctx_error "unsafe XDG directory"; return 1; }
}

ctx_validate_xdg_file() {
  local target=${1:-}
  local values
  [ -n "$target" ] && [ ! -L "$target" ] && [ -f "$target" ] \
    || { ctx_error "unsafe XDG file"; return 1; }
  values=$(ctx_stat "$target") || { ctx_error "unsafe XDG file"; return 1; }
  set -- $values
  [ "$1" = "$(id -u)" ] && [ "$2" = 600 ] || { ctx_error "unsafe XDG file"; return 1; }
}

ctx_validate_repo_path() {
  local target=${1:-}
  local expected=${2:-file}
  local presence=${3:-optional}
  local display=${4:-repo path}
  local values mode group
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
  set -- $values
  if [ "$1" != "$(id -u)" ]; then
    CTX_VALIDATION_ERROR="unsafe repo path: $display owner mismatch"
    ctx_error "$CTX_VALIDATION_ERROR"
    return 1
  fi
  mode=$2
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
