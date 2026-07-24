#!/usr/bin/env bash
# flow / flow-x / flow-loop が共有する runtime state directory resolver。
#
# 明示 FLOW_STATE_DIR は信頼済み operator 入力として扱い、既存 path の permission
# や ownership を変更しない。未指定時だけ secure default を作成・検証する。

_flow_state_dir_error() {
  echo "ERROR: flow state directory: $*" >&2
  return 1
}

# GNU stat と BSD/macOS stat の差を吸収し、"<owner uid> <octal mode>" を返す。
_flow_state_dir_stat() {
  local target="$1"
  local stat_output
  if stat_output=$(stat -c '%u %a' "$target" 2>/dev/null); then
    :
  elif stat_output=$(stat -f '%u %Lp' "$target" 2>/dev/null); then
    :
  else
    _flow_state_dir_error "stat に失敗しました: $target"
    return 1
  fi

  local stat_uid stat_mode stat_extra
  read -r stat_uid stat_mode stat_extra <<EOF
$stat_output
EOF
  if [ -z "${stat_uid:-}" ] || [ -z "${stat_mode:-}" ] || [ -n "${stat_extra:-}" ]; then
    _flow_state_dir_error "stat の出力を解釈できません: $target"
    return 1
  fi
  case "$stat_uid" in
    *[!0-9]*)
      _flow_state_dir_error "stat owner が不正です: $target ($stat_uid)"
      return 1
      ;;
  esac
  case "$stat_mode" in
    *[!0-7]*)
      _flow_state_dir_error "stat mode が不正です: $target ($stat_mode)"
      return 1
      ;;
  esac
  printf '%s %s\n' "$stat_uid" "$stat_mode"
}

_flow_state_dir_normalize_mode() {
  local normalized_mode="$1"
  while [ "${normalized_mode#0}" != "$normalized_mode" ]; do
    normalized_mode="${normalized_mode#0}"
  done
  printf '%s\n' "${normalized_mode:-0}"
}

_flow_state_dir_default() {
  local runtime_base="${XDG_RUNTIME_DIR:-/tmp}"
  local current_uid
  current_uid=$(id -u) || {
    _flow_state_dir_error "id -u に失敗しました"
    return 1
  }
  printf '%s/ark-flow-%s\n' "${runtime_base%/}" "$current_uid"
}

# XDG_RUNTIME_DIR は明示された時だけ検証する。fallback の /tmp は sticky runtime
# root として扱い、最終 user-specific directory を厳格検証する。
_flow_state_dir_validate_xdg_runtime() {
  local runtime_base="$1"
  local current_uid="$2"
  if [ -L "$runtime_base" ]; then
    _flow_state_dir_error "XDG_RUNTIME_DIR が symlink です: $runtime_base"
    return 1
  fi
  if [ ! -d "$runtime_base" ]; then
    _flow_state_dir_error "XDG_RUNTIME_DIR が directory ではありません: $runtime_base"
    return 1
  fi

  local stat_values stat_uid stat_mode mode_tail group_digit other_digit
  stat_values=$(_flow_state_dir_stat "$runtime_base") || return 1
  read -r stat_uid stat_mode <<EOF
$stat_values
EOF
  if [ "$stat_uid" != "$current_uid" ]; then
    _flow_state_dir_error \
      "XDG_RUNTIME_DIR の owner が実行 user と一致しません: $runtime_base (owner=$stat_uid uid=$current_uid)"
    return 1
  fi

  stat_mode=$(_flow_state_dir_normalize_mode "$stat_mode")
  mode_tail=$(printf '%03d\n' "$stat_mode")
  mode_tail="${mode_tail#"${mode_tail%???}"}"
  group_digit="${mode_tail#?}"
  group_digit="${group_digit%?}"
  other_digit="${mode_tail#??}"
  case "$group_digit$other_digit" in
    *[2367]*)
      _flow_state_dir_error \
        "XDG_RUNTIME_DIR が group/other writable です: $runtime_base (mode=$stat_mode)"
      return 1
      ;;
  esac
}

_flow_state_dir_validate_default() {
  local candidate="$1"
  local current_uid="$2"
  if [ -L "$candidate" ]; then
    _flow_state_dir_error "secure default が symlink です: $candidate"
    return 1
  fi
  if [ ! -d "$candidate" ]; then
    _flow_state_dir_error "secure default が directory ではありません: $candidate"
    return 1
  fi

  local stat_values stat_uid stat_mode
  stat_values=$(_flow_state_dir_stat "$candidate") || return 1
  read -r stat_uid stat_mode <<EOF
$stat_values
EOF
  stat_mode=$(_flow_state_dir_normalize_mode "$stat_mode")
  if [ "$stat_uid" != "$current_uid" ]; then
    _flow_state_dir_error \
      "secure default の owner が実行 user と一致しません: $candidate (owner=$stat_uid uid=$current_uid)"
    return 1
  fi
  if [ "$stat_mode" != "700" ]; then
    _flow_state_dir_error \
      "secure default の mode が 0700 ではありません: $candidate (mode=$stat_mode)"
    return 1
  fi
}

_flow_state_dir_warn_override() {
  local override_dir="$1"
  local current_uid="$2"
  local warning_reason=""
  if [ -L "$override_dir" ]; then
    warning_reason="symlink"
  elif [ ! -d "$override_dir" ]; then
    warning_reason="directory ではない entry"
  else
    local stat_values stat_uid stat_mode
    if ! stat_values=$(_flow_state_dir_stat "$override_dir" 2>/dev/null); then
      warning_reason="stat 不能"
    else
      read -r stat_uid stat_mode <<EOF
$stat_values
EOF
      stat_mode=$(_flow_state_dir_normalize_mode "$stat_mode")
      if [ "$stat_uid" != "$current_uid" ] || [ "$stat_mode" != "700" ]; then
        warning_reason="owner/mode が secure default 契約外 (owner=$stat_uid mode=$stat_mode)"
      fi
    fi
  fi
  if [ -n "$warning_reason" ]; then
    echo "WARNING: FLOW_STATE_DIR override を検証せず使用します ($warning_reason): $override_dir" >&2
  fi
}

flow_state_dir_init() {
  if [ "${FLOW_STATE_DIR_INITIALIZED:-}" = "1" ]; then
    if [ "${FLOW_STATE_DIR_SECURE_DEFAULT:-}" = "1" ]; then
      _flow_state_dir_validate_default "$FLOW_STATE_DIR" "$(id -u)" || return 1
    fi
    return 0
  fi

  local current_uid
  current_uid=$(id -u) || {
    _flow_state_dir_error "id -u に失敗しました"
    return 1
  }

  if [ -n "${FLOW_STATE_DIR:-}" ]; then
    if [ ! -e "$FLOW_STATE_DIR" ] && [ ! -L "$FLOW_STATE_DIR" ]; then
      mkdir -m 700 -p "$FLOW_STATE_DIR" || {
        _flow_state_dir_error "FLOW_STATE_DIR override を作成できません: $FLOW_STATE_DIR"
        return 1
      }
    fi
    _flow_state_dir_warn_override "$FLOW_STATE_DIR" "$current_uid"
    FLOW_STATE_DIR_INITIALIZED=1
    FLOW_STATE_DIR_SECURE_DEFAULT=0
    export FLOW_STATE_DIR FLOW_STATE_DIR_INITIALIZED FLOW_STATE_DIR_SECURE_DEFAULT
    return 0
  fi

  if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    _flow_state_dir_validate_xdg_runtime "$XDG_RUNTIME_DIR" "$current_uid" || return 1
  fi

  local candidate
  candidate=$(_flow_state_dir_default) || return 1
  if [ -L "$candidate" ]; then
    _flow_state_dir_error "secure default が既存 symlink です: $candidate"
    return 1
  fi
  mkdir -m 700 -p "$candidate" || {
    _flow_state_dir_error "secure default を作成できません: $candidate"
    return 1
  }
  _flow_state_dir_validate_default "$candidate" "$current_uid" || return 1

  FLOW_STATE_DIR="$candidate"
  FLOW_STATE_DIR_INITIALIZED=1
  FLOW_STATE_DIR_SECURE_DEFAULT=1
  export FLOW_STATE_DIR FLOW_STATE_DIR_INITIALIZED FLOW_STATE_DIR_SECURE_DEFAULT
}
