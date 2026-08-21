#!/usr/bin/env bash

# lock ownership / reclaim directory 用の一意 token を生成する。
_ctx_lock_generate_token() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    od -An -tx1 -N16 /dev/urandom | tr -d ' \n'
  fi
}

# 現在の shell process の pid を lock directory へ直接書く。command substitution
# 内で子 shell の PPID を読むと、macOS bash 3.2 では短命な command-substitution
# process を指す。子 /bin/sh を直接起動すれば、その PPID は lock を保持する実 shell
# になる。bash 3.2 / zsh 固有の BASHPID / sysparams には依存しない。
_ctx_lock_write_owner_pid() {
  local pid_file="$1"
  /bin/sh -c 'printf "%s\n" "$PPID" > "$1"' ctx-lock-owner "$pid_file"
}

_ctx_lock_dir() {
  local lock_file="$1"
  local backend="$2"
  if [ "$backend" = "mkdir-direct" ]; then
    printf '%s\n' "$lock_file"
  else
    printf '%s.d\n' "$lock_file"
  fi
}

_ctx_lock_mtime() {
  local lock_dir="$1"
  stat -c %Y "$lock_dir" 2>/dev/null \
    || stat -f %m "$lock_dir" 2>/dev/null
}

_ctx_lock_discard_dir() {
  local lock_dir="$1"
  rm -f "$lock_dir/pid" "$lock_dir/token" 2>/dev/null || true
  rmdir "$lock_dir" 2>/dev/null || true
}

# mkdir lock が stale なら atomic rename で隔離する。
# pid の有無にかかわらず mtime が stale_seconds 以上で、かつ owner pid が死亡済み
# (または未記録) の場合だけ回収する。pid 再利用時は生存扱いとして fail closed にする。
_ctx_lock_reclaim_stale() {
  local lock_dir="$1"
  local stale_seconds="$2"
  local reclaim_token="$3"
  local observed_owner observed_token now lock_mtime reclaim_dir
  local moved_owner moved_token

  observed_owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
  case "$observed_owner" in ''|*[!0-9]*) observed_owner="" ;; esac
  observed_token=$(cat "$lock_dir/token" 2>/dev/null || true)
  now=$(date +%s)
  lock_mtime=$(_ctx_lock_mtime "$lock_dir" 2>/dev/null || printf '%s\n' "$now")
  case "$lock_mtime" in ''|*[!0-9]*) lock_mtime="$now" ;; esac
  [ $((now - lock_mtime)) -ge "$stale_seconds" ] || return 1
  [ -z "$observed_owner" ] || ! kill -0 "$observed_owner" 2>/dev/null || return 1

  reclaim_dir="${lock_dir}.reclaim.${reclaim_token}"
  if [ -e "$reclaim_dir" ]; then
    _ctx_lock_discard_dir "$reclaim_dir"
    [ ! -e "$reclaim_dir" ] || return 1
  fi
  command mv "$lock_dir" "$reclaim_dir" 2>/dev/null || return 1

  # stale 判定後に別 process が lock を作り直していた場合は奪わない。観測した pid と
  # token の両方が rename した directory と一致するときだけ旧 lock として破棄する。
  moved_owner=$(cat "$reclaim_dir/pid" 2>/dev/null || true)
  case "$moved_owner" in ''|*[!0-9]*) moved_owner="" ;; esac
  moved_token=$(cat "$reclaim_dir/token" 2>/dev/null || true)
  if [ "$moved_owner" != "$observed_owner" ] \
    || [ "$moved_token" != "$observed_token" ] \
    || { [ -n "$moved_owner" ] && kill -0 "$moved_owner" 2>/dev/null; }; then
    if [ ! -e "$lock_dir" ]; then
      command mv "$reclaim_dir" "$lock_dir" 2>/dev/null || true
    fi
    [ ! -e "$reclaim_dir" ] || _ctx_lock_discard_dir "$reclaim_dir"
    return 1
  fi
  _ctx_lock_discard_dir "$reclaim_dir"
  return 0
}

# 排他 lock を取得する共通 API。
# 引数: $1 lock_file, $2 flock fd, $3 wait 秒 (-1=無期限, 0=non-blocking),
#       $4 stale とみなす最小経過秒, $5 backend (auto|mkdir|mkdir-direct)
# auto は flock があれば従来の fd lock、なければ <lock_file>.d の mkdir lock を使う。
# mkdir-direct は既存の lock directory path を維持するための指定。
# 成功時の実 backend / owner pid / token は CTX_LOCK_ACQUIRED_BACKEND /
# CTX_LOCK_ACQUIRED_PID / CTX_LOCK_ACQUIRED_TOKEN に設定する。release は token が
# 一致する lock だけを削除する。
ctx_lock_acquire() {
  local lock_file="${1:-}"
  local lock_fd="${2:-9}"
  local wait_seconds="${3:--1}"
  local stale_seconds="${4:-30}"
  local requested_backend="${5:-auto}"
  local lock_backend lock_dir current_pid owner_token deadline now
  [ -n "$lock_file" ] || return 1

  lock_backend="$requested_backend"
  if [ "$lock_backend" = "auto" ]; then
    if command -v flock >/dev/null 2>&1; then
      lock_backend="flock"
    else
      lock_backend="mkdir"
    fi
  fi

  if [ "$lock_backend" = "flock" ]; then
    case "$wait_seconds" in
      0) command flock -xn "$lock_fd" || return 1 ;;
      -1) command flock -x "$lock_fd" || return 1 ;;
      *) command flock -x -w "$wait_seconds" "$lock_fd" || return 1 ;;
    esac
    CTX_LOCK_ACQUIRED_BACKEND="flock"
    CTX_LOCK_ACQUIRED_PID=""
    CTX_LOCK_ACQUIRED_TOKEN=""
    return 0
  fi
  case "$lock_backend" in mkdir|mkdir-direct) ;; *) return 1 ;; esac

  lock_dir=$(_ctx_lock_dir "$lock_file" "$lock_backend")
  owner_token=$(_ctx_lock_generate_token) || return 1
  [ -n "$owner_token" ] || return 1
  now=$(date +%s)
  deadline=$((now + wait_seconds))
  while :; do
    if mkdir "$lock_dir" 2>/dev/null; then
      if ! printf '%s\n' "$owner_token" > "$lock_dir/token" 2>/dev/null \
        || ! _ctx_lock_write_owner_pid "$lock_dir/pid"; then
        _ctx_lock_discard_dir "$lock_dir"
        return 1
      fi
      current_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
      case "$current_pid" in ''|*[!0-9]*) _ctx_lock_discard_dir "$lock_dir"; return 1 ;; esac
      if [ "$(cat "$lock_dir/token" 2>/dev/null || true)" != "$owner_token" ]; then
        return 1
      fi
      CTX_LOCK_ACQUIRED_BACKEND="$lock_backend"
      CTX_LOCK_ACQUIRED_PID="$current_pid"
      CTX_LOCK_ACQUIRED_TOKEN="$owner_token"
      return 0
    fi
    # stale lock を回収できた場合は non-blocking 指定でも直ちに mkdir を再試行する。
    # ここで先に timeout 判定すると、回収だけして取得失敗を返してしまう。
    if _ctx_lock_reclaim_stale "$lock_dir" "$stale_seconds" "$owner_token"; then
      continue
    fi
    if [ "$wait_seconds" -eq 0 ]; then
      return 1
    fi
    now=$(date +%s)
    if [ "$wait_seconds" -gt 0 ] && [ "$now" -ge "$deadline" ]; then
      return 1
    fi
    sleep 1
  done
}

# ctx_lock_acquire で得た lock を解放する。flock は fd close に任せる。
# 引数: $1 lock_file, $2 backend, $3 acquire 時の owner pid,
#       $4 acquire 時の owner token
ctx_lock_release() {
  local lock_file="${1:-}"
  local lock_backend="${2:-}"
  local acquired_pid="${3:-}"
  local acquired_token="${4:-}"
  local lock_dir owner_pid owner_token
  [ -n "$lock_file" ] || return 1
  [ "$lock_backend" != "flock" ] || return 0
  case "$lock_backend" in mkdir|mkdir-direct) ;; *) return 1 ;; esac

  lock_dir=$(_ctx_lock_dir "$lock_file" "$lock_backend")
  [ -d "$lock_dir" ] || return 0
  owner_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
  case "$owner_pid" in ''|*[!0-9]*) owner_pid="" ;; esac
  owner_token=$(cat "$lock_dir/token" 2>/dev/null || true)
  if [ -n "$acquired_token" ] && [ "$owner_token" = "$acquired_token" ] \
    && { [ -z "$acquired_pid" ] || [ "$owner_pid" = "$acquired_pid" ]; }; then
    _ctx_lock_discard_dir "$lock_dir"
    return 0
  fi
  return 1
}
