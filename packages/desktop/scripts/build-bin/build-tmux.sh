#!/usr/bin/env bash
# F4: macOS arm64 向け tmux クロスビルドスクリプト (skeleton)
#
# 依存: libevent, ncurses (manifest.json 参照)。
# 出力: ${PREFIX}/bin/tmux と動的依存 dylib (Frameworks/ 候補)。
#
# CI からは `bash build-tmux.sh` を呼ぶだけで再現可能なビルドにする想定。
# 詳細実装は CI で iterative に詰める前提で、最低限の skeleton + 依存導出順を記述。
#
# 参考:
#   - tmux build instructions: https://github.com/tmux/tmux/wiki/Installing
#   - configure flags の経験的設定: --enable-static, --disable-shared

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

echo "===== build-tmux.sh: macOS ${ARCH} =====" >&2

# ----- 依存ライブラリの取得とビルド -----
# 順序: ncurses → libevent → tmux

# 1. ncurses
NCURSES_URL=$(manifest_get '.dependencies.ncurses.url')
NCURSES_SHA=$(manifest_get '.dependencies.ncurses.sha256')
fetch_and_extract "ncurses" "${NCURSES_URL}" "${NCURSES_SHA}"

# 2. libevent
LIBEVENT_URL=$(manifest_get '.dependencies.libevent.url')
LIBEVENT_SHA=$(manifest_get '.dependencies.libevent.sha256')
fetch_and_extract "libevent" "${LIBEVENT_URL}" "${LIBEVENT_SHA}"

# TODO (CI): 各 lib の configure --prefix=${PREFIX} --disable-shared --enable-static && make && make install

# 3. tmux 本体
TMUX_URL=$(manifest_get '.tmux.url')
TMUX_SHA=$(manifest_get '.tmux.sha256')
fetch_and_extract "tmux" "${TMUX_URL}" "${TMUX_SHA}"

# TODO (CI):
#   pushd ${SRC_DIR}/tmux/tmux-*/
#   ./configure --prefix=${PREFIX} --enable-static \
#     CPPFLAGS="-I${PREFIX}/include -I${PREFIX}/include/ncurses" \
#     LDFLAGS="${LDFLAGS}"
#   make -j$(sysctl -n hw.ncpu)
#   make install
#   popd

# ----- 出力検証 -----
if [[ -x "${PREFIX}/bin/tmux" ]]; then
  echo "===== build-tmux.sh: success ====="
  "${PREFIX}/bin/tmux" -V
  inspect_deps "${PREFIX}/bin/tmux"
else
  echo "[skeleton] tmux binary not built (configure/make steps are TODO)"
  exit 0
fi
