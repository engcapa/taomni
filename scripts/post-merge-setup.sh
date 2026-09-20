#!/usr/bin/env bash
set -euo pipefail

# Keep task merges reproducible without starting the application or triggering
# the long native QA build. The post-merge runner invokes this script from the
# repository root with stdin closed.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f pnpm-lock.yaml ]]; then
  pnpm install --frozen-lockfile --prefer-offline
fi

echo "[post-merge] dependency setup complete"