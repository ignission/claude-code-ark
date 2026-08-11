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

_push_marker_tokenize_segment() {
  local input="$1"
  local token=""
  local quote=""
  local escaped=false
  local started=false
  local char
  local i

  PUSH_MARKER_TOKENS=()

  for ((i = 0; i < ${#input}; i++)); do
    char="${input:i:1}"

    if $escaped; then
      token+="$char"
      escaped=false
      started=true
      continue
    fi

    if [ "$quote" = "'" ]; then
      if [ "$char" = "'" ]; then
        quote=""
      else
        token+="$char"
      fi
      continue
    fi

    if [ "$quote" = '"' ]; then
      if [ "$char" = "\\" ]; then
        escaped=true
      elif [ "$char" = '"' ]; then
        quote=""
      else
        token+="$char"
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
        if $started; then
          PUSH_MARKER_TOKENS+=("$token")
          token=""
          started=false
        fi
        ;;
      *)
        token+="$char"
        started=true
        ;;
    esac
  done

  [ -z "$quote" ] && ! $escaped || return 1
  $started && PUSH_MARKER_TOKENS+=("$token")
  return 0
}

_push_marker_is_git_push_segment() {
  local segment token
  local i=1

  segment="$(_push_marker_trim "$1")"
  _push_marker_tokenize_segment "$segment" || return 1
  [ "${#PUSH_MARKER_TOKENS[@]}" -gt 1 ] || return 1
  [ "${PUSH_MARKER_TOKENS[0]}" = "git" ] || return 1

  while [ "$i" -lt "${#PUSH_MARKER_TOKENS[@]}" ]; do
    token="${PUSH_MARKER_TOKENS[$i]}"
    case "$token" in
      -C|-c|--git-dir|--work-tree|--exec-path|--namespace|--super-prefix|--config-env)
        i=$((i + 2))
        ;;
      --git-dir=*|--work-tree=*|--exec-path=*|--namespace=*|--super-prefix=*|--config-env=*)
        i=$((i + 1))
        ;;
      --)
        i=$((i + 1))
        break
        ;;
      -*)
        i=$((i + 1))
        ;;
      *)
        break
        ;;
    esac
  done

  [ "$i" -lt "${#PUSH_MARKER_TOKENS[@]}" ] || return 1
  [ "${PUSH_MARKER_TOKENS[$i]}" = "push" ]
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
  local input_dir=""
  local fallback_dir=""
  local current_dir=""
  local segment resolved_dir
  local found_cd=false

  if [ -d "$input_cwd" ]; then
    input_dir=$(cd "$input_cwd" && pwd -P)
    current_dir="$input_dir"
  fi
  if [ -d "$fallback_cwd" ]; then
    fallback_dir=$(cd "$fallback_cwd" && pwd -P)
    [ -n "$current_dir" ] || current_dir="$fallback_dir"
  fi

  # コマンド中の cd は、hook 入力の cwd より実際の実行場所を具体的に示す。
  _push_marker_split_shell_command "$command"
  for segment in "${PUSH_MARKER_SEGMENTS[@]}"; do
    if resolved_dir="$(_push_marker_resolve_cd_dir "$segment" "$current_dir")"; then
      current_dir="$resolved_dir"
      found_cd=true
    fi
    if _push_marker_is_git_push_segment "$segment"; then
      if [ -n "$current_dir" ]; then
        printf '%s' "$current_dir"
        return 0
      fi
      return 1
    fi
  done

  if $found_cd; then
    printf '%s' "$current_dir"
  elif [ -n "$input_dir" ]; then
    printf '%s' "$input_dir"
  elif [ -n "$fallback_dir" ]; then
    printf '%s' "$fallback_dir"
  else
    return 1
  fi
}
