#!/usr/bin/env bash
set -euo pipefail

wasm_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cache="$(realpath -m "${TAOFFICE_VISIO_CACHE:-$wasm_dir/.build/cache}")"
output="$wasm_dir/.build"
jobs="${TAOFFICE_VISIO_JOBS:-4}"
prefix="$cache/wasm-prefix"
mkdir -p "$output" "$prefix"

emcc --version | grep -m1 -E ' 4\.0\.23(-git)?[ (]'
export EMCC_CORES="$jobs"

download() {
  local filename="$1" url="$2" checksum="$3"
  if ! printf '%s  %s\n' "$checksum" "$cache/$filename" | sha256sum --check --status; then
    curl --fail --location --retry 3 --output "$cache/$filename.part" "$url"
    printf '%s  %s\n' "$checksum" "$cache/$filename.part" | sha256sum --check
    mv "$cache/$filename.part" "$cache/$filename"
  fi
  printf '%s  %s\n' "$checksum" "$cache/$filename" | sha256sum --check
}

libvisio_url="https://dev-www.libreoffice.org/src/libvisio/libvisio-0.1.12.tar.xz"
librevenge_url="https://dev-www.libreoffice.org/src/librevenge-0.0.5.tar.bz2"
libxml_url="https://download.gnome.org/sources/libxml2/2.15/libxml2-2.15.4.tar.xz"
download libvisio-0.1.12.tar.xz "$libvisio_url" f59fa2e3baf95475256fe84ea0aa1214f43940bae94424f4026b2d633933df01
download librevenge-0.0.5.tar.bz2 "$librevenge_url" 5892ca6796f7a2a93d580832e907e849b19d980b40d326a283b18877ab6de0c5
download libxml2-2.15.4.tar.xz "$libxml_url" 98087fd181d9070724f3fbc65c7377db03038eb92bd882374daff44940138821
for archive in libvisio-0.1.12.tar.xz librevenge-0.0.5.tar.bz2 libxml2-2.15.4.tar.xz; do
  directory="${archive%.tar.*}"
  if ! test -f "$cache/$directory/configure"; then
    tar -C "$cache" -xf "$cache/$archive"
  fi
done

# Emscripten verifies the hashes of its pinned zlib, Boost headers and ICU ports.
# Prebuild them before Autoconf resolves their headers and package metadata.
printf 'int main() { return 0; }\n' >"$cache/ports.c"
emcc "$cache/ports.c" -sUSE_ZLIB=1 -sUSE_BOOST_HEADERS=1 -sUSE_ICU=1 -o "$cache/ports.js"
emscripten_cache="$(em-config CACHE)"
sysroot="$emscripten_cache/sysroot"
export EM_PKG_CONFIG_PATH="$prefix/lib/pkgconfig"

export CFLAGS=-Os
export CXXFLAGS="-Os -fexceptions"
export CPPFLAGS="-I$sysroot/include"
export ICU_CFLAGS="-I$sysroot/include -DU_STATIC_IMPLEMENTATION"
export ICU_LIBS="-licu_common -licu_stubdata"

emcmake cmake -S "$cache/libxml2-2.15.4" -B "$cache/xml-latest-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=OFF \
  -DLIBXML2_WITH_HTTP=OFF -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_ICU=OFF \
  -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_READLINE=OFF \
  -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_THREADS=OFF -DLIBXML2_WITH_ZLIB=OFF
cmake --build "$cache/xml-latest-build" --parallel "$jobs"
cmake --install "$cache/xml-latest-build"

build_library() (
  local source="$1" build="$2"
  shift 2
  mkdir -p "$build"
  cd "$build"
  emconfigure "$source/configure" --build="$("$source/config.guess")" \
    --host=wasm32-unknown-none --prefix="$prefix" \
    --enable-static --disable-shared --disable-tests "$@"
  emmake make -j"$jobs"
  emmake make install
)
build_library "$cache/librevenge-0.0.5" "$cache/revenge-build" --without-docs
build_library "$cache/libvisio-0.1.12" "$cache/visio-build" --disable-tools

em++ "$wasm_dir/decoder.cpp" -std=c++17 -Os -fexceptions $ICU_CFLAGS \
  -I"$prefix/include/libvisio-0.1" -I"$prefix/include/librevenge-0.0" -L"$prefix/lib" \
  -lvisio-0.1 -lrevenge-stream-0.0 -lrevenge-0.0 -lxml2 -licu_common -licu_stubdata -sUSE_ZLIB=1 \
  --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createVisioEngine -sENVIRONMENT=worker \
  -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=2097152 \
  -sINCOMING_MODULE_JS_API=wasmBinary,locateFile,print,printErr \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_visio_init_icu,_visio_decode,_visio_page_count,_visio_page_svg,_visio_page_name \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString -o "$output/visio.mjs"

# libvisio uses ICU's encoding converters for binary Visio files.
icu="$emscripten_cache/ports/icu/icu"
icu_data="$icu/source/data/in/icudt68l.dat"
icupkg -l "$icu_data" >"$cache/icu-entries.txt"
awk '!/^(cnvalias\.icu|[^/]+\.cnv)$/' "$cache/icu-entries.txt" >"$cache/icu-remove.txt"
mkdir -p "$cache/icu-slim"
icupkg -r "$cache/icu-remove.txt" "$icu_data" "$cache/icu-slim/icudt68l.dat"
cp "$cache/icu-slim/icudt68l.dat" "$output/visio-icu.dat"

write_notice() {
  printf '\n%s\n%s\n\n' "$1" "$2"
  cat "$3"
}
{
  write_notice "libvisio 0.1.12 (MPL-2.0)" "$libvisio_url" "$cache/libvisio-0.1.12/COPYING.MPL"
  write_notice "librevenge 0.0.5 (MPL-2.0)" "$librevenge_url" "$cache/librevenge-0.0.5/COPYING.MPL"
  write_notice "libxml2 2.15.4 (MIT)" "$libxml_url" "$cache/libxml2-2.15.4/Copyright"
  write_notice "ICU 68.2" "https://github.com/unicode-org/icu/releases/tag/release-68-2" "$icu/LICENSE"
  write_notice "zlib 1.3.1" "https://github.com/madler/zlib/tree/v1.3.1" "$emscripten_cache/ports/zlib/zlib-1.3.1/LICENSE"
  write_notice "Boost headers 1.83.0" "https://github.com/emscripten-ports/boost/releases/tag/boost-1.83.0" \
    "$wasm_dir/Boost-LICENSE.txt"
  emscripten="$(em-config EMSCRIPTEN_ROOT)"
  emscripten_url="https://github.com/emscripten-core/emscripten/tree/4.0.23"
  write_notice "Emscripten 4.0.23" "$emscripten_url" "$emscripten/LICENSE"
  write_notice "musl" "$emscripten_url/system/lib/libc/musl" "$emscripten/system/lib/libc/musl/COPYRIGHT"
  for runtime in libcxx libcxxabi compiler-rt; do
    write_notice "$runtime" "$emscripten_url/system/lib/$runtime" "$emscripten/system/lib/$runtime/LICENSE.TXT"
  done
} >"$output/visio-third-party-notices.txt"
