#!/bin/bash

# push 完了マーカーの検出・SHA 解決で共有するヘルパー。
# コマンド文字列を eval せず、クォート外の && / || / ; だけを区切りとして扱う。

_push_marker_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

_push_marker_split_shell_command() {
  local command="$1"
  local current=""
  local quote=""
  local escaped=false
  local char next
  local i

  PUSH_MARKER_SEGMENTS=()
  PUSH_MARKER_SEPARATORS=()

  for ((i = 0; i < ${#command}; i++)); do
    char="${command:i:1}"

    if $escaped; then
      current+="$char"
      escaped=false
      continue
    fi

    if [ "$quote" = "'" ]; then
      current+="$char"
      [ "$char" = "'" ] && quote=""
      continue
    fi

    if [ "$quote" = '"' ]; then
      current+="$char"
      if [ "$char" = "\\" ]; then
        escaped=true
      elif [ "$char" = '"' ]; then
        quote=""
      fi
      continue
    fi

    case "$char" in
      "'"|'"')
        quote="$char"
        current+="$char"
        ;;
      \\)
        escaped=true
        current+="$char"
        ;;
      ';')
        PUSH_MARKER_SEGMENTS+=("$current")
        PUSH_MARKER_SEPARATORS+=(";")
        current=""
        ;;
      '&'|'|')
        next="${command:i+1:1}"
        if [ "$next" = "$char" ]; then
          PUSH_MARKER_SEGMENTS+=("$current")
          PUSH_MARKER_SEPARATORS+=("${char}${char}")
          current=""
          i=$((i + 1))
        else
          current+="$char"
        fi
        ;;
      *)
        current+="$char"
        ;;
    esac
  done

  PUSH_MARKER_SEGMENTS+=("$current")
}

_push_marker_is_git_push_segment() {
  local segment
  segment="$(_push_marker_trim "$1")"

  [[ "$segment" =~ ^git[[:space:]]+(.+[[:space:]]+)?push([[:space:]]|$) ]] || return 1
  [[ "$segment" =~ ^git[[:space:]]+(stash|submodule)([[:space:]]|$) ]] && return 1
  return 0
}

push_marker_detect_git_push() {
  local command="$1"
  local segment

  # shellcheck disable=SC2034 # 呼び出し元へ返す出力変数
  PUSH_MARKER_IS_GIT_PUSH=false
  # shellcheck disable=SC2034 # 呼び出し元へ返す出力変数
  PUSH_MARKER_IS_DRY_RUN=false
  _push_marker_split_shell_command "$command"

  for segment in "${PUSH_MARKER_SEGMENTS[@]}"; do
    if _push_marker_is_git_push_segment "$segment"; then
      # shellcheck disable=SC2034 # 呼び出し元へ返す出力変数
      PUSH_MARKER_IS_GIT_PUSH=true
      if [[ "$segment" =~ (^|[[:space:]])(-n|--dry-run)([[:space:]]|$) ]]; then
        # shellcheck disable=SC2034 # 呼び出し元へ返す出力変数
        PUSH_MARKER_IS_DRY_RUN=true
      fi
      return 0
    fi
  done
}

_push_marker_parse_cd_argument() {
  local segment rest char
  local quote=""
  local escaped=false
  local started=false
  local trailing=false
  local i

  segment="$(_push_marker_trim "$1")"
  [[ "$segment" =~ ^cd([[:space:]]|$) ]] || return 1
  rest="${segment#cd}"
  rest="$(_push_marker_trim "$rest")"

  if [[ "$rest" =~ ^--[[:space:]]+ ]]; then
    rest="${rest#--}"
    rest="$(_push_marker_trim "$rest")"
  fi

  PUSH_MARKER_CD_ARG=""
  PUSH_MARKER_CD_EXPAND_TILDE=false

  if [ -z "$rest" ]; then
    PUSH_MARKER_CD_ARG="${HOME:-}"
    [ -n "$PUSH_MARKER_CD_ARG" ]
    return
  fi

  for ((i = 0; i < ${#rest}; i++)); do
    char="${rest:i:1}"

    if $trailing; then
      [[ "$char" =~ [[:space:]] ]] || return 1
      continue
    fi

    if $escaped; then
      PUSH_MARKER_CD_ARG+="$char"
      escaped=false
      started=true
      continue
    fi

    if [ "$quote" = "'" ]; then
      if [ "$char" = "'" ]; then
        quote=""
      else
        PUSH_MARKER_CD_ARG+="$char"
      fi
      continue
    fi

    if [ "$quote" = '"' ]; then
      if [ "$char" = "\\" ]; then
        escaped=true
      elif [ "$char" = '"' ]; then
        quote=""
      else
        PUSH_MARKER_CD_ARG+="$char"
      fi
      continue
    fi

    case "$char" in
      "'"|'"')
        quote="$char"
        started=true
        ;;
      \\)
        escaped=true
        started=true
        ;;
      [[:space:]])
        $started && trailing=true
        ;;
      *)
        if ! $started && [ "$char" = '~' ]; then
          PUSH_MARKER_CD_EXPAND_TILDE=true
        fi
        PUSH_MARKER_CD_ARG+="$char"
        started=true
        ;;
    esac
  done

  [ -z "$quote" ] && ! $escaped && $started
}

_push_marker_resolve_cd_dir() {
  local segment="$1"
  local base_dir="$2"
  local cd_arg candidate
  local tilde_prefix=$'\x7e/'

  _push_marker_parse_cd_argument "$segment" || return 1
  cd_arg="$PUSH_MARKER_CD_ARG"

  if $PUSH_MARKER_CD_EXPAND_TILDE; then
    if [ "$cd_arg" = '~' ]; then
      cd_arg="${HOME:-}"
    elif [ "${cd_arg:0:2}" = "$tilde_prefix" ]; then
      cd_arg="${HOME:-}/${cd_arg:2}"
    fi
  fi

  [ -n "$cd_arg" ] || return 1
  if [[ "$cd_arg" = /* ]]; then
    candidate="$cd_arg"
  else
    candidate="$base_dir/$cd_arg"
  fi

  [ -d "$candidate" ] || return 1
  (cd "$candidate" && pwd -P)
}

push_marker_resolve_repo_dir() {
  local input_cwd="$1"
  local command="$2"
  local fallback_cwd="$3"
  local current_dir="$fallback_cwd"
  local segment resolved_dir
  local found_cd=false

  # Claude Code の hook 共通入力に cwd がある場合は最優先する。
  if [ -n "$input_cwd" ]; then
    printf '%s' "$input_cwd"
    return 0
  fi

  _push_marker_split_shell_command "$command"
  for segment in "${PUSH_MARKER_SEGMENTS[@]}"; do
    if resolved_dir="$(_push_marker_resolve_cd_dir "$segment" "$current_dir")"; then
      current_dir="$resolved_dir"
      found_cd=true
    fi
    if _push_marker_is_git_push_segment "$segment"; then
      printf '%s' "$current_dir"
      return 0
    fi
  done

  if $found_cd; then
    printf '%s' "$current_dir"
  else
    printf '%s' "$fallback_cwd"
  fi
}
