#!/usr/bin/env bash
set -e

XVNC=/nix/store/637s9kv349cmj1y32phgk1fyvzgzyg8m-tigervnc-1.14.0/bin/Xvnc
FLUX=/nix/store/lpfb8091nli2k4riip5wg2k0x4cdz6wv-fluxbox/bin/fluxbox
WEBSOCKIFY=/nix/store/031kfpijr04xpfkps46n3qhqinapw5bi-python3.11-websockify-0.12.0/bin/websockify

if [ ! -x "$XVNC" ]; then
  XVNC=$(ls -d /nix/store/*tigervnc*/bin/Xvnc 2>/dev/null | head -1)
fi
if [ ! -x "$FLUX" ]; then
  FLUX=$(ls -d /nix/store/*fluxbox*/bin/fluxbox 2>/dev/null | head -1)
fi
if [ ! -x "$WEBSOCKIFY" ]; then
  WEBSOCKIFY=$(ls -d /nix/store/*websockify*/bin/websockify 2>/dev/null | head -1)
fi

echo "Xvnc:        $XVNC"
echo "fluxbox:     $FLUX"
echo "websockify:  $WEBSOCKIFY"

# Clean up any stale instances from a previous run
pkill -f "Xvnc :0" 2>/dev/null || true
pkill -f fluxbox 2>/dev/null || true
pkill -f "websockify.*5900" 2>/dev/null || true
pkill -x newmob 2>/dev/null || true
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0 2>/dev/null || true
sleep 1

XVNC_PID=""
FLUX_PID=""
WS_PID=""
APP_PID=""

cleanup() {
  trap - INT TERM EXIT
  echo "Shutting down VNC stack…"
  for pid in "$APP_PID" "$WS_PID" "$FLUX_PID" "$XVNC_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
  for pid in "$APP_PID" "$WS_PID" "$FLUX_PID" "$XVNC_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  rm -f /tmp/.X0-lock 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Xvnc on internal RFB port 5901; websockify exposes WebSocket on 5900
"$XVNC" :0 -geometry 1280x800 -depth 24 -SecurityTypes None -rfbport 5901 \
  -localhost=1 -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents &
XVNC_PID=$!

sleep 2

DISPLAY=:0 "$FLUX" &
FLUX_PID=$!

"$WEBSOCKIFY" --heartbeat=30 0.0.0.0:5900 127.0.0.1:5901 &
WS_PID=$!

echo "Xvnc PID=$XVNC_PID  fluxbox PID=$FLUX_PID  websockify PID=$WS_PID"
echo "VNC ready: WebSocket on 0.0.0.0:5900  →  RFB 127.0.0.1:5901"

# Launch the Tauri debug binary if it already exists
APP=src-tauri/target/debug/newmob
if [ -x "$APP" ]; then
  echo "Launching $APP"
  DISPLAY=:0 "$APP" &
  APP_PID=$!
  echo "newmob PID=$APP_PID"
fi

wait $XVNC_PID
