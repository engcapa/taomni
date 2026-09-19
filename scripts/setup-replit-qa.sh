#!/usr/bin/env bash
set -euo pipefail

# Replit entrypoint for the Taomni app. Keep QA-only language packages and
# downloaded browsers outside the repository, and make the setup idempotent so
# normal restarts reuse the existing tool cache.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source "$ROOT/scripts/setup-replit-native-qa.sh"

QA_TOOLS_ROOT="${TAOMNI_QA_TOOLS_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/taomni-qa-ui-auto}"
export PATH="$QA_TOOLS_ROOT/bin:$HOME/.cargo/bin:$PATH"
export PYTHONPATH="${PYTHONPATH:-$ROOT/.agents/skills/qa-ui-auto/scripts}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$QA_TOOLS_ROOT/playwright-browsers}"

mkdir -p "$QA_TOOLS_ROOT/bin" "$PLAYWRIGHT_BROWSERS_PATH"

if [[ ! -x "$ROOT/node_modules/.bin/vite" ]]; then
  echo "[replit-qa] Installing frontend dependencies"
  pnpm install --frozen-lockfile
fi

echo "[replit-qa] Ensuring Python QA dependencies"
python -m pip install \
  --disable-pip-version-check \
  --no-input \
  -r "$ROOT/qa-ui-auto-tests/requirements.txt"

echo "[replit-qa] Ensuring Playwright Chromium"
python -m playwright install chromium

if [[ ! -x "$QA_TOOLS_ROOT/bin/tauri-driver" && ! -x "$HOME/.cargo/bin/tauri-driver" ]]; then
  version="${TAOMNI_TAURI_DRIVER_VERSION:-2.0.6}"
  echo "[replit-qa] Installing tauri-driver ${version}"
  cargo install tauri-driver \
    --locked \
    --version "$version" \
    --root "$QA_TOOLS_ROOT"
fi

if [[ "${TAOMNI_QA_SETUP_ONLY:-0}" == "1" ]]; then
  echo "[replit-qa] Dependency setup complete"
  exit 0
fi

if [[ "${TAOMNI_NATIVE_QA_DESKTOP:-0}" == "1" && "$(uname -s)" == "Linux" ]]; then
  exec bash "$ROOT/scripts/with-linux-native-desktop.sh" pnpm dev
fi

exec pnpm dev
