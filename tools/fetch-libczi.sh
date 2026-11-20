#!/bin/bash
# Builds ZEISS libCZI's C API (libCZIAPI, a shared library) from a pinned, checksummed source
# tarball and puts it where the app finds it at runtime (loaded with libloading, like OpenSlide):
#   tools/fetch-libczi.sh mac       -> app/src-tauri/frameworks/libCZIAPI.dylib  (arm64 + x86_64)
#   tools/fetch-libczi.sh windows   -> app/src-tauri/lib/libCZIAPI.dll           (x64, static CRT)
#
# Why a runtime-loaded shared library and not a static link from build.rs:
#   - libCZI's core is LGPL-3.0-or-later (its C API layer is MIT). Shipping it as a separate,
#     replaceable shared library keeps the app LGPL-compliant.
#   - `cargo check` / `cargo test` never need CMake or a C++ toolchain; without the library,
#     .czi files simply fail to open with a clear message.
#   - The same script runs on the Windows CI runner (Git Bash + CMake + MSVC are preinstalled).
#
# Needs: cmake >= 3.15 and a C++17 compiler. CMake downloads libCZI's own pinned dependencies
# (zstd v1.5.7, lz4 v1.10.0, Eigen, RapidJSON) by git tag/commit during configure.
# Bump COMMIT and SHA together (GitHub source archive of that commit).
set -euo pipefail
COMMIT="d74e581e75fbb088dc18a9e46f1d490470150758"   # libCZI 0.72.0 (main, 2026-11-06)
SHA="50416e93abb2948c682a623860596ffa1605c0c90528e579d69ca71734423bb4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$ROOT/app/src-tauri"
TMP="${LIBCZI_BUILD_DIR:-$(mktemp -d)}"
[ -n "${LIBCZI_BUILD_DIR:-}" ] || trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP"
sha() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{print $1}'; }

curl -fsSL --retry 3 -o "$TMP/libczi.tar.gz" "https://github.com/ZEISS/libczi/archive/$COMMIT.tar.gz"
[ "$(sha "$TMP/libczi.tar.gz")" = "$SHA" ] || { echo "checksum mismatch for libczi $COMMIT" >&2; exit 1; }
rm -rf "$TMP/src" && mkdir -p "$TMP/src"
tar -xzf "$TMP/libczi.tar.gz" -C "$TMP/src"
SRC="$TMP/src/libczi-$COMMIT"

OPTS=(
  -DCMAKE_BUILD_TYPE=Release
  -DLIBCZI_BUILD_LIBCZIAPI=ON
  -DLIBCZI_BUILD_UNITTESTS=OFF
  -DLIBCZI_BUILD_CZICMD=OFF
  -DLIBCZI_BUILD_DYNLIB=OFF
  -DLIBCZI_BUILD_CURL_BASED_STREAM=OFF
  -DLIBCZI_BUILD_AZURESDK_BASED_STREAM=OFF
  -DLIBCZI_BUILD_PREFER_EXTERNALPACKAGE_ZSTD=OFF
  -DLIBCZI_BUILD_PREFER_EXTERNALPACKAGE_EIGEN3=OFF
  -DLIBCZI_BUILD_PREFER_EXTERNALPACKAGE_RAPIDJSON=OFF
)

case "${1:?mac or windows}" in
  mac)
    cmake -S "$SRC" -B "$TMP/build" "${OPTS[@]}" \
      -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
    cmake --build "$TMP/build" --config Release --target libCZIAPI -j 8
    lib="$(find "$TMP/build" -name 'liblibCZIAPI*.dylib' -o -name 'libCZIAPI*.dylib' | grep -v '\.dSYM' | head -1)"
    [ -n "$lib" ] || { echo "libCZIAPI.dylib not found in the build" >&2; exit 1; }
    mkdir -p "$T/frameworks"
    cp "$lib" "$T/frameworks/libCZIAPI.dylib"
    install_name_tool -id "@rpath/libCZIAPI.dylib" "$T/frameworks/libCZIAPI.dylib"
    codesign --force -s - "$T/frameworks/libCZIAPI.dylib" 2>/dev/null || true
    cp "$SRC/COPYING" "$T/frameworks/libCZI-LICENSE.txt"
    lipo -info "$T/frameworks/libCZIAPI.dylib"
    ;;
  windows)
    cmake -S "$SRC" -B "$TMP/build" "${OPTS[@]}" -A x64
    cmake --build "$TMP/build" --config Release --target libCZIAPI -j 8
    lib="$(find "$TMP/build" -iname 'libCZIAPI.dll' | head -1)"
    [ -n "$lib" ] || { echo "libCZIAPI.dll not found in the build" >&2; exit 1; }
    mkdir -p "$T/lib"
    cp "$lib" "$T/lib/libCZIAPI.dll"
    cp "$SRC/COPYING" "$T/lib/libCZI-LICENSE.txt"
    ls -l "$T/lib"
    ;;
  *) echo "usage: $0 mac|windows" >&2; exit 2 ;;
esac
