#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  echo "Taomni Sockscap post-remove refused: $*" >&2
  exit 1
}

runtime_dir=/run/taomni
lifecycle_lock=$runtime_dir/sockscap-lifecycle.lock
package_sentinel=$runtime_dir/sockscap-package-operation

transaction_token() {
  [ -r /proc/sys/kernel/random/boot_id ] \
    || fail "kernel boot identity is unavailable"
  boot_id=$(cat /proc/sys/kernel/random/boot_id) \
    || fail "kernel boot identity could not be read"
  echo "$boot_id" | grep -Eq '^[0-9a-fA-F-]{36}$' \
    || fail "kernel boot identity is malformed"
  parent_stat=$(cat "/proc/$PPID/stat" 2>/dev/null) \
    || fail "package-manager process identity is unavailable"
  parent_fields=${parent_stat##*) }
  set -- $parent_fields
  [ "$#" -ge 20 ] || fail "package-manager process identity is malformed"
  parent_start=${20}
  echo "$parent_start" | grep -Eq '^[0-9]+$' \
    || fail "package-manager start time is malformed"
  printf 'v1 %s %s %s' "$boot_id" "$PPID" "$parent_start"
}

assert_runtime_directory() {
  [ ! -L "$runtime_dir" ] && [ -d "$runtime_dir" ] \
    || fail "$runtime_dir must be a real directory"
  [ "$(stat -c '%u:%g:%a' "$runtime_dir" 2>/dev/null)" = '0:0:755' ] \
    || fail "$runtime_dir must be root:root with mode 0755"
}

assert_control_file() {
  control_path=$1
  control_label=$2
  [ ! -L "$control_path" ] && [ -f "$control_path" ] \
    || fail "$control_label is not a regular non-symlink file"
  [ "$(stat -c '%u:%g:%a' "$control_path" 2>/dev/null)" = '0:0:600' ] \
    || fail "$control_label must be root:root with mode 0600"
  [ "$(stat -c '%h' "$control_path" 2>/dev/null)" = '1' ] \
    || fail "$control_label must have exactly one hard link"
}

# Debian can invoke `postrm purge` after an earlier successful `postrm remove`,
# including in a later dpkg transaction. The first call has already removed
# the sentinel and lifecycle lock. Treat that second call as idempotent only
# when no control file exists and the runtime directory is absent or contains
# nothing except immutable cleaned-generation evidence.
if [ "${1:-}" = purge ] \
  && [ ! -e "$package_sentinel" ] && [ ! -L "$package_sentinel" ] \
  && [ ! -e "$lifecycle_lock" ] && [ ! -L "$lifecycle_lock" ]; then
  if [ ! -e "$runtime_dir" ] && [ ! -L "$runtime_dir" ]; then
    exit 0
  fi
  assert_runtime_directory
  for entry in "$runtime_dir"/* "$runtime_dir"/.[!.]* "$runtime_dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    echo "$name" | grep -Eq '^sockscap-cleaned-[0-9]+-[0-9]+\.json$' \
      || fail "unexpected post-remove evidence $entry"
    [ ! -L "$entry" ] && [ -f "$entry" ] \
      || fail "unsafe cleaned tombstone $entry"
    [ "$(stat -c '%u:%g:%a:%h' "$entry" 2>/dev/null)" = '0:0:600:1' ] \
      || fail "cleaned tombstone has unsafe ownership, mode, or link count: $entry"
  done
  exit 0
fi

assert_runtime_directory
runtime_identity=$(stat -c '%d:%i' "$runtime_dir") \
  || fail "$runtime_dir identity could not be audited"
assert_control_file "$lifecycle_lock" "lifecycle lock"
command -v flock >/dev/null 2>&1 \
  || fail "flock is required for the package/helper lifecycle lock"
exec 9<>"$lifecycle_lock" || fail "lifecycle lock could not be opened"
[ "$(stat -c '%d:%i' "$lifecycle_lock")" = "$(stat -Lc '%d:%i' /proc/self/fd/9)" ] \
  || fail "lifecycle lock changed while it was opened"
flock -n -x 9 \
  || fail "Sockscap helper is active or another package operation holds the lifecycle lock"

assert_runtime_directory
[ "$(stat -c '%d:%i' "$runtime_dir")" = "$runtime_identity" ] \
  || fail "$runtime_dir changed before post-remove validation"
assert_control_file "$package_sentinel" "package-operation sentinel"
current_transaction=$(transaction_token)
[ "$(cat "$package_sentinel" 2>/dev/null)" = "$current_transaction" ] \
  || fail "package-operation sentinel does not belong to this transaction"

# Debian runs the old postrm before the new package's postinst. Preserve the
# sentinel across that gap. RPM supplies numeric scriptlet arguments and has
# no later new-package post script after old %postun, so numeric 1 is terminal.
case "${1:-}" in
  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear|"")
    exit 0
    ;;
  1)
    unlink "$package_sentinel" \
      || fail "completed RPM upgrade sentinel could not be cleared"
    ;;
  remove|purge|0)
    unlink "$package_sentinel" \
      || fail "completed removal sentinel could not be cleared"
    unlink "$lifecycle_lock" \
      || fail "lifecycle lock could not be removed after final uninstall"
    rmdir "$runtime_dir" 2>/dev/null || true
    ;;
  *)
    fail "unsupported package action $1"
    ;;
esac

exit 0
