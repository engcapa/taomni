#!/bin/sh
# Fail closed on upgrade/removal. Maintainer scripts do not guess how to
# recover a generation: the running product/helper must first prove cleanup.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  echo "Taomni Sockscap package operation refused: $*" >&2
  echo "Stop Sockscap and complete recovery before retrying." >&2
  exit 1
}

runtime_dir=/run/taomni
lifecycle_lock=$runtime_dir/sockscap-lifecycle.lock
package_sentinel=$runtime_dir/sockscap-package-operation
temporary_sentinel=

cleanup() {
  if [ -n "$temporary_sentinel" ]; then
    rm -f -- "$temporary_sentinel"
  fi
}
trap cleanup EXIT HUP INT TERM

transaction_token() {
  [ -r /proc/sys/kernel/random/boot_id ] \
    || fail "kernel boot identity is unavailable"
  boot_id=$(cat /proc/sys/kernel/random/boot_id) \
    || fail "kernel boot identity could not be read"
  echo "$boot_id" | grep -Eq '^[0-9a-fA-F-]{36}$' \
    || fail "kernel boot identity is malformed"

  parent_stat=$(cat "/proc/$PPID/stat" 2>/dev/null) \
    || fail "package-manager process identity is unavailable"
  # Strip pid and the parenthesized command. The original field 22 (starttime)
  # is field 20 in the remaining suffix, even when the command contains spaces.
  parent_fields=${parent_stat##*) }
  set -- $parent_fields
  [ "$#" -ge 20 ] || fail "package-manager process identity is malformed"
  parent_start=${20}
  echo "$parent_start" | grep -Eq '^[0-9]+$' \
    || fail "package-manager start time is malformed"
  printf 'v1 %s %s %s' "$boot_id" "$PPID" "$parent_start"
}

assert_runtime_directory() {
  [ ! -L "$runtime_dir" ] || fail "$runtime_dir is a symbolic link"
  [ -d "$runtime_dir" ] || fail "$runtime_dir is not a directory"
  metadata=$(stat -c '%u:%g:%a' "$runtime_dir" 2>/dev/null) \
    || fail "$runtime_dir metadata could not be audited"
  [ "$metadata" = '0:0:755' ] \
    || fail "$runtime_dir must be root:root with mode 0755"
}

assert_control_file() {
  control_path=$1
  control_label=$2
  [ ! -L "$control_path" ] && [ -f "$control_path" ] \
    || fail "$control_label is not a regular non-symlink file"
  metadata=$(stat -c '%u:%g:%a' "$control_path" 2>/dev/null) \
    || fail "$control_label metadata could not be audited"
  [ "$metadata" = '0:0:600' ] \
    || fail "$control_label must be root:root with mode 0600"
  [ "$(stat -c '%h' "$control_path" 2>/dev/null)" = '1' ] \
    || fail "$control_label must have exactly one hard link"
}

audit_runtime_entries() {
  # POSIX `*` excludes dotfiles. Audit all three disjoint glob classes so a
  # hidden or broken-symlink residue cannot bypass an upgrade/removal block.
  for entry in "$runtime_dir"/* "$runtime_dir"/.[!.]* "$runtime_dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    case "$name" in
      sockscap-lifecycle.lock)
        assert_control_file "$entry" "lifecycle lock"
        ;;
      sockscap-package-operation)
        assert_control_file "$entry" "package-operation sentinel"
        recorded_transaction=$(cat "$entry" 2>/dev/null) \
          || fail "package-operation sentinel could not be read"
        [ "$recorded_transaction" = "$current_transaction" ] \
          || fail "package-operation sentinel belongs to another transaction"
        ;;
      sockscap-cleaned-*-*.json)
        echo "$name" | grep -Eq '^sockscap-cleaned-[0-9]+-[0-9]+\.json$' \
          || fail "unexpected runtime entry $entry"
        [ ! -L "$entry" ] && [ -f "$entry" ] \
          || fail "unsafe cleaned tombstone $entry"
        metadata=$(stat -c '%u:%g:%a:%h' "$entry")
        [ "$metadata" = '0:0:600:1' ] \
          || fail "cleaned tombstone has unsafe ownership, mode, or link count: $entry"
        ;;
      *)
        fail "active or unrecognized runtime state remains at $entry"
        ;;
    esac
  done
}

if [ -L "$runtime_dir" ]; then
  fail "$runtime_dir is a symbolic link"
fi
if [ -e "$runtime_dir" ] && [ ! -d "$runtime_dir" ]; then
  fail "$runtime_dir exists but is not a directory"
fi
if [ ! -e "$runtime_dir" ]; then
  install -d -o root -g root -m 0755 "$runtime_dir" \
    || fail "$runtime_dir could not be created safely"
fi
assert_runtime_directory
runtime_identity=$(stat -c '%d:%i' "$runtime_dir") \
  || fail "$runtime_dir identity could not be audited"

command -v flock >/dev/null 2>&1 \
  || fail "flock is required for the package/helper lifecycle lock"
if [ ! -e "$lifecycle_lock" ] && [ ! -L "$lifecycle_lock" ]; then
  (umask 077; set -C; : >"$lifecycle_lock") 2>/dev/null || true
  if [ -f "$lifecycle_lock" ] && [ ! -L "$lifecycle_lock" ]; then
    chown root:root "$lifecycle_lock" \
      || fail "lifecycle lock ownership could not be initialized"
    chmod 0600 "$lifecycle_lock" \
      || fail "lifecycle lock mode could not be initialized"
  fi
fi
assert_control_file "$lifecycle_lock" "lifecycle lock"
exec 9<>"$lifecycle_lock" \
  || fail "lifecycle lock could not be opened"
lock_path_identity=$(stat -c '%d:%i' "$lifecycle_lock") \
  || fail "lifecycle lock path could not be audited"
lock_fd_identity=$(stat -Lc '%d:%i' /proc/self/fd/9) \
  || fail "lifecycle lock descriptor could not be audited"
[ "$lock_path_identity" = "$lock_fd_identity" ] \
  || fail "lifecycle lock changed while it was opened"
flock -n -x 9 \
  || fail "Sockscap helper is active or another package operation holds the lifecycle lock"

assert_runtime_directory
[ "$(stat -c '%d:%i' "$runtime_dir")" = "$runtime_identity" ] \
  || fail "$runtime_dir changed before cleanup auditing"
current_transaction=$(transaction_token)
if [ -e "$package_sentinel" ] || [ -L "$package_sentinel" ]; then
  assert_control_file "$package_sentinel" "package-operation sentinel"
  recorded_transaction=$(cat "$package_sentinel" 2>/dev/null) \
    || fail "package-operation sentinel could not be read"
  [ "$recorded_transaction" = "$current_transaction" ] \
    || fail "an incomplete package operation requires explicit recovery"
fi

audit_runtime_entries

if [ -e /sys/fs/cgroup/taomni.sockscap ]; then
  fail "Sockscap cgroup state remains"
fi

if command -v nft >/dev/null 2>&1; then
  if ! nft_tables=$(nft list tables 2>&1); then
    fail "nftables state could not be audited: $nft_tables"
  fi
  if printf '%s\n' "$nft_tables" | grep -Eq '^table inet taomni_sc_g[0-9]+$'; then
    fail "Sockscap nftables state remains"
  fi
elif [ -e /usr/libexec/taomni/sockscap-helper ]; then
  fail "nft is unavailable, so an existing installation cannot be audited"
fi

if command -v ip >/dev/null 2>&1; then
  if ! link_state=$(ip -o link show 2>&1); then
    fail "network-interface state could not be audited: $link_state"
  fi
  if printf '%s\n' "$link_state" \
    | grep -Eq '^[0-9]+: ts[0-9a-z]+(@[^:]+)?:'; then
    fail "Sockscap TUN state remains"
  fi

  if ! ipv4_rules=$(ip -o -4 rule show 2>&1); then
    fail "IPv4 policy rules could not be audited: $ipv4_rules"
  fi
  if printf '%s\n' "$ipv4_rules" \
    | grep -Eq '^12[0-9]{3}:.*fwmark 0x544[0-9a-f]+.*lookup 42[0-9]{3}([[:space:]]|$)'; then
    fail "Sockscap IPv4 policy-routing state remains"
  fi

  if ! ipv6_rules=$(ip -o -6 rule show 2>&1); then
    fail "IPv6 policy rules could not be audited: $ipv6_rules"
  fi
  if printf '%s\n' "$ipv6_rules" \
    | grep -Eq '^12[0-9]{3}:.*fwmark 0x544[0-9a-f]+.*lookup 42[0-9]{3}([[:space:]]|$)'; then
    fail "Sockscap IPv6 policy-routing state remains"
  fi

  # Generation slots reserve route tables 42000-42999. A rule can disappear
  # while its table still contains a black-hole route, so audit both families.
  if ! ipv4_routes=$(ip -o -4 route show table all 2>&1); then
    fail "IPv4 route tables could not be audited: $ipv4_routes"
  fi
  if printf '%s\n' "$ipv4_routes" \
    | grep -Eq '(^|[[:space:]])table 42[0-9]{3}([[:space:]]|$)'; then
    fail "Sockscap IPv4 route-table state remains"
  fi

  if ! ipv6_routes=$(ip -o -6 route show table all 2>&1); then
    fail "IPv6 route tables could not be audited: $ipv6_routes"
  fi
  if printf '%s\n' "$ipv6_routes" \
    | grep -Eq '(^|[[:space:]])table 42[0-9]{3}([[:space:]]|$)'; then
    fail "Sockscap IPv6 route-table state remains"
  fi
elif [ -e /usr/libexec/taomni/sockscap-helper ]; then
  fail "ip is unavailable, so an existing installation cannot be audited"
fi

assert_runtime_directory
[ "$(stat -c '%d:%i' "$runtime_dir")" = "$runtime_identity" ] \
  || fail "$runtime_dir changed while cleanup state was audited"
audit_runtime_entries

if [ ! -e "$package_sentinel" ] && [ ! -L "$package_sentinel" ]; then
  temporary_sentinel=$(mktemp "$runtime_dir/.sockscap-package-operation.XXXXXX") \
    || fail "package-operation sentinel could not be created"
  printf '%s\n' "$current_transaction" >"$temporary_sentinel" \
    || fail "package-operation sentinel could not be written"
  chown root:root "$temporary_sentinel" \
    || fail "package-operation sentinel ownership could not be set"
  chmod 0600 "$temporary_sentinel" \
    || fail "package-operation sentinel mode could not be set"
  mv -f -- "$temporary_sentinel" "$package_sentinel" \
    || fail "package-operation sentinel could not be published"
  temporary_sentinel=
fi
assert_control_file "$package_sentinel" "package-operation sentinel"
[ "$(cat "$package_sentinel" 2>/dev/null)" = "$current_transaction" ] \
  || fail "package-operation sentinel was replaced"

exit 0
