#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  echo "Taomni Sockscap post-install refused: $*" >&2
  exit 1
}

runtime_dir=/run/taomni
lifecycle_lock=$runtime_dir/sockscap-lifecycle.lock
package_sentinel=$runtime_dir/sockscap-package-operation
application=/usr/bin/taomni
helper=/usr/libexec/taomni/sockscap-helper
helper_policy=/etc/taomni/sockscap-helper-policy.json
polkit_action=/usr/share/polkit-1/actions/com.taomni.sockscap.policy

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
  || fail "$runtime_dir changed before post-install validation"
assert_control_file "$package_sentinel" "package-operation sentinel"
current_transaction=$(transaction_token)
[ "$(cat "$package_sentinel" 2>/dev/null)" = "$current_transaction" ] \
  || fail "package-operation sentinel does not belong to this transaction"

for path in "$application" "$helper" "$helper_policy" "$polkit_action"; do
  [ -f "$path" ] && [ ! -L "$path" ] || {
    fail "package installed an unsafe or missing file: $path"
  }
  chown root:root "$path" || fail "cannot set root ownership on $path"
done
chmod 0755 "$application" "$helper" \
  || fail "cannot normalize installed executable modes"
chmod 0644 "$helper_policy" "$polkit_action" \
  || fail "cannot normalize installed policy modes"

assert_runtime_directory
[ "$(stat -c '%d:%i' "$runtime_dir")" = "$runtime_identity" ] \
  || fail "$runtime_dir changed during post-install validation"
assert_control_file "$package_sentinel" "package-operation sentinel"
[ "$(cat "$package_sentinel" 2>/dev/null)" = "$current_transaction" ] \
  || fail "package-operation sentinel changed during post-install"

# RPM calls the new package's %post with argument 2 during an upgrade, before
# the old package's %preun/%postun. Keep the sentinel until old %postun(1), so
# no helper can start in the middle of the transaction. Debian's successful
# postinst actions and RPM's first-install %post(1) are terminal.
case "${1:-}" in
  2)
    ;;
  configure|abort-upgrade|abort-remove|abort-deconfigure|1|"")
    unlink "$package_sentinel" \
      || fail "completed package-operation sentinel could not be cleared"
    ;;
  *)
    fail "unsupported package action $1"
    ;;
esac

exit 0
