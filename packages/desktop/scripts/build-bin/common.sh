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
    echo "[warn] ${name}: SHA256 is placeholder, skipping verification"
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
