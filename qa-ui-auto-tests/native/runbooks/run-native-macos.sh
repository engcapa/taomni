#!/usr/bin/env bash
# R9 native gate — macOS runbook (§8.19.10).
#
# macOS has no upstream Tauri WebDriver adapter, so the QA debug binary starts
# an opt-in WKWebView bridge on a run-owned loopback port. This exercises the
# packaged WebView/IPC path. OS-global input, dialogs, permissions and IME still
# need separate OS automation/manual evidence.
set -euo pipefail
cd "$(dirname "$0")/../../.."

qa_python="${TAOMNI_QA_PYTHON:-}"
if [ -z "$qa_python" ]; then
  qa_data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  persistent_qa_python="$qa_data_home/taomni/qa-ui-auto-venv/bin/python"
  if [ -x "$persistent_qa_python" ]; then
    qa_python="$persistent_qa_python"
  else
    qa_python="$(command -v python3 || true)"
  fi
fi
if [ -z "$qa_python" ] || [ ! -x "$qa_python" ]; then
  echo "Python 3.10+ with qa-ui-auto dependencies is required; set TAOMNI_QA_PYTHON" >&2
  exit 2
fi
"$qa_python" -c 'import sys, yaml, jsonschema; raise SystemExit(0 if sys.version_info >= (3, 10) else "Python 3.10+ is required")'

native_java_home="${TAOMNI_NATIVE_JAVA_HOME:-}"
if [ -z "$native_java_home" ]; then
  native_java_home="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
fi
if [ -z "$native_java_home" ]; then
  openjdk_prefix="$(brew --prefix openjdk@21 2>/dev/null || true)"
  homebrew_java_home="$openjdk_prefix/libexec/openjdk.jdk/Contents/Home"
  if [ -x "$homebrew_java_home/bin/java" ]; then
    native_java_home="$homebrew_java_home"
  fi
fi
if [ -n "$native_java_home" ]; then
  export JAVA_HOME="$native_java_home"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# The fixture runners intentionally reject their old Linux default paths. A
# runbook invocation should be self-contained, while still allowing CI or a
# developer to pin a different provider installation explicitly.
if [ -z "${TAOMNI_FIXTURE_JAVA:-}" ]; then
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    export TAOMNI_FIXTURE_JAVA="$JAVA_HOME/bin/java"
  else
    export TAOMNI_FIXTURE_JAVA="$(command -v java || true)"
  fi
fi
if ! command -v jdtls >/dev/null 2>&1; then
  echo "jdtls is required for Java native cases (install with: brew install jdtls)" >&2
  exit 2
fi
if [ -z "${JDTLS_HOME:-}" ]; then
  jdtls_prefix="$(brew --prefix jdtls 2>/dev/null || true)"
  JDTLS_HOME="$jdtls_prefix/libexec"
  if [ -n "$jdtls_prefix" ] && [ -d "$JDTLS_HOME/plugins" ]; then
    export JDTLS_HOME
  else
    unset JDTLS_HOME
  fi
fi
if ! command -v mvn >/dev/null 2>&1; then
  echo "Maven is required for Java native cases (install with: brew install maven)" >&2
  exit 2
fi
if ! command -v gradle >/dev/null 2>&1; then
  echo "Gradle is required for Java native cases (install with: brew install gradle)" >&2
  exit 2
fi
if [ -z "${TAOMNI_FIXTURE_GRADLE:-}" ]; then
  fixture_gradle_home="$(brew --prefix gradle 2>/dev/null || true)"
  if [ -n "$fixture_gradle_home" ] && [ -x "$fixture_gradle_home/bin/gradle" ]; then
    export TAOMNI_FIXTURE_GRADLE="$fixture_gradle_home"
  fi
fi

echo "== [1/3] Java/LSP toolchain =="
echo "JAVA_HOME=${JAVA_HOME:-<unset>}"
echo "TAOMNI_FIXTURE_JAVA=$TAOMNI_FIXTURE_JAVA"
echo "JDTLS_HOME=${JDTLS_HOME:-<auto>}"
echo "TAOMNI_FIXTURE_GRADLE=${TAOMNI_FIXTURE_GRADLE:-<auto>}"
JAVA_MAJOR="$(java -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p' | head -1)"
if [ -z "$JAVA_MAJOR" ] || [ "$JAVA_MAJOR" -lt 21 ]; then
  echo "JDK 21+ is required for jdtls (found Java ${JAVA_MAJOR:-unknown})" >&2
  exit 2
fi
java -version 2>&1 | head -1
echo "jdtls=$(command -v jdtls)"
jdtls --help >/dev/null
echo "maven=$(mvn -version 2>&1 | head -1)"
echo "gradle=$(gradle --version 2>&1 | sed -n '/^Gradle /{p;q;}')"

echo "== [2/3] build packaged debug app =="
"$qa_python" .agents/skills/qa-ui-auto/scripts/native_build.py

echo "== [3/3] run isolated macOS native cases =="
export PYTHONPATH=".agents/skills/qa-ui-auto/scripts${PYTHONPATH:+:$PYTHONPATH}"
REPORT_DIR="${QA_UI_AUTO_REPORT_DIR:-qa-ui-auto-report/native-macos}"
"$qa_python" -m qa_ui_auto run \
  --mode native \
  --config qa-ui-auto-tests/qa-ui-auto.config.yaml \
  --report-dir "$REPORT_DIR" \
  --keep-runs 0 \
  "$@"

cat <<'EOF'

The automated report covers the packaged WKWebView/IPC path. Record separate
OS-global evidence (Cmd/Meta, IME, permissions, dialogs, clipboard ownership,
window controls) with evidence_collect.py when those boundaries are in scope.
Use only the com.taomni.app.qa build, QA-owned data/config/cache and disposable
workspaces; never launch the production app or redirect HOME.
EOF
