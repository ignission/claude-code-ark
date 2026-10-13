#!/bin/bash
#
# scripts/start.sh を利用者と同じように実行し、起動して画面が返るかを見る (CI 用)。
#
# 型検査とユニットテストでは、依存の導入からビルド、前提の検査、起動までが
# 1コマンドでつながっているかを確かめられない。clone した直後の状態で通す。
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

ARK_DATA_DIR="${WORK_DIR}/data" PORT="${PORT}" \
    "${ROOT_DIR}/scripts/start.sh" > "${WORK_DIR}/server.log" 2>&1 &
SERVER_PID=$!

# 初回は依存の導入とビルドを含むので、長めに待つ
for _ in $(seq 1 600); do
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        break
    fi
    if curl -fsS "http://localhost:${PORT}/" 2>/dev/null | grep -q "<title>Ark</title>"; then
        echo "[smoke-start] OK: http://localhost:${PORT}/ が画面を返しました"
        exit 0
    fi
    sleep 1
done

echo "[smoke-start] 起動を確認できませんでした。ログ:" >&2
cat "${WORK_DIR}/server.log" >&2
exit 1
