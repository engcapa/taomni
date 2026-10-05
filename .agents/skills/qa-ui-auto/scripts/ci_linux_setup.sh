#!/usr/bin/env bash
set -euo pipefail

# QA-only provisioning. Release packaging keeps its independent recipe.
profile="${QA_LINUX_PROFILE:-ubuntu-24.04-xvfb}"
case "$profile" in
  ubuntu-24.04-xvfb|ubuntu-22.04-x11|ubuntu-22.04-vnc|ubuntu-26.04-wayland) ;;
  *) echo "Unknown Linux QA profile: $profile" >&2; exit 2 ;;
esac

sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev webkit2gtk-driver libappindicator3-dev librsvg2-dev \
  patchelf libkrb5-dev libasound2-dev libv4l-dev libpipewire-0.3-dev libclang-dev \
  libdbus-1-dev libudev-dev libgbm-dev nasm python3-tk python3-gi gir1.2-gtk-3.0 \
  fonts-noto-cjk tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
  gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad dbus-x11

if [[ "$profile" == *wayland ]]; then
  sudo apt-get install -y ubuntu-desktop-minimal gnome-shell ubuntu-session \
    xdg-desktop-portal xdg-desktop-portal-gnome xdg-desktop-portal-gtk \
    pipewire wireplumber wayland-utils wl-clipboard
else
  sudo apt-get install -y xvfb xauth openbox xcompmgr wmctrl xdotool x11-utils \
    x11-xserver-utils libxtst6 xclip imagemagick fcitx5 fcitx5-frontend-gtk3 fcitx5-chinese-addons
  if [[ "$profile" == ubuntu-22.04-* ]]; then
    sudo apt-get install -y lxqt-core
  fi
  if [[ "$profile" == ubuntu-22.04-vnc ]]; then
    sudo apt-get install -y tigervnc-standalone-server tigervnc-tools
  fi
fi

if [[ ",${QA_CAPABILITIES:-}," == *",audio,"* ]]; then
  sudo apt-get install -y pipewire wireplumber pipewire-pulse pipewire-alsa pulseaudio-utils
fi

# pipewire-rs v0_3_49 needs pw_buffer.requested, absent in Jammy's headers.
# Match the release build's 1.0.9 overlay, without editing release.yml or
# changing the glibc baseline. This is for QA compilation/runtime only.
if [[ "$profile" == ubuntu-22.04-* ]]; then
  sudo apt-get install -y meson ninja-build pkg-config
  pipewire_work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/qa-pipewire-XXXXXX")"
  trap 'rm -rf "$pipewire_work"' EXIT
  curl --fail --location --retry 3 \
    https://github.com/PipeWire/pipewire/archive/refs/tags/1.0.9.tar.gz \
    --output "$pipewire_work/pipewire.tar.gz"
  echo "a295b3856bc7f55f70be5273f6bad4410cc7893f9ae376f0c04c64357ff824ce  $pipewire_work/pipewire.tar.gz" | sha256sum --check
  tar -xzf "$pipewire_work/pipewire.tar.gz" -C "$pipewire_work" --strip-components=1
  meson setup "$pipewire_work/build" "$pipewire_work" --prefix=/usr/local --buildtype=release \
    -Ddocs=disabled -Dman=disabled -Dtests=disabled -Dexamples=disabled \
    -Dinstalled_tests=disabled -Dsession-managers=[] -Dsystemd=disabled \
    -Dselinux=disabled -Dpipewire-alsa=disabled -Dpipewire-jack=disabled \
    -Dpipewire-v4l2=disabled -Djack=disabled -Dbluez5=disabled -Dffmpeg=disabled \
    -Dlibcamera=disabled -Droc=disabled -Dlv2=disabled -Dsdl2=disabled \
    -Dsndfile=disabled -Dlibpulse=disabled -Davahi=disabled -Decho-cancel-webrtc=disabled \
    -Dgstreamer=disabled -Dreadline=disabled -Draop=disabled -Dgsettings=disabled \
    -Dlibcanberra=disabled -Dflatpak=disabled -Drlimits-install=false
  meson compile -C "$pipewire_work/build"
  sudo meson install -C "$pipewire_work/build"
  sudo ldconfig
  {
    echo "PKG_CONFIG_PATH=/usr/local/lib/x86_64-linux-gnu/pkgconfig:/usr/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
    echo "LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:${LIBRARY_PATH:-}"
    echo "LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:${LD_LIBRARY_PATH:-}"
  } >> "$GITHUB_ENV"
fi
