"""Provision and compile isolated Maven and Gradle projects targeting Java 25."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from ci_maven_warmup import transient_failure, with_forced_update, with_maven_options

BUILD_ATTEMPTS = 3
BUILD_RETRY_DELAYS = (5.0, 15.0)
BUILD_BUDGET_SECONDS = 300.0
BUILD_ATTEMPT_TIMEOUT_SECONDS = 240.0


def _output_text(value: str | bytes | None) -> str:
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value or ""


MAVEN_POM = """\
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>taomni-java25-maven</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>25</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
"""

APP_JAVA = """\
package com.example.app;

public class App {
    public static void main(String[] args) {
        int value = 40;
        value += 2;
        System.out.println("debug-value=" + value);
    }

    static void completionTargets() {

    }
}
"""

HELPER_JAVA = """\
package com.example.other;

public final class Helper {
    private Helper() {}

    public static int answer() {
        return 42;
    }
}
// PERF:
"""

GRADLE_SETTINGS = "rootProject.name = 'taomni-java25-gradle'\n"
GRADLE_BUILD = """\
plugins {
    id 'java'
}

java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
}
"""

GRADLE_APP_JAVA = """\
package org.example.gradle;

public class GradleApp {
    public static void main(String[] args) {
        System.out.println("gradle-java25");
    }
}
"""


def _write(root: Path, relative: str, content: str) -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def _gradle_binary() -> str | None:
    direct = shutil.which("gradle")
    if direct:
        return direct
    candidates = sorted(
        (Path.home() / ".gradle/wrapper/dists").glob("gradle-*-bin/*/gradle-*/bin/gradle"),
        reverse=True,
    )
    return str(candidates[0]) if candidates else None


def _run_build(command: list[str], root: Path, *,
               budget_seconds: float = BUILD_BUDGET_SECONDS,
               attempt_timeout: float = BUILD_ATTEMPT_TIMEOUT_SECONDS,
               attempts: int = BUILD_ATTEMPTS) -> dict[str, Any]:
    """Build one Java fixture, retrying only transient repository failures.

    Hosted Maven Central rate-limits shared runner egress (HTTP 429), and the
    Java 25 warmup builds run online. A transient download failure is retried
    with backoff inside one bounded budget so it cannot be mistaken for a
    product/build failure; compile errors and other permanent failures stay
    fatal on the first attempt. Maven commands also carry the retry handler
    options so the transporter itself absorbs shorter spikes.
    """
    build_env = {**os.environ, "CI": "true"}
    jdk25_candidate = Path(os.environ.get("JAVA25_HOME", os.environ.get("JAVA_HOME", "")))
    if str(jdk25_candidate) != "." and jdk25_candidate.is_dir():
        build_env["JAVA_HOME"] = str(jdk25_candidate)
        build_env["PATH"] = f"{jdk25_candidate / 'bin'}{os.pathsep}{build_env.get('PATH', '')}"
    base_argv = with_maven_options(command)
    deadline = time.monotonic() + budget_seconds
    retries: list[dict[str, Any]] = []
    for attempt in range(1, attempts + 1):
        argv = with_forced_update(base_argv) if attempt > 1 else list(base_argv)
        if os.name == "nt" and Path(command[0]).suffix.lower() in {".bat", ".cmd"}:
            argv = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c",
                    subprocess.list2cmdline(argv)]
        remaining = deadline - time.monotonic()
        timeout = min(attempt_timeout, remaining) if remaining > 1.0 else 1.0
        transient = False
        timed_out = False
        try:
            started = subprocess.run(
                argv,
                cwd=root,
                env=build_env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
            returncode = started.returncode
            stdout, stderr = started.stdout, started.stderr
            output = stdout + "\n" + stderr
            transient = returncode != 0 and transient_failure(output)
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            returncode = None
            stdout = _output_text(exc.stdout)
            stderr = _output_text(exc.stderr)
            output = stdout + "\n" + stderr
            transient = True
        if returncode == 0:
            return {
                "command": argv,
                "cwd": str(root),
                "exitCode": 0,
                "stdoutTail": stdout[-4000:],
                "stderrTail": stderr[-4000:],
                "attempts": attempt,
                "retries": retries,
            }
        failure = RuntimeError(
            f"Java 25 fixture build failed ({' '.join(command)}): "
            f"{stderr[-1000:] or stdout[-1000:]}"
            + (f" (timed out after {timeout:g}s)" if timed_out else "")
            + (f"; attempts={attempt}" if attempt > 1 else "")
        )
        delay = BUILD_RETRY_DELAYS[attempt - 1] if attempt <= len(BUILD_RETRY_DELAYS) else 0.0
        if attempt >= attempts or not transient or deadline - time.monotonic() <= delay:
            raise failure
        retries.append({"attempt": attempt, "timedOut": timed_out,
                        "exitCode": returncode, "tail": output[-2000:]})
        print(f"Java fixture build hit a transient repository failure; retry "
              f"{attempt + 1}/{attempts} in {delay:g}s", flush=True)
        time.sleep(delay)
    raise AssertionError("unreachable")


def _jdtls_process_count() -> int:
    count = 0
    proc = Path("/proc")
    if not proc.is_dir():
        return 0
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        if "org.eclipse.jdt.ls.core.id1" in command:
            count += 1
    return count


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    if (cfg.get("app") or {}).get("mode", "browser") != "native":
        raise FixtureSkip("java25_projects requires the native host filesystem")
    mvn = shutil.which("mvn")
    gradle = _gradle_binary()
    if not mvn or not gradle:
        raise FixtureSkip("Java 25 Maven/Gradle tooling is not available on this host")

    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    parent = Path(tempfile.mkdtemp(prefix=f"{case_id}-w{worker}-java25-", dir=str(base)))
    maven_root = parent / "maven-java25"
    gradle_root = parent / "gradle-java25"

    _write(maven_root, "pom.xml", MAVEN_POM)
    _write(maven_root, "src/main/java/com/example/app/App.java", APP_JAVA)
    _write(maven_root, "src/main/java/com/example/other/Helper.java", HELPER_JAVA)
    _write(gradle_root, "settings.gradle", GRADLE_SETTINGS)
    _write(gradle_root, "build.gradle", GRADLE_BUILD)
    _write(gradle_root, "src/main/java/org/example/gradle/GradleApp.java", GRADLE_APP_JAVA)

    receipts = [
        _run_build([mvn, "-q", "-o", "-DskipTests", "package"], maven_root),
        _run_build([gradle, "--offline", "--no-daemon", "clean", "build"], gradle_root),
    ]
    case_dir = Path(getattr(ctx, "case_dir", report_root))
    (case_dir / "java25-build-receipt.json").write_text(
        json.dumps(receipts, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    values: dict[str, str] = getattr(ctx, "values")
    values.update({
        # These values are interpolated into JSON localStorage payloads and
        # CSS selectors. Slash-separated absolute paths work on Windows and
        # POSIX while remaining valid host paths for native assertions.
        "java25_maven_root": maven_root.as_posix(),
        "java25_gradle_root": gradle_root.as_posix(),
        "java25_maven_app": (maven_root / "src/main/java/com/example/app/App.java").as_posix(),
        "java25_maven_helper": (maven_root / "src/main/java/com/example/other/Helper.java").as_posix(),
        "jdtls_process_count_before": str(_jdtls_process_count()),
    })
