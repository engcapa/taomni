#!/usr/bin/env python3
"""Fail-closed verification for Sockscap core and platform performance receipts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from typing import Any


SCHEMA_VERSION = 1
RULE_COUNT = 10_000
RULE_SAMPLES = 20_000
RULE_P99_THRESHOLD_NANOS = 100_000
START_STOP_CYCLES = 100
RELEASE_SOAK_SECONDS = 24 * 60 * 60
MAX_CORE_RSS_END_GROWTH = 32 * 1024 * 1024
MAX_CORE_RSS_PEAK_GROWTH = 64 * 1024 * 1024
MAX_CORE_OPEN_FILE_GROWTH = 4
MAX_HEARTBEAT_GAP_SECONDS = 10
MAX_RESOURCE_SAMPLE_GAP_SECONDS = 2
MAX_PLATFORM_RSS_GROWTH = 64 * 1024 * 1024
MAX_PLATFORM_OPEN_HANDLE_GROWTH = 8
MIN_CONNECT_SAMPLES = 100
MAX_CONNECT_OVERHEAD_MICROS = 10_000
MIN_THROUGHPUT_SAMPLE_SECONDS = 60
MIN_LINK_CAPACITY_MBPS = 1_000
MIN_THROUGHPUT_RATIO = 0.80
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")
PROVIDERS = {
    "windows": {"wfp", "windivert"},
    "macos": {"network_extension_transparent_proxy"},
    "linux": {"cgroup_v2_nft_tun"},
}
PLATFORM_NAMES = {
    "win32": "windows",
    "darwin": "macos",
    "linux": "linux",
}


class GateFailure(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def fail(code: str, detail: str) -> None:
    raise GateFailure(code, detail)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        fail("EVIDENCE_UNREADABLE", f"cannot read {path}: {error}")
    except json.JSONDecodeError as error:
        fail("EVIDENCE_JSON_INVALID", f"cannot parse {path}: {error}")
    if not isinstance(value, dict):
        fail("EVIDENCE_SHAPE_INVALID", f"{path} must contain a JSON object")
    return value


def mapping(parent: dict[str, Any], key: str, where: str) -> dict[str, Any]:
    value = parent.get(key)
    if not isinstance(value, dict):
        fail("EVIDENCE_SHAPE_INVALID", f"{where}.{key} must be an object")
    return value


def boolean(parent: dict[str, Any], key: str, where: str) -> bool:
    value = parent.get(key)
    if not isinstance(value, bool):
        fail("EVIDENCE_SHAPE_INVALID", f"{where}.{key} must be a boolean")
    return value


def integer(parent: dict[str, Any], key: str, where: str) -> int:
    value = parent.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        fail("EVIDENCE_SHAPE_INVALID", f"{where}.{key} must be an integer")
    return value


def number(parent: dict[str, Any], key: str, where: str) -> float:
    value = parent.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail("EVIDENCE_SHAPE_INVALID", f"{where}.{key} must be a number")
    result = float(value)
    if not math.isfinite(result):
        fail("EVIDENCE_SHAPE_INVALID", f"{where}.{key} must be finite")
    return result


def text(parent: dict[str, Any], key: str, where: str) -> str:
    value = parent.get(key)
    if not isinstance(value, str):
        fail("EVIDENCE_SHAPE_INVALID", f"{where}.{key} must be a string")
    return value


def require(condition: bool, code: str, detail: str) -> None:
    if not condition:
        fail(code, detail)


def verify_core_receipt(
    path: Path,
    *,
    min_duration_seconds: int = 0,
    expected_commit: str | None = None,
    expected_platform: str | None = None,
    expected_architecture: str | None = None,
) -> dict[str, Any]:
    root = load_json(path)
    require(
        integer(root, "schemaVersion", "receipt") == SCHEMA_VERSION,
        "CORE_SCHEMA_INVALID",
        "unsupported core receipt schema",
    )
    require(
        text(root, "gateKind", "receipt") == "sockscap_core_performance",
        "CORE_KIND_INVALID",
        "receipt is not a Sockscap core performance receipt",
    )
    require(
        text(root, "evidenceClass", "receipt") == "synthetic_core_no_host_capture",
        "CORE_CLASS_INVALID",
        "core receipt must explicitly identify synthetic/no-host-capture evidence",
    )
    require(
        boolean(root, "releaseEligible", "receipt") is False,
        "CORE_RELEASE_CLAIM_INVALID",
        "synthetic core evidence must never claim release eligibility",
    )
    require(
        boolean(root, "passed", "receipt"), "CORE_GATE_FAILED", "core receipt is red"
    )
    require(
        boolean(root, "optimizedBuild", "receipt"),
        "CORE_BUILD_PROFILE_INVALID",
        "performance evidence must come from an optimized build",
    )
    mode = text(root, "mode", "receipt")
    require(
        mode in {"quick", "soak"}, "CORE_MODE_INVALID", f"unknown core mode {mode!r}"
    )
    platform = text(root, "platform", "receipt")
    architecture = text(root, "architecture", "receipt")
    require(
        platform in PROVIDERS,
        "CORE_PLATFORM_INVALID",
        f"unsupported platform {platform!r}",
    )
    require(
        architecture in {"x86_64", "aarch64"},
        "CORE_ARCH_INVALID",
        f"unsupported architecture {architecture!r}",
    )
    if expected_platform is not None:
        require(
            platform == expected_platform,
            "CORE_PLATFORM_MISMATCH",
            f"core receipt platform {platform!r} != manifest {expected_platform!r}",
        )
    if expected_architecture is not None:
        require(
            architecture == expected_architecture,
            "CORE_ARCH_MISMATCH",
            f"core receipt architecture {architecture!r} != manifest {expected_architecture!r}",
        )
    commit = root.get("gitCommit")
    if expected_commit is not None:
        require(
            bool(COMMIT_RE.fullmatch(expected_commit)),
            "CORE_COMMIT_INVALID",
            "expected commit must be a full 40-character SHA",
        )
        require(
            isinstance(commit, str) and commit.lower() == expected_commit.lower(),
            "CORE_COMMIT_MISMATCH",
            "core receipt git commit does not match the expected commit",
        )

    started = integer(root, "startedAtUnix", "receipt")
    finished = integer(root, "finishedAtUnix", "receipt")
    observed_millis = integer(root, "observedDurationMillis", "receipt")
    require(
        started > 0 and finished >= started,
        "CORE_TIME_INVALID",
        "invalid core timestamps",
    )
    require(observed_millis >= 0, "CORE_TIME_INVALID", "negative observed duration")
    requested = root.get("requestedSoakDurationSeconds")
    if mode == "quick":
        require(
            requested is None,
            "CORE_DURATION_INVALID",
            "quick receipt has a soak duration",
        )
    else:
        require(
            isinstance(requested, int)
            and not isinstance(requested, bool)
            and requested > 0,
            "CORE_DURATION_INVALID",
            "soak receipt must carry a positive requested duration",
        )
    if min_duration_seconds > 0:
        require(
            mode == "soak",
            "CORE_DURATION_INVALID",
            "long-run evidence must use soak mode",
        )
        require(
            requested >= min_duration_seconds,
            "CORE_SOAK_TOO_SHORT",
            f"requested soak is {requested}s; require at least {min_duration_seconds}s",
        )
        require(
            observed_millis >= min_duration_seconds * 1_000,
            "CORE_SOAK_TOO_SHORT",
            f"observed soak is {observed_millis}ms; require at least {min_duration_seconds}s",
        )

    rule = mapping(root, "ruleMatch", "receipt")
    require(
        integer(rule, "ruleCount", "ruleMatch") == RULE_COUNT,
        "CORE_RULE_COUNT_INVALID",
        "rule count changed",
    )
    require(
        integer(rule, "sampleCount", "ruleMatch") >= RULE_SAMPLES,
        "CORE_RULE_SAMPLES_INVALID",
        "too few rule samples",
    )
    require(
        integer(rule, "p99ThresholdNanos", "ruleMatch") == RULE_P99_THRESHOLD_NANOS,
        "CORE_RULE_THRESHOLD_INVALID",
        "rule threshold was changed in the receipt",
    )
    require(
        integer(rule, "p99Nanos", "ruleMatch") < RULE_P99_THRESHOLD_NANOS,
        "CORE_RULE_P99_FAILED",
        "10,000-rule P99 is not below 100 microseconds",
    )
    require(
        boolean(rule, "matchedAllSamples", "ruleMatch"),
        "CORE_RULE_CORRECTNESS_FAILED",
        "not every timed rule matched",
    )
    require(
        boolean(rule, "passed", "ruleMatch"),
        "CORE_RULE_GATE_FAILED",
        "rule sub-gate is red",
    )

    dashboard = mapping(root, "dashboard", "receipt")
    generated_events = integer(dashboard, "generatedEvents", "dashboard")
    retained_capacity = integer(dashboard, "retainedCapacity", "dashboard")
    returned_samples = integer(dashboard, "returnedSamples", "dashboard")
    dropped_samples = integer(dashboard, "droppedSamples", "dashboard")
    require(
        generated_events >= 1_000,
        "CORE_DASHBOARD_INVALID",
        "dashboard event sample is too small",
    )
    require(
        retained_capacity == 256,
        "CORE_DASHBOARD_INVALID",
        "dashboard capacity is not bounded at 256",
    )
    require(
        returned_samples == 200,
        "CORE_DASHBOARD_INVALID",
        "dashboard query did not return its fixed 200-row sample",
    )
    require(
        dropped_samples == generated_events - retained_capacity,
        "CORE_DASHBOARD_INVALID",
        "dashboard dropped-sample count is inconsistent",
    )
    require(
        boolean(dashboard, "bounded", "dashboard"),
        "CORE_DASHBOARD_INVALID",
        "dashboard ring is not bounded",
    )
    require(
        boolean(dashboard, "passed", "dashboard"),
        "CORE_DASHBOARD_GATE_FAILED",
        "dashboard sub-gate is red",
    )

    lifecycle = mapping(root, "lifecycle", "receipt")
    require(
        integer(lifecycle, "requiredStartStopCycles", "lifecycle") == START_STOP_CYCLES,
        "CORE_LIFECYCLE_THRESHOLD_INVALID",
        "lifecycle threshold changed",
    )
    completed_cycles = integer(lifecycle, "completedStartStopCycles", "lifecycle")
    require(
        completed_cycles >= START_STOP_CYCLES,
        "CORE_LIFECYCLE_CYCLES_FAILED",
        "fewer than 100 start/stop cycles completed",
    )
    long_active_session_completed = boolean(
        lifecycle, "longActiveSessionCompleted", "lifecycle"
    )
    if mode == "soak":
        require(
            long_active_session_completed,
            "CORE_SOAK_SESSION_FAILED",
            "long active session did not complete",
        )
    else:
        require(
            not long_active_session_completed,
            "CORE_LIFECYCLE_INVALID",
            "quick receipt unexpectedly claims a long active session",
        )
    require(
        text(lifecycle, "finalJournalPhase", "lifecycle") == "clean",
        "CORE_RESIDUE_FAILED",
        "recovery journal is not clean",
    )
    require(
        boolean(lifecycle, "cleanupRequired", "lifecycle") is False,
        "CORE_RESIDUE_FAILED",
        "cleanup remains required",
    )
    install_calls = integer(lifecycle, "adapterInstallCalls", "lifecycle")
    stop_calls = integer(lifecycle, "adapterStopCalls", "lifecycle")
    recover_calls = integer(lifecycle, "adapterRecoverCalls", "lifecycle")
    heartbeat_count = integer(lifecycle, "heartbeatCount", "lifecycle")
    expected_sessions = completed_cycles + int(long_active_session_completed)
    require(
        install_calls >= expected_sessions and stop_calls == install_calls,
        "CORE_LIFECYCLE_CALLS_INVALID",
        "adapter install/stop calls do not prove every session was cleaned",
    )
    require(
        recover_calls == 0,
        "CORE_UNEXPECTED_RECOVERY",
        "happy-path gate invoked recovery",
    )
    require(
        heartbeat_count >= 0,
        "CORE_HEARTBEAT_INVALID",
        "heartbeat count is negative",
    )
    if min_duration_seconds >= MAX_HEARTBEAT_GAP_SECONDS:
        require(
            heartbeat_count >= min_duration_seconds // MAX_HEARTBEAT_GAP_SECONDS,
            "CORE_HEARTBEAT_TOO_SPARSE",
            "long soak did not persist helper heartbeats often enough",
        )
    require(
        boolean(lifecycle, "passed", "lifecycle"),
        "CORE_LIFECYCLE_GATE_FAILED",
        "lifecycle sub-gate is red",
    )

    resources = mapping(root, "resources", "receipt")
    resource_sample_count = integer(resources, "sampleCount", "resources")
    require(
        resource_sample_count >= 2,
        "CORE_RESOURCE_SAMPLES_INVALID",
        "resource gate requires at least a start and end sample",
    )
    if min_duration_seconds >= MAX_RESOURCE_SAMPLE_GAP_SECONDS:
        require(
            resource_sample_count
            >= min_duration_seconds // MAX_RESOURCE_SAMPLE_GAP_SECONDS,
            "CORE_RESOURCE_SAMPLES_INVALID",
            "long soak did not sample resources often enough",
        )
    require(
        integer(resources, "maxRssEndGrowthBytes", "resources")
        == MAX_CORE_RSS_END_GROWTH,
        "CORE_RESOURCE_THRESHOLD_INVALID",
        "RSS end-growth threshold changed",
    )
    require(
        integer(resources, "maxRssPeakGrowthBytes", "resources")
        == MAX_CORE_RSS_PEAK_GROWTH,
        "CORE_RESOURCE_THRESHOLD_INVALID",
        "RSS peak-growth threshold changed",
    )
    require(
        integer(resources, "maxOpenFileGrowth", "resources")
        == MAX_CORE_OPEN_FILE_GROWTH,
        "CORE_RESOURCE_THRESHOLD_INVALID",
        "open-file threshold changed",
    )
    rss_start = integer(resources, "rssStartBytes", "resources")
    rss_end = integer(resources, "rssEndBytes", "resources")
    rss_peak = integer(resources, "rssPeakBytes", "resources")
    rss_end_growth = integer(resources, "rssEndGrowthBytes", "resources")
    rss_peak_growth = integer(resources, "rssPeakGrowthBytes", "resources")
    require(
        rss_start > 0 and rss_end > 0 and rss_peak >= max(rss_start, rss_end),
        "CORE_RSS_INVALID",
        "RSS start/end/peak values are inconsistent",
    )
    require(
        rss_end_growth == rss_end - rss_start
        and rss_peak_growth == rss_peak - rss_start,
        "CORE_RSS_INVALID",
        "RSS growth values are inconsistent",
    )
    require(
        rss_end_growth <= MAX_CORE_RSS_END_GROWTH,
        "CORE_RSS_GROWTH_FAILED",
        "RSS end growth exceeded 32 MiB",
    )
    require(
        rss_peak_growth <= MAX_CORE_RSS_PEAK_GROWTH,
        "CORE_RSS_GROWTH_FAILED",
        "RSS peak growth exceeded 64 MiB",
    )
    if boolean(resources, "openFileMeasurementSupported", "resources"):
        files_start = integer(resources, "openFilesStart", "resources")
        files_end = integer(resources, "openFilesEnd", "resources")
        files_peak = integer(resources, "openFilesPeak", "resources")
        file_growth = integer(resources, "openFileGrowth", "resources")
        require(
            min(files_start, files_end) >= 0
            and files_peak >= max(files_start, files_end)
            and file_growth == files_end - files_start,
            "CORE_OPEN_FILE_INVALID",
            "open-file start/end/peak values are inconsistent",
        )
        require(
            file_growth <= MAX_CORE_OPEN_FILE_GROWTH,
            "CORE_OPEN_FILE_GROWTH_FAILED",
            "open-file growth exceeded four",
        )
    require(
        boolean(resources, "passed", "resources"),
        "CORE_RESOURCE_GATE_FAILED",
        "resource sub-gate is red",
    )
    return root


def evidence_path(base: Path, value: str, label: str) -> Path:
    require(bool(value), "PLATFORM_EVIDENCE_PATH_INVALID", f"{label} path is empty")
    candidate = (base / value).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        fail(
            "PLATFORM_EVIDENCE_PATH_INVALID", f"{label} escapes the manifest directory"
        )
    require(
        candidate.is_file(),
        "PLATFORM_EVIDENCE_MISSING",
        f"{label} is missing: {candidate}",
    )
    return candidate


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_evidence_item(base: Path, item: dict[str, Any], label: str) -> Path:
    require(
        boolean(item, "passed", label), "PLATFORM_SUBGATE_FAILED", f"{label} is red"
    )
    path = evidence_path(base, text(item, "path", label), label)
    expected = text(item, "sha256", label)
    require(
        bool(SHA256_RE.fullmatch(expected)),
        "PLATFORM_EVIDENCE_HASH_INVALID",
        f"{label} SHA-256 is invalid",
    )
    require(
        sha256_file(path).lower() == expected.lower(),
        "PLATFORM_EVIDENCE_HASH_MISMATCH",
        f"{label} SHA-256 mismatch",
    )
    return path


def verify_artifact_gate_receipt(
    path: Path, *, platform: str, architecture: str, provider: str
) -> None:
    receipt = load_json(path)
    require(
        text(receipt, "platform", "artifactGate") == platform,
        "PLATFORM_ARTIFACT_RECEIPT_INVALID",
        "signed-artifact receipt platform does not match the manifest",
    )
    require(
        text(receipt, "result", "artifactGate") == "PASS",
        "PLATFORM_ARTIFACT_RECEIPT_INVALID",
        "signed-artifact receipt is not PASS",
    )
    require(
        receipt.get("mode") != "lint",
        "PLATFORM_ARTIFACT_RECEIPT_INVALID",
        "a source-lint receipt cannot be used as signed-artifact evidence",
    )
    if platform == "windows":
        require(
            text(receipt, "architecture", "artifactGate") == architecture,
            "PLATFORM_ARTIFACT_RECEIPT_INVALID",
            "Windows artifact receipt architecture does not match",
        )
        require(
            text(receipt, "applicationCaptureProvider", "artifactGate") == provider,
            "PLATFORM_ARTIFACT_RECEIPT_INVALID",
            "Windows artifact receipt provider does not match",
        )
        for key in ("application", "helper", "wintun"):
            require(
                bool(text(receipt, key, "artifactGate").strip()),
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                f"Windows artifact receipt {key} path is empty",
            )
    elif platform == "macos":
        architectures = receipt.get("architectures")
        expected_architecture = "arm64" if architecture == "aarch64" else architecture
        require(
            isinstance(architectures, list) and expected_architecture in architectures,
            "PLATFORM_ARTIFACT_RECEIPT_INVALID",
            "macOS artifact receipt does not contain the manifest architecture",
        )
        for key in ("app", "provider"):
            require(
                bool(text(receipt, key, "artifactGate").strip()),
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                f"macOS artifact receipt {key} path is empty",
            )
    else:
        require(
            text(receipt, "architecture", "artifactGate") == architecture,
            "PLATFORM_ARTIFACT_RECEIPT_INVALID",
            "Linux artifact receipt architecture does not match",
        )
        require(
            text(receipt, "captureProvider", "artifactGate") == provider,
            "PLATFORM_ARTIFACT_RECEIPT_INVALID",
            "Linux artifact receipt provider does not match",
        )
        for key in (
            "packageSignatureVerified",
            "helperOwnershipVerified",
            "helperPolicyVerified",
        ):
            require(
                boolean(receipt, key, "artifactGate"),
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                f"Linux artifact receipt {key} is false",
            )
        for key in ("application", "helper", "helperPolicy"):
            require(
                bool(text(receipt, key, "artifactGate").strip()),
                "PLATFORM_ARTIFACT_RECEIPT_INVALID",
                f"Linux artifact receipt {key} path is empty",
            )


def verify_native_smoke_receipt(path: Path) -> None:
    receipt = load_json(path)
    require(
        text(receipt, "schema", "nativeSmoke") == "qa-ui-auto.summary.v1",
        "PLATFORM_NATIVE_SMOKE_INVALID",
        "native smoke is not a qa-ui-auto v1 summary",
    )
    require(
        text(receipt, "mode", "nativeSmoke") == "native",
        "PLATFORM_NATIVE_SMOKE_INVALID",
        "native smoke did not run in native mode",
    )
    totals = mapping(receipt, "totals", "nativeSmoke")
    total = integer(totals, "total", "nativeSmoke.totals")
    require(
        total > 0
        and integer(totals, "passed", "nativeSmoke.totals") == total
        and integer(totals, "failed", "nativeSmoke.totals") == 0
        and integer(totals, "skipped", "nativeSmoke.totals") == 0,
        "PLATFORM_NATIVE_SMOKE_FAILED",
        "native smoke contains failed or skipped cases",
    )
    cases = receipt.get("cases")
    require(
        isinstance(cases, list),
        "PLATFORM_NATIVE_SMOKE_INVALID",
        "native smoke cases must be an array",
    )
    sockscap_case = next(
        (
            case
            for case in cases
            if isinstance(case, dict)
            and case.get("id") == "TC-SOCKSCAP-native-window-smoke"
        ),
        None,
    )
    sockscap_modes = (
        sockscap_case.get("modes") if isinstance(sockscap_case, dict) else None
    )
    require(
        isinstance(sockscap_case, dict)
        and sockscap_case.get("status") == "passed"
        and isinstance(sockscap_modes, list)
        and "native" in sockscap_modes,
        "PLATFORM_NATIVE_SMOKE_FAILED",
        "required Sockscap native-window case did not pass",
    )


def verify_platform_manifest(path: Path, expected_commit: str | None) -> None:
    root = load_json(path)
    require(
        integer(root, "schemaVersion", "manifest") == SCHEMA_VERSION,
        "PLATFORM_SCHEMA_INVALID",
        "unsupported platform manifest schema",
    )
    require(
        boolean(root, "releaseEvidence", "manifest"),
        "PLATFORM_RELEASE_DISABLED",
        "releaseEvidence is false",
    )
    platform = text(root, "platform", "manifest")
    architecture = text(root, "architecture", "manifest")
    commit = text(root, "gitCommit", "manifest")
    require(
        platform in PROVIDERS, "PLATFORM_INVALID", f"unsupported platform {platform!r}"
    )
    require(
        architecture in {"x86_64", "aarch64"},
        "PLATFORM_ARCH_INVALID",
        f"unsupported architecture {architecture!r}",
    )
    require(
        bool(COMMIT_RE.fullmatch(commit)),
        "PLATFORM_COMMIT_INVALID",
        "gitCommit must be a full 40-character commit",
    )
    if expected_commit is not None:
        require(
            commit.lower() == expected_commit.lower(),
            "PLATFORM_COMMIT_MISMATCH",
            "manifest commit does not match expected commit",
        )
    current_platform = PLATFORM_NAMES.get(sys.platform)
    require(
        current_platform == platform,
        "PLATFORM_HOST_MISMATCH",
        f"manifest is for {platform}, verifier host is {current_platform or sys.platform}",
    )
    provider = text(root, "captureProvider", "manifest")
    require(
        provider in PROVIDERS[platform],
        "PLATFORM_PROVIDER_INVALID",
        f"provider {provider!r} is not valid for {platform}",
    )

    host = mapping(root, "host", "manifest")
    for key in ("id", "osVersion", "hardware"):
        require(
            bool(text(host, key, "host").strip()),
            "PLATFORM_HOST_INVALID",
            f"host.{key} is empty",
        )
    started = integer(root, "startedAtUnix", "manifest")
    finished = integer(root, "finishedAtUnix", "manifest")
    require(
        started > 0 and finished > started,
        "PLATFORM_TIME_INVALID",
        "invalid platform timestamps",
    )

    base = path.resolve().parent
    evidence = mapping(root, "evidence", "manifest")
    artifact_path = verify_evidence_item(
        base, mapping(evidence, "artifactGate", "evidence"), "artifactGate"
    )
    smoke_path = verify_evidence_item(
        base, mapping(evidence, "nativeSmoke", "evidence"), "nativeSmoke"
    )
    quick_path = verify_evidence_item(
        base, mapping(evidence, "coreQuick", "evidence"), "coreQuick"
    )
    soak_path = verify_evidence_item(
        base, mapping(evidence, "coreSoak", "evidence"), "coreSoak"
    )
    primary_paths = {artifact_path, smoke_path, quick_path, soak_path}
    require(
        len(primary_paths) == 4,
        "PLATFORM_EVIDENCE_DUPLICATE",
        "primary evidence files must be distinct",
    )
    verify_artifact_gate_receipt(
        artifact_path,
        platform=platform,
        architecture=architecture,
        provider=provider,
    )
    verify_native_smoke_receipt(smoke_path)
    verify_core_receipt(
        quick_path,
        expected_commit=commit,
        expected_platform=platform,
        expected_architecture=architecture,
    )
    verify_core_receipt(
        soak_path,
        min_duration_seconds=RELEASE_SOAK_SECONDS,
        expected_commit=commit,
        expected_platform=platform,
        expected_architecture=architecture,
    )

    matrix = mapping(root, "captureMatrix", "manifest")
    for key in (
        "globalIpv4Tcp",
        "globalIpv6Tcp",
        "applicationGroupIpv4Tcp",
        "runtimePidIpv4Tcp",
        "dnsCaptured",
        "udpPolicyEnforced",
        "hardBypassVerified",
    ):
        require(
            boolean(matrix, key, "captureMatrix"),
            "PLATFORM_CAPTURE_MATRIX_FAILED",
            f"captureMatrix.{key} is false",
        )

    performance = mapping(root, "performance", "manifest")
    connect = mapping(performance, "tcpConnect", "performance")
    require(
        integer(connect, "sampleCount", "tcpConnect") >= MIN_CONNECT_SAMPLES,
        "PLATFORM_CONNECT_SAMPLES_FAILED",
        "fewer than 100 TCP connect samples",
    )
    direct_median = number(connect, "directMedianMicros", "tcpConnect")
    captured_median = number(connect, "capturedMedianMicros", "tcpConnect")
    overhead = number(connect, "overheadMedianMicros", "tcpConnect")
    require(
        direct_median >= 0 and captured_median >= 0 and overhead >= 0,
        "PLATFORM_CONNECT_INVALID",
        "TCP medians cannot be negative",
    )
    require(
        abs((captured_median - direct_median) - overhead) <= 100,
        "PLATFORM_CONNECT_INCONSISTENT",
        "declared TCP overhead does not match captured-direct medians",
    )
    require(
        overhead < MAX_CONNECT_OVERHEAD_MICROS,
        "PLATFORM_CONNECT_OVERHEAD_FAILED",
        "TCP connect overhead is not below 10 ms",
    )

    throughput = mapping(performance, "throughput", "performance")
    require(
        integer(throughput, "sampleSeconds", "throughput")
        >= MIN_THROUGHPUT_SAMPLE_SECONDS,
        "PLATFORM_THROUGHPUT_SAMPLE_FAILED",
        "throughput sample is shorter than 60 seconds",
    )
    link_capacity_mbps = number(throughput, "linkCapacityMbps", "throughput")
    direct_mbps = number(throughput, "directMbps", "throughput")
    captured_mbps = number(throughput, "capturedMbps", "throughput")
    declared_ratio = number(throughput, "capturedToDirectRatio", "throughput")
    require(
        link_capacity_mbps >= MIN_LINK_CAPACITY_MBPS,
        "PLATFORM_LINK_CAPACITY_FAILED",
        "throughput gate requires a link of at least 1 Gbps",
    )
    require(
        direct_mbps > 0 and captured_mbps > 0,
        "PLATFORM_THROUGHPUT_INVALID",
        "throughput values must be positive",
    )
    require(
        direct_mbps >= link_capacity_mbps * 0.80,
        "PLATFORM_DIRECT_BASELINE_FAILED",
        "direct throughput is below 80% of link capacity",
    )
    actual_ratio = captured_mbps / direct_mbps
    require(
        abs(actual_ratio - declared_ratio) <= 0.005,
        "PLATFORM_THROUGHPUT_INCONSISTENT",
        "declared throughput ratio is inconsistent",
    )
    require(
        actual_ratio >= MIN_THROUGHPUT_RATIO,
        "PLATFORM_THROUGHPUT_FAILED",
        "captured throughput is below 80% of direct",
    )

    stability = mapping(root, "stability", "manifest")
    duration = integer(stability, "durationSeconds", "stability")
    require(
        duration >= RELEASE_SOAK_SECONDS,
        "PLATFORM_SOAK_TOO_SHORT",
        "platform soak is shorter than 24 hours",
    )
    require(
        finished - started >= duration,
        "PLATFORM_TIME_INCONSISTENT",
        "timestamps are shorter than declared soak duration",
    )
    require(
        integer(stability, "startStopCycles", "stability") >= START_STOP_CYCLES,
        "PLATFORM_LIFECYCLE_CYCLES_FAILED",
        "fewer than 100 real start/stop cycles",
    )
    require(
        integer(stability, "unexpectedAppExits", "stability") == 0,
        "PLATFORM_APP_CRASHED",
        "unexpected app exits were recorded",
    )
    require(
        integer(stability, "unexpectedHelperExits", "stability") == 0,
        "PLATFORM_HELPER_CRASHED",
        "unexpected helper/provider exits were recorded",
    )
    require(
        integer(stability, "rssGrowthBytes", "stability") <= MAX_PLATFORM_RSS_GROWTH,
        "PLATFORM_RSS_GROWTH_FAILED",
        "RSS growth exceeded 64 MiB",
    )
    require(
        integer(stability, "openHandleGrowth", "stability")
        <= MAX_PLATFORM_OPEN_HANDLE_GROWTH,
        "PLATFORM_HANDLE_GROWTH_FAILED",
        "open-handle growth exceeded eight",
    )
    cleanup_checks = integer(stability, "cleanupChecks", "stability")
    require(
        cleanup_checks >= START_STOP_CYCLES,
        "PLATFORM_CLEANUP_SAMPLES_FAILED",
        "fewer than 100 cleanup checks",
    )
    require(
        integer(stability, "residueFailures", "stability") == 0,
        "PLATFORM_RESIDUE_FAILED",
        "network residue was detected",
    )
    for key in (
        "killMainRecovered",
        "killHelperRecovered",
        "restartRecovered",
        "sleepWakePassed",
        "nicSwitchPassed",
        "vpnCoexistencePassed",
    ):
        require(
            boolean(stability, key, "stability"),
            "PLATFORM_RECOVERY_MATRIX_FAILED",
            f"stability.{key} is false",
        )

    leak = mapping(root, "leakAudit", "manifest")
    for key in ("dnsPassed", "ipv4Passed", "ipv6Passed", "udpPassed"):
        require(
            boolean(leak, key, "leakAudit"),
            "PLATFORM_LEAK_AUDIT_FAILED",
            f"leakAudit.{key} is false",
        )

    raw = root.get("rawEvidence")
    require(
        isinstance(raw, list) and len(raw) >= 4,
        "PLATFORM_RAW_EVIDENCE_INVALID",
        "at least four raw evidence files are required",
    )
    raw_paths: set[Path] = set()
    for index, item in enumerate(raw):
        require(
            isinstance(item, dict),
            "PLATFORM_RAW_EVIDENCE_INVALID",
            f"rawEvidence[{index}] must be an object",
        )
        name = text(item, "name", f"rawEvidence[{index}]")
        require(
            bool(name.strip()),
            "PLATFORM_RAW_EVIDENCE_INVALID",
            f"rawEvidence[{index}].name is empty",
        )
        raw_path = evidence_path(
            base, text(item, "path", f"rawEvidence[{index}]"), f"rawEvidence[{index}]"
        )
        expected_hash = text(item, "sha256", f"rawEvidence[{index}]")
        require(
            bool(SHA256_RE.fullmatch(expected_hash)),
            "PLATFORM_EVIDENCE_HASH_INVALID",
            f"rawEvidence[{index}] SHA-256 is invalid",
        )
        require(
            sha256_file(raw_path).lower() == expected_hash.lower(),
            "PLATFORM_EVIDENCE_HASH_MISMATCH",
            f"rawEvidence[{index}] SHA-256 mismatch",
        )
        require(
            raw_path not in raw_paths,
            "PLATFORM_EVIDENCE_DUPLICATE",
            f"duplicate raw evidence path {raw_path}",
        )
        require(
            raw_path not in primary_paths,
            "PLATFORM_EVIDENCE_DUPLICATE",
            f"raw evidence reuses a primary receipt: {raw_path}",
        )
        raw_paths.add(raw_path)


def lint_platform_template(path: Path) -> None:
    root = load_json(path)
    require(
        integer(root, "schemaVersion", "manifest") == SCHEMA_VERSION,
        "PLATFORM_SCHEMA_INVALID",
        "unsupported template schema",
    )
    require(
        boolean(root, "releaseEvidence", "manifest") is False,
        "PLATFORM_TEMPLATE_ENABLED",
        "committed template must stay disabled",
    )
    require(
        text(root, "platform", "manifest") == "unconfigured",
        "PLATFORM_TEMPLATE_INVALID",
        "template platform must be unconfigured",
    )
    require(
        text(root, "architecture", "manifest") == "unconfigured",
        "PLATFORM_TEMPLATE_INVALID",
        "template architecture must be unconfigured",
    )
    require(
        text(root, "captureProvider", "manifest") == "unconfigured",
        "PLATFORM_TEMPLATE_INVALID",
        "template capture provider must be unconfigured",
    )
    mapping(root, "host", "manifest")
    evidence = mapping(root, "evidence", "manifest")
    for key in ("artifactGate", "nativeSmoke", "coreQuick", "coreSoak"):
        mapping(evidence, key, "evidence")
    matrix = mapping(root, "captureMatrix", "manifest")
    for key in (
        "globalIpv4Tcp",
        "globalIpv6Tcp",
        "applicationGroupIpv4Tcp",
        "runtimePidIpv4Tcp",
        "dnsCaptured",
        "udpPolicyEnforced",
        "hardBypassVerified",
    ):
        boolean(matrix, key, "captureMatrix")
    performance = mapping(root, "performance", "manifest")
    mapping(performance, "tcpConnect", "performance")
    mapping(performance, "throughput", "performance")
    mapping(root, "stability", "manifest")
    mapping(root, "leakAudit", "manifest")
    require(
        isinstance(root.get("rawEvidence"), list),
        "PLATFORM_TEMPLATE_INVALID",
        "rawEvidence must be an array",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("core", "platform"))
    parser.add_argument("path", type=Path)
    parser.add_argument("--min-duration-seconds", type=int, default=0)
    parser.add_argument("--expected-commit")
    parser.add_argument("--lint", action="store_true")
    args = parser.parse_args()
    try:
        require(
            args.min_duration_seconds >= 0,
            "ARGUMENT_INVALID",
            "--min-duration-seconds cannot be negative",
        )
        if args.lint:
            require(
                args.kind == "platform",
                "ARGUMENT_INVALID",
                "--lint is only valid for platform templates",
            )
            require(
                args.min_duration_seconds == 0 and args.expected_commit is None,
                "ARGUMENT_INVALID",
                "template lint does not accept duration or commit constraints",
            )
            lint_platform_template(args.path)
            print(
                json.dumps(
                    {
                        "passed": True,
                        "kind": "platform_template",
                        "path": str(args.path),
                    }
                )
            )
        elif args.kind == "core":
            verify_core_receipt(
                args.path,
                min_duration_seconds=args.min_duration_seconds,
                expected_commit=args.expected_commit,
            )
            print(json.dumps({"passed": True, "kind": "core", "path": str(args.path)}))
        else:
            require(
                args.min_duration_seconds == 0,
                "ARGUMENT_INVALID",
                "platform gate uses the fixed 24-hour minimum",
            )
            verify_platform_manifest(args.path, args.expected_commit)
            print(
                json.dumps(
                    {"passed": True, "kind": "platform_release", "path": str(args.path)}
                )
            )
        return 0
    except GateFailure as error:
        print(
            json.dumps(
                {"passed": False, "code": error.code, "detail": error.detail},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
