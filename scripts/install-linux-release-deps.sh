#!/usr/bin/env bash
set -euo pipefail

# Release builds target Ubuntu 22.04 amd64 to preserve the glibc 2.35 baseline.
# Hosted runner mirror+file sources can keep trying azure.archive.ubuntu.com
# even after DNS failures. Use official HTTPS repositories for this invocation,
# with fresh indexes so cached package URLs cannot point back to that mirror.
apt_workdir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/taomni-release-apt.XXXXXX")"
trap 'sudo rm -rf -- "$apt_workdir"' EXIT
chmod 755 "$apt_workdir"
mkdir -p "$apt_workdir/lists"
cat > "$apt_workdir/sources.list" <<'SOURCES'
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy main restricted universe multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy-updates main restricted universe multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy-backports main restricted universe multiverse
deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu jammy-security main restricted universe multiverse
SOURCES

apt_options=(
  -o "Dir::Etc::sourcelist=$apt_workdir/sources.list"
  -o "Dir::Etc::sourceparts=-"
  -o "Dir::State::lists=$apt_workdir/lists"
  -o "APT::Get::List-Cleanup=0"
  -o "Acquire::Retries=3"
  -o "Acquire::http::Timeout=30"
  -o "Acquire::https::Timeout=30"
)

# apt-get update normally returns success with warnings and stale indexes.
# Any missing index must stop the release before package installation.
sudo apt-get "${apt_options[@]}" -o APT::Update::Error-Mode=any update

# Base bundle deps + LanChat native A/V: nasm for openh264, ALSA for cpal,
# V4L for nokhwa. Meson/ninja/clang build newer PipeWire headers in the next
# workflow step; stock jammy PipeWire alone is too old for libspa 0.9.
sudo apt-get "${apt_options[@]}" install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libkrb5-dev \
  nasm \
  libasound2-dev \
  libv4l-dev \
  libpipewire-0.3-dev \
  libclang-dev \
  libdbus-1-dev \
  libudev-dev \
  meson \
  ninja-build \
  pkg-config
