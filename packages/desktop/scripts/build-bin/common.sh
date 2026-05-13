#!/usr/bin/env bash
# F4: tmux / ttyd 同梱用クロスビルドスクリプトの共通関数
#
# 想定実行環境: macOS 14 (arm64), GitHub Actions `macos-14` runner。
# ローカル mac でも `bash build-tmux.sh` 単体で動くようにする。
# Linux ローカルでは syntax check のみ可能 (`bash -n`)。
#
# 環境変数:
#   BUILD_DIR        ビルド作業ディレクトリ (default: ./build)
#   PREFIX           インストール先 (default: $BUILD_DIR/prefix)
#   DEPLOYMENT_TARGET macOS deployment target (default: 14.0)
#   ARCH             ターゲットアーキ (default: arm64)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="${SCRIPT_DIR}/manifest.json"

BUILD_DIR="${BUILD_DIR:-${SCRIPT_DIR}/build}"
PREFIX="${PREFIX:-${BUILD_DIR}/prefix}"
SRC_DIR="${BUILD_DIR}/src"
DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET:-14.0}"
ARCH="${ARCH:-arm64}"

mkdir -p "${BUILD_DIR}" "${PREFIX}" "${SRC_DIR}"

# CFLAGS / LDFLAGS は arm64 native build を強制し、static link を優先する。
# macOS 14 SDK の deployment target を pin して Apple Silicon 14.x 互換に揃える。
export MACOSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}"
export CFLAGS="-arch ${ARCH} -mmacosx-version-min=${DEPLOYMENT_TARGET} -I${PREFIX}/include"
export LDFLAGS="-arch ${ARCH} -mmacosx-version-min=${DEPLOYMENT_TARGET} -L${PREFIX}/lib"
export PKG_CONFIG_PATH="${PREFIX}/lib/pkgconfig:${PREFIX}/share/pkgconfig:${PKG_CONFIG_PATH:-}"
export PATH="${PREFIX}/bin:${PATH}"

# JSON manifest から `.<package>.url` / `.<package>.sha256` / `.<package>.version` を取り出す。
# jq に依存 (GitHub Actions macos-14 にプリインストール済み)。
manifest_get() {
  local key="$1"
  jq -r "${key}" "${MANIFEST_PATH}"
}

# tarball を URL から取得し、SHA256 を検証してから src/<name>/ に展開する。
# 既に展開済みなら skip。
fetch_and_extract() {
  local name="$1"
  local url="$2"
  local sha256="$3"

  local archive="${BUILD_DIR}/archives/${name}.tar.gz"
  mkdir -p "${BUILD_DIR}/archives" "${SRC_DIR}/${name}"

  if [[ ! -f "${archive}" ]]; then
    echo "[fetch] ${name}: ${url}"
    curl -fsSL --retry 3 -o "${archive}" "${url}"
  fi

  if [[ "${sha256}" != "PLACEHOLDER_"* ]]; then
    echo "${sha256}  ${archive}" | shasum -a 256 -c -
  else
    # PLACEHOLDER SHA256 は skeleton 段階の dev build 用。
    # ARK_BUILD_STRICT_CHECKSUM=1 (tag push 等) では integrity guard を強制し fail させる。
    if [[ "${ARK_BUILD_STRICT_CHECKSUM:-0}" == "1" ]]; then
      echo "[error] ${name}: PLACEHOLDER SHA256 not allowed in strict mode (ARK_BUILD_STRICT_CHECKSUM=1)" >&2
      return 1
    fi
    echo "[warn] ${name}: SHA256 is placeholder, skipping verification (development only)"
  fi

  # 既に展開済み (configure ファイルがある) ならスキップ
  if compgen -G "${SRC_DIR}/${name}/*/configure" > /dev/null \
     || compgen -G "${SRC_DIR}/${name}/*/CMakeLists.txt" > /dev/null; then
    return 0
  fi

  echo "[extract] ${name}"
  tar -xzf "${archive}" -C "${SRC_DIR}/${name}" --strip-components=0
}

# `otool -L <bin>` で動的依存を表示する debug helper。
# 同梱対象でないシステム dylib (`/usr/lib/...`, `/System/...`) 以外は
# `install_name_tool -change` で `@executable_path/../Frameworks/...` に書き換える必要あり。
inspect_deps() {
  local bin="$1"
  echo "==> otool -L ${bin}"
  otool -L "${bin}" || true
}

# build スレッド数。GHA macos-14 runner では sysctl で取得した値を使う。
build_jobs() {
  sysctl -n hw.ncpu 2>/dev/null || echo "4"
}

# 展開済みディレクトリのパス。`fetch_and_extract` 直後のソース木 (configure / CMakeLists.txt
# を持つ第 1 階層) を返す。tarball によって直下構成が異なる (e.g. libuv は
# `libuv-v1.49.2/`、ttyd は `ttyd-1.7.7/`) ので一意に解決する。
source_dir() {
  local name="$1"
  local src
  src=$(find "${SRC_DIR}/${name}" -mindepth 1 -maxdepth 1 -type d | head -n1)
  if [[ -z "${src}" ]]; then
    echo "[error] source_dir(${name}): no extracted directory under ${SRC_DIR}/${name}" >&2
    return 1
  fi
  printf '%s\n' "${src}"
}

# autoconf 系 (configure && make && make install) の標準ビルダ。
# 引数: $1 name (manifest キーと一致), $2.. configure flags
# 既に ${PREFIX}/.built.<name> が存在すれば skip (cache hit 時の重複 build 防止)。
build_autoconf() {
  local name="$1"
  shift
  local stamp="${PREFIX}/.built.${name}"
  if [[ -f "${stamp}" ]]; then
    echo "[skip] ${name}: already built (stamp=${stamp})"
    return 0
  fi
  local src
  src=$(source_dir "${name}") || return 1
  echo "===== build_autoconf ${name} (src=${src}) ====="
  pushd "${src}" >/dev/null
  ./configure --prefix="${PREFIX}" "$@"
  make -j"$(build_jobs)"
  make install
  popd >/dev/null
  : > "${stamp}"
}

# cmake 系 (mkdir build && cmake && make && make install) の標準ビルダ。
# 引数: $1 name, $2.. cmake -D flags
# CMAKE_BUILD_TYPE / CMAKE_OSX_DEPLOYMENT_TARGET / CMAKE_OSX_ARCHITECTURES /
# CMAKE_INSTALL_PREFIX は固定で付与。
build_cmake() {
  local name="$1"
  shift
  local stamp="${PREFIX}/.built.${name}"
  if [[ -f "${stamp}" ]]; then
    echo "[skip] ${name}: already built (stamp=${stamp})"
    return 0
  fi
  local src
  src=$(source_dir "${name}") || return 1
  echo "===== build_cmake ${name} (src=${src}) ====="
  local builddir="${src}/build"
  mkdir -p "${builddir}"
  pushd "${builddir}" >/dev/null
  cmake \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="${PREFIX}" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}" \
    -DCMAKE_OSX_ARCHITECTURES="${ARCH}" \
    "$@" \
    ..
  make -j"$(build_jobs)"
  make install
  popd >/dev/null
  : > "${stamp}"
}

# 同梱バイナリの dyld 依存をチェック。
# system path (`/usr/lib/*`, `/System/Library/*`) 以外の dylib が混入していたら
# それは static link の漏れか rpath 解決失敗を意味するので fail させる。
# self-contained な binary であることを assertive に保証する。
assert_self_contained() {
  local bin="$1"
  echo "==> assert_self_contained ${bin}"
  if [[ ! -x "${bin}" ]]; then
    echo "[error] ${bin} not executable"
    return 1
  fi
  local nonsystem
  # otool -L は header 行を出すので tail で除去。インデント先頭がパス。
  nonsystem=$(otool -L "${bin}" \
    | tail -n +2 \
    | awk '{print $1}' \
    | grep -vE '^(/usr/lib/|/System/Library/|@rpath/|@loader_path/|@executable_path/)' \
    || true)
  if [[ -n "${nonsystem}" ]]; then
    echo "[error] ${bin} has non-system dylib deps:"
    printf '  %s\n' "${nonsystem}"
    echo "static link が漏れているか rpath 未解決。build スクリプトを見直すこと。"
    return 1
  fi
  echo "OK: ${bin} は self-contained (system dylib のみに依存)"
}
