#!/usr/bin/env bash
set -euo pipefail
PW_VER=1.0.9
workdir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/taomni-pipewire.XXXXXX")"
trap 'rm -rf -- "$workdir"' EXIT
# GitHub mirror of the freedsktop tag (stable for CI downloads).
curl -fsSL --retry 3 "https://github.com/PipeWire/pipewire/archive/refs/tags/${PW_VER}.tar.gz" -o "$workdir/pipewire.tar.gz"
sha256sum --check <<< "a295b3856bc7f55f70be5273f6bad4410cc7893f9ae376f0c04c64357ff824ce  $workdir/pipewire.tar.gz"
tar -xzf "$workdir/pipewire.tar.gz" -C "$workdir" --strip-components=1
cd "$workdir"
meson setup build \
  --prefix=/usr/local \
  --buildtype=release \
  -Ddocs=disabled \
  -Dman=disabled \
  -Dtests=disabled \
  -Dexamples=disabled \
  -Dinstalled_tests=disabled \
  -Dsession-managers=[] \
  -Dsystemd=disabled \
  -Dselinux=disabled \
  -Dpipewire-alsa=disabled \
  -Dpipewire-jack=disabled \
  -Dpipewire-v4l2=disabled \
  -Djack=disabled \
  -Dbluez5=disabled \
  -Dffmpeg=disabled \
  -Dlibcamera=disabled \
  -Droc=disabled \
  -Dlv2=disabled \
  -Dsdl2=disabled \
  -Dsndfile=disabled \
  -Dlibpulse=disabled \
  -Davahi=disabled \
  -Decho-cancel-webrtc=disabled \
  -Dgstreamer=disabled \
  -Dreadline=disabled \
  -Draop=disabled \
  -Dgsettings=disabled \
  -Dlibcanberra=disabled \
  -Dflatpak=disabled \
  -Drlimits-install=false
meson compile -C build
sudo meson install -C build
sudo ldconfig
# Prefer /usr/local headers and libs over stock jammy packages.
{
  echo "PKG_CONFIG_PATH=/usr/local/lib/x86_64-linux-gnu/pkgconfig:/usr/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
  echo "LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:${LIBRARY_PATH:-}"
  echo "LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:${LD_LIBRARY_PATH:-}"
} >> "$GITHUB_ENV"
export PKG_CONFIG_PATH="/usr/local/lib/x86_64-linux-gnu/pkgconfig:/usr/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
echo "libpipewire version: $(pkg-config --modversion libpipewire-0.3)"
pkg-config --cflags --libs libpipewire-0.3
# Sanity-check headers include the fields libspa 0.9 needs.
grep -q 'uint32_t flags' /usr/local/include/spa-0.2/spa/param/video/raw.h
grep -q 'uint64_t modifier' /usr/local/include/spa-0.2/spa/param/video/raw.h
