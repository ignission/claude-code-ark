#!/usr/bin/env bash
# F4: macOS arm64 向け tmux クロスビルドスクリプト
#
# 依存: ncurses, libevent (manifest.json 参照)。
# 出力: ${PREFIX}/bin/tmux (全 deps を static link した self-contained binary)。
#
# 設計: 全依存を `--disable-shared` で .a のみ生成し、tmux は最終的に
# system dylib (libSystem) のみに依存する形に纏める。これで
# install_name_tool による rpath 調整も Frameworks/ 同梱も不要になる。
#
# 参考:
#   - tmux build: https://github.com/tmux/tmux/wiki/Installing
#   - ncurses + macOS: terminfo の搭載先 (`--enable-pc-files`) が rpath 無しでも
#     動くよう $TERMINFO_DIRS にデフォルトを含める

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

echo "===== build-tmux.sh: macOS ${ARCH} =====" >&2

# ----- 依存ライブラリの取得 + ビルド (静的) -----

# 1. ncurses
#    --without-shared / --enable-static で .a のみ。
#    --without-debug でビルド速度 + サイズを優先。
#    --without-ada はランタイム不要 (依存に Ada が要る環境のみ).
#    --with-default-terminfo-dir + --with-terminfo-dirs で binary が
#    /usr/share/terminfo (システム既定) + 自ビルド両方を見にいく。
NCURSES_URL=$(manifest_get '.dependencies.ncurses.url')
NCURSES_SHA=$(manifest_get '.dependencies.ncurses.sha256')
fetch_and_extract "ncurses" "${NCURSES_URL}" "${NCURSES_SHA}"
# ncurses は `make install` で /usr/share/terminfo へ tic 経由で書き込もうとして
# permission denied で fail する (--with-default-terminfo-dir に system path を
# 指定すると `make install.data` の install target がそこを使う)。
# runtime は --with-default-terminfo-dir で指定した system terminfo を読みに行く
# ので、ビルド時に terminfo を埋める必要はない。よって install を
# `install.libs + install.includes` に絞り込み、terminfo install をスキップする。
if [[ ! -f "${PREFIX}/.built.ncurses" ]]; then
  NCURSES_SRC=$(source_dir "ncurses")
  pushd "${NCURSES_SRC}" >/dev/null
  ./configure --prefix="${PREFIX}" \
    --without-shared \
    --enable-static \
    --without-debug \
    --without-ada \
    --enable-widec \
    --with-default-terminfo-dir=/usr/share/terminfo \
    --with-terminfo-dirs="/usr/share/terminfo:/usr/share/lib/terminfo:/usr/lib/terminfo:/usr/local/share/terminfo:/etc/terminfo"
  make -j"$(build_jobs)"
  make install.libs install.includes
  popd >/dev/null
  : > "${PREFIX}/.built.ncurses"
fi

# ncurses widec ABI は libncursesw.a / libtinfow.a を出力するが、tmux の configure は
# libncurses / libtinfo を探す。後者を前者へ symlink して configure を通す。
# (configure 引数で --with-ncurses-includes を渡しても解決できるが、
#  link 時の -lncurses 解決まで含めるならファイルレベルの alias の方が頑健。)
for libname in ncurses tinfo form menu panel; do
  if [[ -f "${PREFIX}/lib/lib${libname}w.a" && ! -f "${PREFIX}/lib/lib${libname}.a" ]]; then
    ln -sf "lib${libname}w.a" "${PREFIX}/lib/lib${libname}.a"
  fi
done
# include alias: ncursesw/curses.h → ncurses/curses.h を兼ねる
if [[ -d "${PREFIX}/include/ncursesw" && ! -d "${PREFIX}/include/ncurses" ]]; then
  ln -sf "ncursesw" "${PREFIX}/include/ncurses"
fi

# ncurses build の出力を assertive に確認: tmux 側で -lncurses を解決するために
# libncurses.a (上の symlink 後の名前) が ${PREFIX}/lib に存在する必要がある。
# libtinfo は ncurses build の構成によっては libncurses.a に内蔵される場合があるため、
# 存在しない場合は LIBTINFO_LIBS を空に倒して `-ltinfo` 解決のためにホスト側を
# 探索する経路を完全に塞ぐ (assert_self_contained の検証で漏れも検知される)。
if [[ ! -f "${PREFIX}/lib/libncurses.a" ]]; then
  echo "[error] libncurses.a not found after ncurses build" >&2
  ls -la "${PREFIX}/lib/" >&2
  exit 1
fi
HAS_TINFO=0
if [[ -f "${PREFIX}/lib/libtinfo.a" ]]; then
  HAS_TINFO=1
fi

# 2. libevent
#    --disable-shared でstatic only。
#    --disable-openssl: tmux 経路では SSL 不要なので絞り込み。
#    --disable-debug-mode はパフォーマンス重視。
LIBEVENT_URL=$(manifest_get '.dependencies.libevent.url')
LIBEVENT_SHA=$(manifest_get '.dependencies.libevent.sha256')
fetch_and_extract "libevent" "${LIBEVENT_URL}" "${LIBEVENT_SHA}"
build_autoconf "libevent" \
  --disable-shared \
  --enable-static \
  --disable-openssl \
  --disable-debug-mode \
  --disable-samples

# 3. tmux 本体
#    CPPFLAGS / LDFLAGS 経由で ${PREFIX}/include と ${PREFIX}/lib を優先解決させる。
#    LIBEVENT_CFLAGS / LIBEVENT_LIBS を明示して pkg-config 不在時も link を成立させる。
#    --enable-static は tmux 1.8 以降の慣例的フラグ (libevent / ncurses を埋め込む)。
TMUX_URL=$(manifest_get '.tmux.url')
TMUX_SHA=$(manifest_get '.tmux.sha256')
fetch_and_extract "tmux" "${TMUX_URL}" "${TMUX_SHA}"

# tmux の configure に渡す追加フラグを export 経由で組み立てる。
# CFLAGS は common.sh で既に -arch / -I${PREFIX}/include を持つ。
# tmux configure は `libevent` を pkg-config or 環境変数で見つける必要あり。
# LIBTINFO_LIBS は libtinfo.a が ncurses build で生成された場合のみ渡す
# (生成されない構成では `-ltinfo` 解決がホスト側に流れる事故を避けるため空のまま)。
TMUX_CONFIG_FLAGS=(
  --enable-static
  LIBEVENT_CFLAGS="-I${PREFIX}/include"
  LIBEVENT_LIBS="-L${PREFIX}/lib -levent"
  LIBNCURSES_CFLAGS="-I${PREFIX}/include -I${PREFIX}/include/ncurses"
  LIBNCURSES_LIBS="-L${PREFIX}/lib -lncurses"
)
if [[ "${HAS_TINFO}" = "1" ]]; then
  TMUX_CONFIG_FLAGS+=(
    LIBTINFO_CFLAGS="-I${PREFIX}/include"
    LIBTINFO_LIBS="-L${PREFIX}/lib -ltinfo"
  )
fi
build_autoconf "tmux" "${TMUX_CONFIG_FLAGS[@]}"

# ----- 出力検証 -----
TMUX_BIN="${PREFIX}/bin/tmux"
if [[ ! -x "${TMUX_BIN}" ]]; then
  echo "[error] tmux binary not built at ${TMUX_BIN}"
  exit 1
fi

echo "===== build-tmux.sh: success ====="
"${TMUX_BIN}" -V
inspect_deps "${TMUX_BIN}"
assert_self_contained "${TMUX_BIN}"
