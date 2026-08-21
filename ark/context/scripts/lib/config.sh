#!/usr/bin/env bash

CTX_CONFIG_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CTX_SOURCE_ROOT=$(cd "$CTX_CONFIG_LIB_DIR/../.." && pwd -P)

ctx_config_ensure() {
  local new old_umask
  [ -n "${CTX_CONFIG_FILE:-}" ] && [ -n "${CTX_CONFIG_DIR:-}" ] \
    || { ctx_error "config path unavailable"; return 1; }
  ctx_validate_xdg_dir "$CTX_CONFIG_DIR" || return 1
  if [ -e "$CTX_CONFIG_FILE" ] || [ -L "$CTX_CONFIG_FILE" ]; then
    ctx_validate_xdg_file "$CTX_CONFIG_FILE"
    return $?
  fi

  new="$CTX_CONFIG_DIR/config.toml.new"
  if [ -e "$new" ] || [ -L "$new" ]; then
    ctx_validate_xdg_file "$new" || return 1
  fi
  old_umask=$(umask)
  umask 077
  command cp "$CTX_SOURCE_ROOT/templates/config.toml.tmpl" "$new" || {
    umask "$old_umask"
    ctx_error "config create failed"
    return 1
  }
  umask "$old_umask"
  chmod 600 "$new" || { ctx_error "config create failed"; return 1; }
  ctx_validate_xdg_file "$new" || return 1
  command mv "$new" "$CTX_CONFIG_FILE" || { ctx_error "config publish failed"; return 1; }
  ctx_validate_xdg_file "$CTX_CONFIG_FILE"
}

ctx_trim_spaces() {
  local trimmed=$1
  while :; do
    case "$trimmed" in ' '*) trimmed=${trimmed# } ;; $'\t'*) trimmed=${trimmed#$'\t'} ;; *) break ;; esac
  done
  while :; do
    case "$trimmed" in *' ') trimmed=${trimmed% } ;; *$'\t') trimmed=${trimmed%$'\t'} ;; *) break ;; esac
  done
  printf '%s\n' "$trimmed"
}

ctx_config_read_recite_interval() {
  local table seen interval raw content key value
  ctx_validate_xdg_file "${CTX_CONFIG_FILE:-}" || return 1
  if LC_ALL=C tr -d '\r\n\t' <"$CTX_CONFIG_FILE" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then
    ctx_error "invalid recite_interval"
    return 1
  fi

  table=
  seen=0
  interval=10
  while IFS= read -r raw || [ -n "$raw" ]; do
    raw=${raw%$'\r'}
    content=${raw%%#*}
    content=$(ctx_trim_spaces "$content")
    [ -n "$content" ] || continue
    case "$content" in
      \[*\])
        case "$content" in
          '[context]') table=context ;;
          *) table=other ;;
        esac
        continue
        ;;
    esac
    [ "$table" = context ] || continue
    case "$content" in
      *=*)
        key=$(ctx_trim_spaces "${content%%=*}")
        [ "$key" = recite_interval ] || continue
        value=$(ctx_trim_spaces "${content#*=}")
        seen=$((seen + 1))
        case "$value" in ''|*[!0-9]*) ctx_error "invalid recite_interval"; return 1 ;; esac
        [ "$value" -ge 1 ] 2>/dev/null && [ "$value" -le 100000 ] 2>/dev/null \
          || { ctx_error "invalid recite_interval"; return 1; }
        interval=$value
        ;;
    esac
  done <"$CTX_CONFIG_FILE"
  [ "$seen" -le 1 ] || { ctx_error "invalid recite_interval"; return 1; }
  printf '%s\n' "$interval"
}

ctx_config_read_summarize() {
  local table seen_llm seen_model raw content key value model_size
  ctx_validate_xdg_file "${CTX_CONFIG_FILE:-}" || return 1
  if LC_ALL=C tr -d '\r\n\t' <"$CTX_CONFIG_FILE" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then
    ctx_error "invalid summarize config"
    return 1
  fi

  table=
  seen_llm=0
  seen_model=0
  CTX_SUMMARIZE_LLM=0
  CTX_SUMMARIZE_MODEL=
  while IFS= read -r raw || [ -n "$raw" ]; do
    raw=${raw%$'\r'}
    content=${raw%%#*}
    content=$(ctx_trim_spaces "$content")
    [ -n "$content" ] || continue
    case "$content" in
      \[*\])
        case "$content" in
          '[context.summarize]') table=summarize ;;
          *) table=other ;;
        esac
        continue
        ;;
    esac
    [ "$table" = summarize ] || continue
    case "$content" in
      *=*)
        key=$(ctx_trim_spaces "${content%%=*}")
        value=$(ctx_trim_spaces "${content#*=}")
        case "$key" in
          llm)
            seen_llm=$((seen_llm + 1))
            [ "$seen_llm" -le 1 ] || { ctx_error "invalid summarize config"; return 1; }
            case "$value" in
              true) CTX_SUMMARIZE_LLM=1 ;;
              false) CTX_SUMMARIZE_LLM=0 ;;
              *) ctx_error "invalid summarize config"; return 1 ;;
            esac
            ;;
          model)
            seen_model=$((seen_model + 1))
            [ "$seen_model" -le 1 ] || { ctx_error "invalid summarize config"; return 1; }
            case "$value" in
              \"*\")
                CTX_SUMMARIZE_MODEL=${value#\"}
                CTX_SUMMARIZE_MODEL=${CTX_SUMMARIZE_MODEL%\"}
                case "$CTX_SUMMARIZE_MODEL" in *\"*|*\\*) ctx_error "invalid summarize config"; return 1 ;; esac
                if printf '%s' "$CTX_SUMMARIZE_MODEL" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null 2>&1; then
                  ctx_error "invalid summarize config"
                  return 1
                fi
                ;;
              *) ctx_error "invalid summarize config"; return 1 ;;
            esac
            model_size=$(LC_ALL=C printf '%s' "$CTX_SUMMARIZE_MODEL" | wc -c | tr -d ' ')
            case "$model_size" in ''|*[!0-9]*) ctx_error "invalid summarize config"; return 1 ;; esac
            [ "$model_size" -le 200 ] || { ctx_error "invalid summarize config"; return 1; }
            ;;
          *) ;;
        esac
        ;;
    esac
  done <"$CTX_CONFIG_FILE"
  return 0
}

ctx_session_id_generate() {
  local previous=${1:-}
  local tries=0
  local candidate
  while [ "$tries" -lt 5 ]; do
    candidate=$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n') || candidate=
    tries=$((tries + 1))
    case "$candidate" in *[!0-9a-f]*) continue ;; esac
    [ "${#candidate}" -eq 32 ] || continue
    [ "$candidate" != "$previous" ] || continue
    [ ! -e "${CTX_DATA_ROOT:-}/sessions/$candidate" ] || continue
    [ ! -e "${CTX_CACHE_ROOT:-}/$candidate" ] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  ctx_error "session id unavailable"
}
