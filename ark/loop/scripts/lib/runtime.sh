#!/usr/bin/env bash

loop_error() {
  printf '%s\n' "$*" >&2
  return 1
}

loop_has_control() {
  case "$1" in *"
"*|*""*|*"	"*) return 0 ;; *) return 1 ;; esac
}

loop_resolve_repo() {
  [ -n "${1:-}" ] || loop_error "unsafe repo path"
  loop_has_control "$1" && loop_error "unsafe repo path"
  [ "${1#/}" != "$1" ] || loop_error "unsafe repo path"
  [ ! -L "$1" ] || loop_error "unsafe repo path"
  [ -d "$1" ] || loop_error "unsafe repo path"
  resolved=$(cd "$1" 2>/dev/null && pwd -P) || loop_error "unsafe repo path"
  top=$(git -C "$resolved" rev-parse --show-toplevel 2>/dev/null) || loop_error "not a git repository"
  top=$(cd "$top" 2>/dev/null && pwd -P) || loop_error "unsafe repo path"
  [ "$resolved" = "$top" ] || loop_error "repo must be its git toplevel"
  printf '%s\n' "$resolved"
}

loop_sha256() {
  value=${1-}
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$value" | openssl dgst -sha256 | sed 's/^.*= //'
  else
    loop_error "sha256 command unavailable"
  fi
}

loop_stat() {
  stat_value=$(stat -c '%u %a' "$1" 2>/dev/null) \
    || stat_value=$(stat -f '%u %Lp' "$1" 2>/dev/null) \
    || loop_error "stat failed"
  set -- $stat_value
  [ "$#" -eq 2 ] || loop_error "stat failed"
  case "$1" in ''|*[!0-9]*) loop_error "stat failed" ;; esac
  case "$2" in ''|*[!0-7]*) loop_error "stat failed" ;; esac
  mode=$2
  while [ "${mode#0}" != "$mode" ]; do mode=${mode#0}; done
  printf '%s %s\n' "$1" "${mode:-0}"
}

loop_validate_xdg_dir() {
  target=${1:-}
  [ -n "$target" ] && [ ! -L "$target" ] && [ -d "$target" ] \
    || loop_error "unsafe XDG directory"
  values=$(loop_stat "$target") || loop_error "unsafe XDG directory"
  set -- $values
  [ "$1" = "$(id -u)" ] && [ "$2" = 700 ] || loop_error "unsafe XDG directory"
}

loop_validate_xdg_file() {
  target=${1:-}
  [ -n "$target" ] && [ ! -L "$target" ] && [ -f "$target" ] \
    || loop_error "unsafe XDG file"
  values=$(loop_stat "$target") || loop_error "unsafe XDG file"
  set -- $values
  [ "$1" = "$(id -u)" ] && [ "$2" = 600 ] || loop_error "unsafe XDG file"
}

loop_validate_repo_path() {
  target=${1:-}
  expected=${2:-file}
  presence=${3:-optional}
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    [ "$presence" = optional ] && return 0
    loop_error "unsafe repo path"
  fi
  [ ! -L "$target" ] || loop_error "unsafe repo path"
  case "$expected" in
    directory) [ -d "$target" ] || loop_error "unsafe repo path" ;;
    file) [ -f "$target" ] || loop_error "unsafe repo path" ;;
    *) loop_error "unsafe repo path" ;;
  esac
  values=$(loop_stat "$target") || loop_error "unsafe repo path"
  set -- $values
  [ "$1" = "$(id -u)" ] || loop_error "unsafe repo path"
  mode=$2
  while [ "${#mode}" -lt 3 ]; do mode="0$mode"; done
  group=${mode#${mode%??}}
  case "$group" in *[2367]*) loop_error "unsafe repo path" ;; esac
}

loop_secure_dir() {
  target=$1
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    old_umask=$(umask)
    umask 077
    mkdir -p "$target"
    create_status=$?
    umask "$old_umask"
    [ "$create_status" -eq 0 ] || loop_error "cannot create XDG directory"
  fi
  loop_validate_xdg_dir "$target"
}

loop_runtime_resolve() {
  repo_arg=${1:-}
  session_id=${2:-}
  case "$session_id" in ''|*[!0-9a-f]*) loop_error "invalid session id" ;; esac
  [ "${#session_id}" -eq 32 ] || loop_error "invalid session id"

  ARK_REPO=$(loop_resolve_repo "$repo_arg") || return 1
  ARK_REPO_KEY=$(loop_sha256 "$ARK_REPO") || return 1
  case "$ARK_REPO_KEY" in *[!0-9a-f]*) loop_error "invalid repo key" ;; esac
  [ "${#ARK_REPO_KEY}" -eq 64 ] || loop_error "invalid repo key"

  config_home=${XDG_CONFIG_HOME:-${HOME:-}/.config}
  data_home=${XDG_DATA_HOME:-${HOME:-}/.local/share}
  cache_home=${XDG_CACHE_HOME:-${HOME:-}/.cache}
  [ -n "$config_home" ] && [ -n "$data_home" ] && [ -n "$cache_home" ] || loop_error "XDG home unavailable"
  loop_has_control "$config_home$data_home$cache_home" && loop_error "unsafe XDG path"

  LOOP_CONFIG_DIR="$config_home/ark/loop"
  LOOP_CONFIG_FILE="$LOOP_CONFIG_DIR/config.toml"
  LOOP_DATA_ROOT="$data_home/ark/loop"
  LOOP_CACHE_ROOT="$cache_home/ark/loop"
  ARK_SESSION_ID=$session_id
  ARK_SESSION_DIR="$LOOP_DATA_ROOT/sessions/$session_id"
  ARK_CACHE_DIR="$LOOP_CACHE_ROOT/$session_id"
  ARK_KNOWLEDGE_DIR="$LOOP_DATA_ROOT/knowledge"
  LOOP_REPO_STATE_DIR="$LOOP_DATA_ROOT/repos/$ARK_REPO_KEY"

  for managed in \
    "$LOOP_CONFIG_DIR" "$LOOP_DATA_ROOT" "$LOOP_DATA_ROOT/sessions" \
    "$ARK_SESSION_DIR" "$ARK_SESSION_DIR/artifacts" "$ARK_SESSION_DIR/errors" \
    "$ARK_SESSION_DIR/knowledge" "$ARK_KNOWLEDGE_DIR" "$LOOP_DATA_ROOT/repos" \
    "$LOOP_REPO_STATE_DIR" "$LOOP_CACHE_ROOT" "$ARK_CACHE_DIR"; do
    loop_secure_dir "$managed" || return 1
  done
  export ARK_REPO ARK_REPO_KEY ARK_SESSION_ID ARK_SESSION_DIR ARK_CACHE_DIR ARK_KNOWLEDGE_DIR
  export LOOP_CONFIG_DIR LOOP_CONFIG_FILE LOOP_DATA_ROOT LOOP_CACHE_ROOT LOOP_REPO_STATE_DIR
}

