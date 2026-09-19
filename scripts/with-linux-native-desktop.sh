#!/usr/bin/env bash
set -euo pipefail

# Run a command in the opt-in Linux desktop session used by native QA.
#
# The wrapper is intentionally a no-op unless TAOMNI_NATIVE_QA_DESKTOP=1.
# That keeps developer machines with their own X11/Wayland session unchanged,
# while the Replit .replit configuration can provide a reproducible display.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${TAOMNI_NATIVE_QA_DESKTOP:-0}" != "1" || "$(uname -s)" != "Linux" ]]; then
  exec "$@"
fi

if [[ "$#" -eq 0 ]]; then
  echo "usage: $0 command [args...]" >&2
  exit 2
fi

command -v Xvfb >/dev/null 2>&1 || {
  echo "native desktop: Xvfb is required when TAOMNI_NATIVE_QA_DESKTOP=1" >&2
  exit 2
}
command -v xwininfo >/dev/null 2>&1 || {
  echo "native desktop: xwininfo is required when TAOMNI_NATIVE_QA_DESKTOP=1" >&2
  exit 2
}

DISPLAY="${DISPLAY:-${TAOMNI_NATIVE_QA_DISPLAY:-:99}}"
export DISPLAY
GEOMETRY="${TAOMNI_NATIVE_QA_GEOMETRY:-1920x1080x24}"
STATE_ROOT="${TAOMNI_NATIVE_QA_STATE_ROOT:-$ROOT/.local/state/taomni-native-qa}"
LOG_ROOT="$STATE_ROOT/logs"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$STATE_ROOT/config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$STATE_ROOT/cache}"
if [[ -z "${XDG_RUNTIME_DIR:-}" || ! -d "$XDG_RUNTIME_DIR" || ! -w "$XDG_RUNTIME_DIR" ]]; then
  export XDG_RUNTIME_DIR="$STATE_ROOT/runtime"
fi
mkdir -p "$LOG_ROOT" "$XDG_CONFIG_HOME/fcitx5" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Give fcitx5 a deterministic disposable profile. The wbpy engine is provided
# by fcitx5-chinese-addons in the Replit Nix environment. native_ime_keys also
# selects it explicitly, but listing it here makes the session usable before
# the first IME action.
FCITX_PROFILE="$XDG_CONFIG_HOME/fcitx5/profile"
if [[ ! -s "$FCITX_PROFILE" ]]; then
  cat > "$FCITX_PROFILE" <<'EOF'
[Groups/0]
Name=Default
Default Layout=us
DefaultIM=keyboard-us

[Groups/0/Items/0]
Name=keyboard-us

[Groups/0/Items/1]
Name=wbpy
EOF
fi

x_server_pid=""
wm_pid=""

cleanup_display() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$wm_pid" ]] && kill -0 "$wm_pid" 2>/dev/null; then
    kill "$wm_pid" 2>/dev/null || true
    wait "$wm_pid" 2>/dev/null || true
  fi
  if [[ -n "$x_server_pid" ]] && kill -0 "$x_server_pid" 2>/dev/null; then
    kill "$x_server_pid" 2>/dev/null || true
    wait "$x_server_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup_display EXIT INT TERM

if ! xwininfo -root -display "$DISPLAY" >/dev/null 2>&1; then
  echo "[native-desktop] Starting Xvfb on $DISPLAY ($GEOMETRY)"
  Xvfb "$DISPLAY" \
    -screen 0 "$GEOMETRY" \
    -nolisten tcp \
    -ac \
    +extension RANDR \
    >"$LOG_ROOT/xvfb.log" 2>&1 &
  x_server_pid=$!

  for _ in $(seq 1 100); do
    if xwininfo -root -display "$DISPLAY" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$x_server_pid" 2>/dev/null; then
      echo "native desktop: Xvfb exited; see $LOG_ROOT/xvfb.log" >&2
      exit 1
    fi
    sleep 0.1
  done

  if ! xwininfo -root -display "$DISPLAY" >/dev/null 2>&1; then
    echo "native desktop: Xvfb did not become ready on $DISPLAY" >&2
    exit 1
  fi

  if command -v fluxbox >/dev/null 2>&1; then
    fluxbox -display "$DISPLAY" >"$LOG_ROOT/fluxbox.log" 2>&1 &
    wm_pid=$!
  fi
else
  echo "[native-desktop] Reusing existing display $DISPLAY"
fi

run_without_ime() {
  "$@"
}

run_with_ime() {
  local display="$1"
  shift
  local dbus_config="${TAOMNI_DBUS_SESSION_CONFIG:-}"
  local dbus_prefix=""
  local candidate=""
  local -a dbus_args=()
  export DISPLAY="$display"
  export XMODIFIERS="@im=fcitx"
  export GTK_IM_MODULE="fcitx"
  export QT_IM_MODULE="fcitx"

  if ! command -v dbus-run-session >/dev/null 2>&1; then
    echo "native desktop: dbus-run-session is required for FCITX5" >&2
    return 2
  fi

  # Nix ships the usable session configuration under share/. Its etc/
  # session.conf is only a compatibility placeholder and has no <listen>
  # element, while dbus-run-session still tries /etc by default.
  if [[ -z "$dbus_config" ]]; then
    dbus_prefix="$(dirname "$(dirname "$(command -v dbus-run-session)")")"
    for candidate in \
      "$dbus_prefix/share/dbus-1/session.conf" \
      "$dbus_prefix/etc/dbus-1/session.conf"; do
      if [[ -s "$candidate" ]] && grep -q "<listen>" "$candidate"; then
        dbus_config="$candidate"
        break
      fi
    done
  fi
  if [[ -n "$dbus_config" ]]; then
    dbus_args+=(--config-file="$dbus_config")
  fi

  dbus-run-session "${dbus_args[@]}" -- bash -c '
    set -u
    display="$1"
    shift
    export DISPLAY="$display"
    export XMODIFIERS="@im=fcitx"
    export GTK_IM_MODULE="fcitx"
    export QT_IM_MODULE="fcitx"

    fcitx_pid=""
    cleanup_fcitx() {
      local status=$?
      trap - EXIT INT TERM
      if [[ -n "$fcitx_pid" ]] && kill -0 "$fcitx_pid" 2>/dev/null; then
        kill "$fcitx_pid" 2>/dev/null || true
        wait "$fcitx_pid" 2>/dev/null || true
      fi
      exit "$status"
    }
    trap cleanup_fcitx EXIT INT TERM

    if command -v fcitx5 >/dev/null 2>&1; then
      fcitx5 -D --replace >"${XDG_CACHE_HOME:-/tmp}/fcitx5.log" 2>&1 &
      fcitx_pid=$!
      sleep 0.3
      if ! kill -0 "$fcitx_pid" 2>/dev/null; then
        echo "native desktop: fcitx5 exited during startup" >&2
        exit 1
      fi
    else
      echo "native desktop: fcitx5 is required for the configured QA session" >&2
      exit 2
    fi

    "$@"
  ' taomni-native-qa "$display" "$@"
}

if [[ "${TAOMNI_NATIVE_QA_IME:-1}" == "1" ]]; then
  run_with_ime "$DISPLAY" "$@"
else
  run_without_ime "$@"
fi