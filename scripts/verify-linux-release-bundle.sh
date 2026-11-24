#!/usr/bin/env bash
set -euo pipefail
bundle="${1:-src-tauri/target/release/bundle}"
shopt -s nullglob
deb=("$bundle"/deb/*.deb)
rpm=("$bundle"/rpm/*.rpm)
image=("$bundle"/appimage/*.AppImage)
if (( ${#deb[@]} != 1 || ${#rpm[@]} != 1 || ${#image[@]} != 1 )); then
  echo "Expected one Debian, RPM and AppImage package in $bundle" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
dpkg-deb --fsys-tarfile "${deb[0]}" | tar -tf - > "$work/deb.files"
rpm -qpl "${rpm[0]}" > "$work/rpm.files"
image_path="$(realpath "${image[0]}")"
(cd "$work" && "$image_path" --appimage-extract > /dev/null)
find "$work/squashfs-root" -printf '%P\n' > "$work/appimage.files"

for format in deb rpm appimage; do
  files="$work/$format.files"
  if ! grep -Eq '(^|/)usr/bin/taomni$' "$files"; then
    echo "The $format package is missing usr/bin/taomni" >&2
    exit 1
  fi
  if grep -E '(^|/)acp-fake-agent$' "$files"; then
    echo "The $format package contains the ACP integration test fixture" >&2
    exit 1
  fi
  if grep -E '(^|/)xray$' "$files"; then
    echo "The $format core package contains SocksCap's Xray executable" >&2
    exit 1
  fi
  if grep -E '(^|/)taomni-sockscap-trace-launcher$' "$files"; then
    echo "The $format core package contains the SocksCap module trace launcher" >&2
    exit 1
  fi
  echo "Verified $format core installer contents"
done
