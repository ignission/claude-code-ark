#!/usr/bin/env bash
# F4: macOS arm64 向け ttyd クロスビルドスクリプト
#
# 依存: zlib, OpenSSL 3.x, libuv, libwebsockets 4.3 系 (manifest.json 参照)。
# 出力: ${PREFIX}/bin/ttyd (全 deps を static link した self-contained binary)。
#
# 落とし穴:
#   - libwebsockets 4.3 系を pin (4.4+ は ttyd 1.7.x との API 差異あり)
#   - OpenSSL 3.x は `no-shared` で組まないと libwebsockets が static link できない
#   - zlib は Makefile を生成する `configure` が独自方言、--static フラグだけ通る
#
# 参考: https://github.com/tsl0922/ttyd#build-from-source

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

echo "===== build-ttyd.sh: macOS ${ARCH} =====" >&2

# ----- 依存ライブラリの取得 + ビルド (静的) -----

# 1. zlib
#    `./configure --static --prefix=...` で .a のみ生成。
#    autoconf 系の標準フローでは無いので build_autoconf は使えず手動 build。
ZLIB_URL=$(manifest_get '.dependencies.zlib.url')
ZLIB_SHA=$(manifest_get '.dependencies.zlib.sha256')
fetch_and_extract "zlib" "${ZLIB_URL}" "${ZLIB_SHA}"
if [[ ! -f "${PREFIX}/.built.zlib" ]]; then
  ZLIB_SRC=$(source_dir "zlib")
  pushd "${ZLIB_SRC}" >/dev/null
  ./configure --prefix="${PREFIX}" --static
  make -j"$(build_jobs)"
  make install
  popd >/dev/null
  : > "${PREFIX}/.built.zlib"
fi

# 2. OpenSSL 3.x
#    `./Configure darwin64-arm64-cc no-shared` で .a のみ。
#    `make install_sw` で manpage 等を含めない (build 時間短縮)。
OPENSSL_URL=$(manifest_get '.dependencies.openssl.url')
OPENSSL_SHA=$(manifest_get '.dependencies.openssl.sha256')
fetch_and_extract "openssl" "${OPENSSL_URL}" "${OPENSSL_SHA}"
if [[ ! -f "${PREFIX}/.built.openssl" ]]; then
  OPENSSL_SRC=$(source_dir "openssl")
  pushd "${OPENSSL_SRC}" >/dev/null
  ./Configure darwin64-arm64-cc \
    no-shared \
    --prefix="${PREFIX}" \
    --openssldir="${PREFIX}/etc/openssl" \
    -mmacosx-version-min="${DEPLOYMENT_TARGET}"
  make -j"$(build_jobs)"
  make install_sw
  popd >/dev/null
  : > "${PREFIX}/.built.openssl"
fi

# 3. libuv
#    autoconf + libtool。--disable-shared で .a のみ。
LIBUV_URL=$(manifest_get '.dependencies.libuv.url')
LIBUV_SHA=$(manifest_get '.dependencies.libuv.sha256')
fetch_and_extract "libuv" "${LIBUV_URL}" "${LIBUV_SHA}"
# libuv の tarball は autogen.sh で configure を生成する必要あり
if [[ ! -f "${PREFIX}/.built.libuv" ]]; then
  LIBUV_SRC=$(source_dir "libuv")
  if [[ ! -f "${LIBUV_SRC}/configure" ]]; then
    pushd "${LIBUV_SRC}" >/dev/null
    sh autogen.sh
    popd >/dev/null
  fi
fi
build_autoconf "libuv" \
  --disable-shared \
  --enable-static

# 4. libwebsockets (4.3 系)
#    cmake + OpenSSL/zlib/libuv 指定 + STATIC のみ。
#    LWS_WITH_SHARED=OFF: .dylib を出力しない。
#    LWS_WITH_STATIC=ON: .a を出力。
#    LWS_WITH_LIBUV=ON: ttyd は libwebsockets 経由で libuv を使う。
#    LWS_OPENSSL_SUPPORT=ON で OpenSSL 必須。
LWS_URL=$(manifest_get '.dependencies.libwebsockets.url')
LWS_SHA=$(manifest_get '.dependencies.libwebsockets.sha256')
fetch_and_extract "libwebsockets" "${LWS_URL}" "${LWS_SHA}"
build_cmake "libwebsockets" \
  -DLWS_WITH_SHARED=OFF \
  -DLWS_WITH_STATIC=ON \
  -DLWS_WITHOUT_TESTAPPS=ON \
  -DLWS_WITHOUT_TEST_SERVER=ON \
  -DLWS_WITHOUT_TEST_SERVER_EXTPOLL=ON \
  -DLWS_WITHOUT_TEST_PING=ON \
  -DLWS_WITHOUT_TEST_CLIENT=ON \
  -DLWS_WITH_LIBUV=ON \
  -DLWS_LIBUV_LIBRARIES="${PREFIX}/lib/libuv.a" \
  -DLWS_LIBUV_INCLUDE_DIRS="${PREFIX}/include" \
  -DLWS_OPENSSL_SUPPORT=ON \
  -DOPENSSL_ROOT_DIR="${PREFIX}" \
  -DOPENSSL_INCLUDE_DIR="${PREFIX}/include" \
  -DOPENSSL_SSL_LIBRARY="${PREFIX}/lib/libssl.a" \
  -DOPENSSL_CRYPTO_LIBRARY="${PREFIX}/lib/libcrypto.a" \
  -DZLIB_ROOT="${PREFIX}" \
  -DZLIB_LIBRARY="${PREFIX}/lib/libz.a" \
  -DZLIB_INCLUDE_DIR="${PREFIX}/include" \
  -DCMAKE_PREFIX_PATH="${PREFIX}"

# 5. ttyd 本体
#    cmake で libwebsockets/json-c/zlib を ${PREFIX} から拾わせる。
#    static link を強制するため CMAKE_FIND_LIBRARY_SUFFIXES を .a 限定にする。
TTYD_URL=$(manifest_get '.ttyd.url')
TTYD_SHA=$(manifest_get '.ttyd.sha256')
fetch_and_extract "ttyd" "${TTYD_URL}" "${TTYD_SHA}"
build_cmake "ttyd" \
  -DCMAKE_PREFIX_PATH="${PREFIX}" \
  -DCMAKE_FIND_LIBRARY_SUFFIXES=".a" \
  -DLIBWEBSOCKETS_INCLUDE_DIRS="${PREFIX}/include" \
  -DLIBWEBSOCKETS_LIBRARIES="${PREFIX}/lib/libwebsockets.a" \
  -DOPENSSL_ROOT_DIR="${PREFIX}" \
  -DOPENSSL_SSL_LIBRARY="${PREFIX}/lib/libssl.a" \
  -DOPENSSL_CRYPTO_LIBRARY="${PREFIX}/lib/libcrypto.a" \
  -DZLIB_ROOT="${PREFIX}" \
  -DZLIB_LIBRARY="${PREFIX}/lib/libz.a"

# ----- 出力検証 -----
TTYD_BIN="${PREFIX}/bin/ttyd"
if [[ ! -x "${TTYD_BIN}" ]]; then
  echo "[error] ttyd binary not built at ${TTYD_BIN}"
  exit 1
fi

echo "===== build-ttyd.sh: success ====="
"${TTYD_BIN}" --version
inspect_deps "${TTYD_BIN}"
assert_self_contained "${TTYD_BIN}"
