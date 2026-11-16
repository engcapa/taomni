#!/usr/bin/env bash
# QA-only package acquisition. Source this file; it never provisions on import.

prepare_apt_mirrors() {
  local profile="$1"
  local apt_dir="${2:-/etc/apt}"
  # Hosted Ubuntu prefers Azure's HTTP mirror. Runs 39761535452 and
  # 39794915674 stalled on Jammy and Resolute. Replace job-owned mirror lists;
  # retain distribution suites, signatures and package version selection.
  if [[ "${GITHUB_ACTIONS:-}" == true && "$profile" == ubuntu-* ]]; then
    local mirror archive
    for mirror in "$apt_dir/apt-mirrors.txt" "$apt_dir/apt-mirrors-security.txt"; do
      if [[ -f "$mirror" ]]; then
        archive=https://archive.ubuntu.com/ubuntu/
        if [[ "$mirror" == *security* ]]; then archive=https://security.ubuntu.com/ubuntu/; fi
        echo "$archive" | sudo tee "$mirror"
      fi
    done
  fi
}

configure_playwright_platform() {
  local profile="$1"
  if [[ "$profile" == ubuntu-26.04-wayland ]]; then
    # Playwright 1.55 has no Resolute dependency manifest. Use its Noble
    # Chromium build and dependency list on this newer x64 Ubuntu runner.
    # The QA desktop/profile identity remains Ubuntu 26.04 Wayland.
    export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64
    if [[ -n "${GITHUB_ENV:-}" ]]; then
      echo "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=$PLAYWRIGHT_HOST_PLATFORM_OVERRIDE" >> "$GITHUB_ENV"
    fi
  fi
}

update_package_index() {
  sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update
}

install_packages() {
  local install_status
  if _install_packages_once "$@"; then return 0; else install_status=$?; fi
  if [[ "$install_status" != 100 ]]; then return "$install_status"; fi
  # A hosted image or a mirror publication race can leave an index pointing
  # at removed .deb versions. Refresh once and retain the exact package set;
  # a second failure still blocks the job.
  echo 'Package installation failed; refreshing indexes once before retry.' >&2
  update_package_index || return
  _install_packages_once "$@"
}

_install_packages_once() {
  # The fixtures explicitly declare their desktop/IME/audio packages. Suggested
  # applications (Qt WebEngine, modem services, display managers) are unrelated.
  sudo env DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 \
    install -y --no-install-recommends "$@"
}
