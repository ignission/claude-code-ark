#!/usr/bin/env bash

LOOP_CONFIG_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
LOOP_SOURCE_ROOT=$(cd "$LOOP_CONFIG_LIB_DIR/../.." && pwd -P)

loop_config_ensure() {
  local new old_umask
  [ -n "${LOOP_CONFIG_FILE:-}" ] && [ -n "${LOOP_CONFIG_DIR:-}" ] \
    || { loop_error "config path unavailable"; return 1; }
  loop_validate_xdg_dir "$LOOP_CONFIG_DIR" || return 1
  if [ -e "$LOOP_CONFIG_FILE" ] || [ -L "$LOOP_CONFIG_FILE" ]; then
    loop_validate_xdg_file "$LOOP_CONFIG_FILE"
    return $?
  fi

  new="$LOOP_CONFIG_DIR/config.toml.new"
  if [ -e "$new" ] || [ -L "$new" ]; then
    loop_validate_xdg_file "$new" || return 1
  fi
  old_umask=$(umask)
  umask 077
  command cp "$LOOP_SOURCE_ROOT/templates/config.toml.tmpl" "$new" || {
    umask "$old_umask"
    loop_error "config create failed"
    return 1
  }
  umask "$old_umask"
  chmod 600 "$new" || { loop_error "config create failed"; return 1; }
  loop_validate_xdg_file "$new" || return 1
  command mv "$new" "$LOOP_CONFIG_FILE" || { loop_error "config publish failed"; return 1; }
  loop_validate_xdg_file "$LOOP_CONFIG_FILE"
}

loop_trim_spaces() {
  local trimmed=$1
  while [ "${trimmed# }" != "$trimmed" ]; do trimmed=${trimmed# }; done
  while [ "${trimmed% }" != "$trimmed" ]; do trimmed=${trimmed% }; done
  printf '%s\n' "$trimmed"
}

loop_config_read_recite_interval() {
  local table seen interval raw content key value
  loop_validate_xdg_file "${LOOP_CONFIG_FILE:-}" || return 1
  if LC_ALL=C tr -d '\r\n' <"$LOOP_CONFIG_FILE" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then
    loop_error "invalid recite_interval"
    return 1
  fi

  table=
  seen=0
  interval=10
  while IFS= read -r raw || [ -n "$raw" ]; do
    raw=${raw%$'\r'}
    content=${raw%%#*}
    content=$(loop_trim_spaces "$content")
    [ -n "$content" ] || continue
    case "$content" in
      \[*\])
        case "$content" in
          '[loop]') table=loop ;;
          *) table=other ;;
        esac
        continue
        ;;
    esac
    [ "$table" = loop ] || continue
    case "$content" in
      *=*)
        key=$(loop_trim_spaces "${content%%=*}")
        [ "$key" = recite_interval ] || continue
        value=$(loop_trim_spaces "${content#*=}")
        seen=$((seen + 1))
        case "$value" in ''|*[!0-9]*) loop_error "invalid recite_interval"; return 1 ;; esac
        [ "$value" -ge 1 ] 2>/dev/null && [ "$value" -le 100000 ] 2>/dev/null \
          || { loop_error "invalid recite_interval"; return 1; }
        interval=$value
        ;;
    esac
  done <"$LOOP_CONFIG_FILE"
  [ "$seen" -le 1 ] || { loop_error "invalid recite_interval"; return 1; }
  printf '%s\n' "$interval"
}

loop_session_id_generate() {
  local previous=${1:-}
  local tries=0
  local candidate
  while [ "$tries" -lt 5 ]; do
    candidate=$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n') || candidate=
    tries=$((tries + 1))
    case "$candidate" in *[!0-9a-f]*) continue ;; esac
    [ "${#candidate}" -eq 32 ] || continue
    [ "$candidate" != "$previous" ] || continue
    [ ! -e "${LOOP_DATA_ROOT:-}/sessions/$candidate" ] || continue
    [ ! -e "${LOOP_CACHE_ROOT:-}/$candidate" ] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  loop_error "session id unavailable"
}
