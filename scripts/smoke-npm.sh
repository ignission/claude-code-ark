#!/bin/bash
#
# release/npm/ のパッケージを tarball にして空のディレクトリへ入れ、起動して画面が返るかを見る。
# `pnpm build && node scripts/pack-npm.mjs` のあとに実行する。
#
# 型検査とユニットテストでは、公開物に入れ忘れたファイルや依存を見つけられない
# (リポジトリの中では node_modules から解決できてしまう)。利用者と同じ入れ方で確かめる。
#
# tmux は要る。ttyd は無ければ Ark が取得するので、その経路もここで通る。
#
# 環境変数:
#   ARK_SMOKE_PORT  待ち受けポート (既定 4097)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ARK_SMOKE_PORT:-4097}"
WORK_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
    if [[ -n "${SERVER_PID}" ]]; then
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
    rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

(cd "${ROOT_DIR}/release/npm" && npm pack --silent --pack-destination "${WORK_DIR}" >/dev/null)
TARBALL="$(ls "${WORK_DIR}"/claude-code-ark-*.tgz)"

mkdir "${WORK_DIR}/app"
cd "${WORK_DIR}/app"
npm install --silent --no-audit --no-fund "${TARBALL}"

ARK_DATA_DIR="${WORK_DIR}/data" PORT="${PORT}" \
    ./node_modules/.bin/claude-code-ark > "${WORK_DIR}/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        break
    fi
    if curl -fsS "http://localhost:${PORT}/" 2>/dev/null | grep -q "<title>Ark</title>"; then
        echo "[smoke-npm] OK: http://localhost:${PORT}/ が画面を返しました"
        exit 0
    fi
    sleep 1
done

echo "[smoke-npm] 起動を確認できませんでした。サーバーのログ:" >&2
cat "${WORK_DIR}/server.log" >&2
exit 1
