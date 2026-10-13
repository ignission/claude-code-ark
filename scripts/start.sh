#!/bin/bash
#
# Ark - clone した直後から、これ1つで起動する
#
# 使用方法:
#   ./scripts/start.sh [--rebuild] [Ark のオプション]
#
#   --rebuild   依存の導入とビルドをやり直す
#   それ以外の引数は Ark へそのまま渡す (./scripts/start.sh --help で一覧)
#
# やること:
#   1. Node.js のバージョンを確かめる
#   2. 初回と、pull でコミットが変わったときだけ、依存を入れてビルドする
#   3. 前提の道具 (tmux / ttyd) を調べて起動する (packages/server/src/start.ts)
#
# 利用者が用意するのは Node.js と tmux だけ。pnpm は無ければここで調達する。
# pm2 で常駐させる本番の更新は deploy.sh が行う。
#
# macOS の bash 3.2 でも動く書き方にしている (連想配列や空配列の展開を避ける)。
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

fail() {
    echo "$1" >&2
    exit 1
}

if ! command -v node > /dev/null 2>&1; then
    fail "Node.js >= 22.12 is required but was not found. Install it: https://nodejs.org/"
fi
# 古い Node だと依存の導入やビルドが分かりにくいエラーで落ちるので、先に確かめる
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; then
    fail "Ark requires Node.js >= 22.12 but got $(node --version)."
fi

# pnpm の調達。版は package.json の packageManager に固定してある
if command -v pnpm > /dev/null 2>&1; then
    PNPM="pnpm"
elif command -v corepack > /dev/null 2>&1; then
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    PNPM="corepack pnpm"
else
    PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")"
    PNPM="npx --yes pnpm@${PNPM_VERSION}"
fi

REBUILD=0
ARGS=()
for arg in "$@"; do
    if [[ "${arg}" == "--rebuild" ]]; then
        REBUILD=1
    else
        ARGS+=("${arg}")
    fi
done

# ビルド済みかどうかは、ビルドしたときのコミットで見分ける。
# 未コミットの変更は見ないので、手元でコードを直したときは --rebuild を付ける。
STAMP_FILE="node_modules/.ark-build-stamp"
CURRENT="$(git rev-parse HEAD 2> /dev/null || echo "nogit")"
BUILT=""
if [[ -f "${STAMP_FILE}" ]]; then
    BUILT="$(cat "${STAMP_FILE}")"
fi

if [[ "${REBUILD}" == "1" || "${BUILT}" != "${CURRENT}" || ! -f packages/server/dist/start.js || ! -f packages/web/dist/index.html ]]; then
    echo "[Ark] Installing dependencies and building. The first run takes a few minutes."
    # デスクトップ版 (Electron) は起動に要らないので入れない
    ${PNPM} install --frozen-lockfile --filter '!@ark/desktop'
    ${PNPM} --filter '!@ark/desktop' -r build
    echo "${CURRENT}" > "${STAMP_FILE}"
fi

export NODE_ENV="${NODE_ENV:-production}"
exec node packages/server/dist/start.js ${ARGS[@]+"${ARGS[@]}"}
