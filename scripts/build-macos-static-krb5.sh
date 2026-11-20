#!/usr/bin/env bash
# Build the MIT client closure for the macOS ARM64 hardened-runtime comparison.
set -euo pipefail

prefix="${1:?Usage: build-macos-static-krb5.sh <absolute-install-prefix>}"
test "$(uname -sm)" = "Darwin arm64"
test ! -e "$prefix"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/taomni-krb5-build.XXXXXX")"
trap 'rm -rf "$work"' EXIT

version=1.22.3
expected_sha=fe90af8441ad9fa9b064b8e53077cefb782a96f8a68276b031dc54af1789ff0b
archive="$work/krb5.tar.gz"
curl --proto '=https' --fail --silent --show-error --location --retry 3 \
  "https://kerberos.org/dist/krb5/1.22/krb5-$version.tar.gz" --output "$archive"
printf '%s  %s\n' "$expected_sha" "$archive" | shasum -a 256 --check
tar -xzf "$archive" -C "$work"

openssl_prefix="$(brew --prefix openssl@4)"
mkdir -p "$prefix/lib"
for library in libssl.a libcrypto.a; do
  cp "$openssl_prefix/lib/$library" "$prefix/lib/"
done

(
  cd "$work/krb5-$version/src"
  # MIT's macOS cache adapter calls CCAPI in the system Kerberos framework.
  # Static archives cannot carry that dependency into the build's programs.
  CPPFLAGS="-I$openssl_prefix/include" LDFLAGS="-L$prefix/lib" \
    LIBS="-framework Kerberos" \
    ./configure --prefix="$prefix" --enable-static --disable-shared \
      --disable-nls --without-system-verto --with-tls-impl=openssl --with-spake-openssl
  make -j"$(sysctl -n hw.logicalcpu)"
  make install
)
pc="$prefix/lib/pkgconfig/mit-krb5.pc"
sed -i '' '/^Libs.private: /s/$/ -lssl -lcrypto -lresolv -framework Kerberos/' "$pc"
PKG_CONFIG_PATH="$prefix/lib/pkgconfig" pkg-config --static --libs mit-krb5-gssapi
for library in libgssapi_krb5.a libkrb5.a libk5crypto.a libcom_err.a libkrb5support.a libssl.a libcrypto.a; do
  test "$(lipo -archs "$prefix/lib/$library")" = arm64
done
cp "$work/krb5-$version/NOTICE" src-tauri/resources/licenses/MIT-Kerberos.txt
cp "$openssl_prefix/LICENSE.txt" src-tauri/resources/licenses/OpenSSL.txt
