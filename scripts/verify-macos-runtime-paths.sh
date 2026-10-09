#!/usr/bin/env bash
# Read-only gate: signing alone does not make external/bottle load paths valid.
set -euo pipefail
app="${1:?Usage: verify-macos-runtime-paths.sh <Taomni.app>}"
main="$app/Contents/MacOS/taomni"
frameworks="$app/Contents/Frameworks"
test -f "$main"
load_commands="$(otool -l "$main")"
grep -Fq 'path @executable_path/../Frameworks (' <<<"$load_commands" || {
  echo "Missing bundled Frameworks rpath: $main" >&2
  exit 1
}
for binary in "$main" "$frameworks/"*.dylib; do
  test -f "$binary" || { echo "Missing bundled dylib: $binary" >&2; exit 1; }
  dependencies="$(otool -L "$binary")"
  while IFS= read -r dependency; do
    case "$dependency" in
      /System/Library/*|/usr/lib/*) continue ;;
      @rpath/*) resolved="$frameworks/${dependency#@rpath/}" ;;
      @loader_path/*) resolved="$(dirname "$binary")/${dependency#@loader_path/}" ;;
      @executable_path/*) resolved="$(dirname "$main")/${dependency#@executable_path/}" ;;
      *) echo "Unbundled runtime dependency in $binary: $dependency" >&2; exit 1 ;;
    esac
    test -f "$resolved" || {
      echo "Missing runtime dependency in $binary: $dependency ($resolved)" >&2
      exit 1
    }
  done < <(printf '%s\n' "$dependencies" | tail -n +2 | awk '{print $1}')
done
echo "Verified macOS runtime paths: $app"
