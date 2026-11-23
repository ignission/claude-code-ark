#!/bin/bash
#
# Ark の本番 (pm2 + systemd の pm2-admin.service) へ、このチェックアウトをビルドして出す。
# デプロイの手順の正本はこのファイル。いつ・どのコミットを出すかの判断は SKILL.md にある。
#
# 使い方:
#   deploy.sh          ビルドして再起動する
#   deploy.sh --fresh  pm2 の登録を消してから起動し直す (保存 env の浄化)
#
# git の操作 (pull / checkout) はしない。出すコミットへ切り替えてから実行する。
#

set -euo pipefail

APP=claude-code-ark
UNIT=pm2-admin.service
PM2_HOME_DIR="${PM2_HOME:-$HOME/.pm2}"
PORT="${ARK_PORT:-4001}"

# このスクリプトが属するチェックアウトを出す。
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# Ark は cwd の .env.production と data/ を使うので、cwd は常に main のチェックアウトにする。
# 配信元が worktree でも、共通の .git の親が main のチェックアウト。
MAIN="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] エラー: $*" >&2; exit 1; }

fresh=false
case "${1:-}" in
  "") ;;
  --fresh) fresh=true ;;
  -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
  *) die "不明なオプション: $1" ;;
esac

# --- pm2 のデーモンの状態 -------------------------------------------------
#
# pm2 のコマンドは、デーモンが無いと呼び出し元の下に新しいデーモンを立てる。
# ユニットの外にデーモンがあると、ユニットの起動は pm2.pid を待って 90 秒で
# タイムアウトし、再起動を繰り返す (syslog が膨らみ、デーモンが落ちても起き直らない)。
# そのため、デーモンの有無を pgrep で見るまで pm2 のコマンドを打たない。

daemon_alive() { pgrep -u "$(id -u)" -f 'PM2 v[0-9.]+: God Daemon' >/dev/null; }

daemon_under_unit() {
  systemctl is-active --quiet "$UNIT" || return 1
  local pid
  pid="$(cat "$PM2_HOME_DIR/pm2.pid" 2>/dev/null)" || return 1
  grep -q "$UNIT" "/proc/$pid/cgroup" 2>/dev/null
}

# 配信中のスクリプトのパス。デーモンが無ければ、resurrect が読む dump.pm2 を見る。
served_script() {
  if daemon_alive; then
    pm2 jlist | jq -r --arg n "$APP" '[.[] | select(.name == $n)] | first | .pm2_env.pm_exec_path // empty'
  else
    jq -r --arg n "$APP" '[.[] | select(.name == $n)] | first | .pm_exec_path // empty' \
      "$PM2_HOME_DIR/dump.pm2" 2>/dev/null || true
  fi
}

# --- 事前の確認 -----------------------------------------------------------

systemctl cat "$UNIT" >/dev/null 2>&1 || die "$UNIT がありません (pm2 startup で作る)"

# 未コミットの変更を本番に出さない。
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] ||
  die "$ROOT に未コミットの変更があります"

# 別のチェックアウトが配信元なら、ここでビルドしても本番は変わらない。
served="$(served_script)"
if [[ -n "$served" ]]; then
  served_root="$(git -C "$(dirname "$served")" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ "$served_root" == "$ROOT" ]] ||
    die "配信元は ${served_root:-$served} で、このチェックアウト ($ROOT) ではありません"
fi

log "$ROOT を出す ($(git -C "$ROOT" log --oneline -1))"

# --- ビルド ---------------------------------------------------------------

cd "$ROOT"

# .mise.toml の版の pnpm が mise から入らないとき (no asset found) は corepack を使う。
if pnpm --version >/dev/null 2>&1; then PNPM=(pnpm); else PNPM=(corepack pnpm); fi

# 同梱の @anthropic-ai/claude-code の更新は install で初めて node_modules に入る。
"${PNPM[@]}" install --frozen-lockfile
# esbuild のビルドは型を検査しないので、先に check を通す。
"${PNPM[@]}" check
"${PNPM[@]}" build

# --- 再起動 ---------------------------------------------------------------
#
# ttyd はセッションごとのプロセスで、残すと再起動後の Ark が同じポート (7680〜) を
# 取れず EADDRINUSE になる。ビルドの間もターミナルを使えるよう、kill は再起動の直前に置く。
# -f は "ttyd" を含む無関係なコマンドラインに当たるので -x にする。
kill_ttyd() { pkill -x ttyd || true; }

# 初回と --fresh の起動。pm2 は呼び出し元のシェルの env をアプリの env として保存し、
# 以後の restart で使い回す。Claude Code のセッションから打つと CLAUDE_CONFIG_DIR などが
# 混ざり、Ark の配下のセッションへ伝わるので、env -i で HOME / PATH / LANG だけ渡す
# (LANG を落とすと ttyd / tmux の日本語が化ける)。アプリの設定は .env.production にある。
# interpreter は PATH の node を絶対パスで固定する。PATH の先頭に古い /usr/bin/node が
# 来ると --env-file を受け付けずに落ち続ける (cli.ts のガードより手前で死ぬ)。
fresh_start() {
  local node
  node="$(cd "$MAIN" && command -v node)" || die "node が見つかりません"
  pm2 delete "$APP" >/dev/null 2>&1 || true
  kill_ttyd
  (cd "$MAIN" && env -i HOME="$HOME" PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" \
    pm2 start "$ROOT/packages/server/dist/cli.js" \
    --name "$APP" \
    --interpreter "$node" \
    --node-args="--env-file=.env.production" \
    -- --remote)
}

resurrected=false
if ! daemon_under_unit; then
  log "pm2 のデーモンが $UNIT の配下にないので、ユニットから起動し直す"
  if daemon_alive; then
    pm2 save   # いまの登録を dump.pm2 に残し、ユニットの resurrect で戻す
    pm2 kill
  fi
  kill_ttyd
  sudo -n systemctl restart "$UNIT" || die "sudo systemctl restart $UNIT に失敗しました"
  daemon_under_unit || die "再起動後もデーモンが $UNIT の配下にありません"
  resurrected=true
fi

if $fresh || ! pm2 describe "$APP" >/dev/null 2>&1; then
  log "pm2 に登録し直して起動する"
  fresh_start
  pm2 save
elif ! $resurrected; then
  kill_ttyd
  pm2 restart "$APP"
fi

# --- 反映の確認 -----------------------------------------------------------

polluted="$(pm2 jlist | jq -c --arg n "$APP" '[.[] | select(.name == $n)] | first | .pm2_env.env
  | {CLAUDE_CONFIG_DIR, CLAUDECODE, CLAUDE_CODE_ENTRYPOINT} | with_entries(select(.value != null))')"
[[ "$polluted" == "{}" ]] || die "pm2 の保存 env が汚れています: $polluted (--fresh で浄化する)"

for _ in $(seq 30); do
  curl -fsS -o /dev/null "http://localhost:$PORT/" && break
  sleep 1
done
curl -fsS -o /dev/null "http://localhost:$PORT/" || die "Ark が :$PORT で応答しません (pm2 logs $APP を見る)"

log "完了: 同梱 claude $(packages/server/node_modules/.bin/claude --version)"
