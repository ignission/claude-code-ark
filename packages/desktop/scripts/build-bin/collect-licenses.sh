#!/usr/bin/env bash
# F4: 同梱バイナリの LICENSE / NOTICE 自動収集スクリプト
#
# 出力: ${BUILD_DIR}/licenses/<package>/{LICENSE,NOTICE?}
# 後段の electron-builder が extraResources で `Resources/licenses/` に配置する。
#
# 上流リポジトリの LICENSE を curl 取得 (バージョン pin 込み)。
# 各 package の license 種別:
#   - tmux: ISC
#   - ttyd: MIT
#   - OpenSSL 3.x: Apache 2.0 (+ 旧 SSLeay 互換注記)
#   - libwebsockets: MIT
#   - libuv: MIT
#   - libevent: 3-clause BSD
#   - ncurses: MIT-like
#   - zlib: zlib license

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

LICENSES_DIR="${BUILD_DIR}/licenses"
mkdir -p "${LICENSES_DIR}"

# fetch_license <name> <url>
fetch_license() {
  local name="$1"
  local url="$2"
  mkdir -p "${LICENSES_DIR}/${name}"
  echo "[license] ${name}: ${url}"
  curl -fsSL --retry 3 -o "${LICENSES_DIR}/${name}/LICENSE" "${url}" || \
    echo "[warn] ${name}: failed to fetch LICENSE (network?)"
}

# 各 license は GitHub tag URL から raw 取得する (manifest.json のバージョンと整合)。
# 注: 一部 (OpenSSL / ncurses) は GitHub mirror に LICENSE が無いため、上流ホストから取得する。
TMUX_VERSION=$(manifest_get '.tmux.version')
TTYD_VERSION=$(manifest_get '.ttyd.version')
LWS_VERSION=$(manifest_get '.dependencies.libwebsockets.version')
LIBUV_VERSION=$(manifest_get '.dependencies.libuv.version')
LIBEVENT_VERSION=$(manifest_get '.dependencies.libevent.version')

fetch_license "tmux" \
  "https://raw.githubusercontent.com/tmux/tmux/${TMUX_VERSION}/COPYING"
fetch_license "ttyd" \
  "https://raw.githubusercontent.com/tsl0922/ttyd/${TTYD_VERSION}/LICENSE"
fetch_license "libwebsockets" \
  "https://raw.githubusercontent.com/warmcat/libwebsockets/v${LWS_VERSION}/LICENSE"
fetch_license "libuv" \
  "https://raw.githubusercontent.com/libuv/libuv/v${LIBUV_VERSION}/LICENSE"
fetch_license "libevent" \
  "https://raw.githubusercontent.com/libevent/libevent/release-${LIBEVENT_VERSION}/LICENSE"

# OpenSSL は Apache 2.0 (公式 source tarball に LICENSE.txt 同梱)
fetch_license "openssl" \
  "https://raw.githubusercontent.com/openssl/openssl/openssl-3.3.2/LICENSE.txt"

# zlib (本家 README に license 全文がある)
fetch_license "zlib" \
  "https://raw.githubusercontent.com/madler/zlib/v1.3.1/LICENSE"

# ncurses (invisible-mirror が一次配布元; GitHub mirror から取得)
fetch_license "ncurses" \
  "https://raw.githubusercontent.com/mirror/ncurses/v6.5/COPYING"

# 各 package の SUMMARY.json を生成 (UI 側 AboutDialog 用)
cat > "${LICENSES_DIR}/INDEX.json" <<EOF
{
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "packages": [
    { "name": "tmux", "version": "${TMUX_VERSION}", "license": "ISC" },
    { "name": "ttyd", "version": "${TTYD_VERSION}", "license": "MIT" },
    { "name": "libwebsockets", "version": "${LWS_VERSION}", "license": "MIT" },
    { "name": "libuv", "version": "${LIBUV_VERSION}", "license": "MIT" },
    { "name": "libevent", "version": "${LIBEVENT_VERSION}", "license": "3-clause BSD" },
    { "name": "openssl", "version": "$(manifest_get '.dependencies.openssl.version')", "license": "Apache-2.0" },
    { "name": "ncurses", "version": "$(manifest_get '.dependencies.ncurses.version')", "license": "MIT-like" },
    { "name": "zlib", "version": "$(manifest_get '.dependencies.zlib.version')", "license": "zlib" }
  ]
}
EOF

echo "===== collect-licenses.sh: done -> ${LICENSES_DIR} ====="
ls -la "${LICENSES_DIR}"
