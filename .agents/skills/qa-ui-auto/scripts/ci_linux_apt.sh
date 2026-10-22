#!/usr/bin/env bash
# QA-only package acquisition. Source this file; it never provisions on import.

prepare_apt_mirrors() {
  local profile="$1"
  local apt_dir="${2:-/etc/apt}"
  # Hosted Jammy prefers Azure's HTTP mirror. In run 39761535452 repeated
  # 30-second stalls exhausted setup. Only replace these job-owned mirror lists;
  # retain distribution suites, signatures and package version selection.
  if [[ "${GITHUB_ACTIONS:-}" == true && "$profile" == ubuntu-22.04-* ]]; then
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

update_package_index() {
  sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update
}

install_packages() {
  # The fixtures explicitly declare their desktop/IME/audio packages. Suggested
  # applications (Qt WebEngine, modem services, display managers) are unrelated.
  sudo env DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 \
    install -y --no-install-recommends "$@"
}
