#!/usr/bin/env bash
# F4: macOS arm64 向け ttyd クロスビルドスクリプト (skeleton)
#
# 依存: libwebsockets (4.3+, OpenSSL 3.x), libuv, OpenSSL, zlib (manifest.json 参照)。
# 出力: ${PREFIX}/bin/ttyd と動的依存 dylib (Frameworks/ 候補)。
#
# 落とし穴:
#   - libwebsockets 4.3 系を pin (4.4 以降は ttyd 1.7.x との API 差異あり)
#   - OpenSSL は --no-shared で組まないと libwebsockets が静的リンクできない
#
# 参考: https://github.com/tsl0922/ttyd#build-from-source

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

echo "===== build-ttyd.sh: macOS ${ARCH} =====" >&2

# ----- 依存ライブラリの取得とビルド -----
# 順序: zlib → OpenSSL → libuv → libwebsockets → ttyd

# 1. zlib
ZLIB_URL=$(manifest_get '.dependencies.zlib.url')
ZLIB_SHA=$(manifest_get '.dependencies.zlib.sha256')
fetch_and_extract "zlib" "${ZLIB_URL}" "${ZLIB_SHA}"

# 2. OpenSSL 3.x
OPENSSL_URL=$(manifest_get '.dependencies.openssl.url')
OPENSSL_SHA=$(manifest_get '.dependencies.openssl.sha256')
fetch_and_extract "openssl" "${OPENSSL_URL}" "${OPENSSL_SHA}"
# TODO (CI):
#   pushd ${SRC_DIR}/openssl/openssl-*/
#   ./Configure darwin64-arm64-cc no-shared --prefix=${PREFIX} \
#     -mmacosx-version-min=${DEPLOYMENT_TARGET}
#   make -j$(sysctl -n hw.ncpu)
#   make install_sw
#   popd

# 3. libuv
LIBUV_URL=$(manifest_get '.dependencies.libuv.url')
LIBUV_SHA=$(manifest_get '.dependencies.libuv.sha256')
fetch_and_extract "libuv" "${LIBUV_URL}" "${LIBUV_SHA}"

# 4. libwebsockets (4.3 系)
LWS_URL=$(manifest_get '.dependencies.libwebsockets.url')
LWS_SHA=$(manifest_get '.dependencies.libwebsockets.sha256')
fetch_and_extract "libwebsockets" "${LWS_URL}" "${LWS_SHA}"
# TODO (CI): cmake で OpenSSL/zlib 指定し --static link

# 5. ttyd 本体
TTYD_URL=$(manifest_get '.ttyd.url')
TTYD_SHA=$(manifest_get '.ttyd.sha256')
fetch_and_extract "ttyd" "${TTYD_URL}" "${TTYD_SHA}"
# TODO (CI):
#   pushd ${SRC_DIR}/ttyd/ttyd-*/
#   mkdir build && cd build
#   cmake -DCMAKE_BUILD_TYPE=Release \
#     -DCMAKE_INSTALL_PREFIX=${PREFIX} \
#     -DCMAKE_OSX_DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET} \
#     -DCMAKE_OSX_ARCHITECTURES=${ARCH} \
#     -DOPENSSL_ROOT_DIR=${PREFIX} \
#     -DZLIB_ROOT=${PREFIX} \
#     -DLIBWEBSOCKETS_INCLUDE_DIRS=${PREFIX}/include \
#     -DLIBWEBSOCKETS_LIBRARIES=${PREFIX}/lib/libwebsockets.a \
#     ..
#   make -j$(sysctl -n hw.ncpu)
#   make install
#   popd

# ----- 出力検証 -----
if [[ -x "${PREFIX}/bin/ttyd" ]]; then
  echo "===== build-ttyd.sh: success ====="
  "${PREFIX}/bin/ttyd" --version
  inspect_deps "${PREFIX}/bin/ttyd"
  # TODO (CI): otool -L で /usr/lib/.. 以外の dylib があれば
  # install_name_tool -change で @executable_path/../Frameworks/<name> に書き換え、
  # 該当 dylib を ${PREFIX}/Frameworks/ にコピー。
else
  echo "[skeleton] ttyd binary not built (configure/make steps are TODO)"
  exit 0
fi
