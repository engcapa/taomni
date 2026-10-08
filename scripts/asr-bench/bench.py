#!/usr/bin/env python3
"""Offline ASR benchmark orchestration; never downloads weights or uploads audio."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import struct
import subprocess
import sys
import time
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
LANGUAGES = ("zh", "yue", "en", "ja", "es", "fr", "it", "ko")
METRICS = ("cold_load_ms", "inference_ms", "first_partial_ms", "endpoint_to_final_ms", "peak_rss_bytes")
_spec = importlib.util.spec_from_file_location("voice_fixture", ROOT / "scripts/voice-fixture.py")
_fixture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fixture)


def sha256(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def normalized(text):
    # Fixed, language-independent policy. No synonym/traditional conversion to
    # make a particular engine's output look better. Raw text is always retained.
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(c for c in text if not unicodedata.category(c).startswith("P"))


def distance(reference, actual):
    previous = list(range(len(actual) + 1))
    for i, a in enumerate(reference):
        row = [i + 1]
        for j, b in enumerate(actual):
            row.append(min(previous[j] + (a != b), previous[j + 1] + 1, row[j] + 1))
        previous = row
    return previous[-1]


def score(reference, actual):
    ref, hyp = normalized(reference), normalized(actual)
    chars, recognized = "".join(ref.split()), "".join(hyp.split())
    words, output = ref.split(), hyp.split()
    return {
        "character_errors": distance(chars, recognized), "reference_characters": len(chars),
        "cer": distance(chars, recognized) / len(chars) if chars else None,
        "word_errors": distance(words, output), "reference_words": len(words),
        "wer": distance(words, output) / len(words) if words else None,
        "unexpected_text": not chars and bool(recognized),
    }


def load_manifest(path):
    path = Path(path).resolve()
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1 or not manifest.get("samples"):
        raise ValueError("Expected schema_version=1 and a nonempty samples list")
    ids, hashes, samples = set(), set(), []
    for sample in manifest["samples"]:
        for key in ("id", "path", "sha256", "language", "category", "reference", "source", "license", "duration_s"):
            if key not in sample:
                raise ValueError(f"Missing sample field: {key}")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", sample["id"]) or sample["id"] in ids:
            raise ValueError("Sample IDs must be unique safe filenames")
        if sample["category"] not in ("speech", "mixed", "code", "noise", "silence"):
            raise ValueError("Unknown sample category")
        if sample["language"] not in (*LANGUAGES, "auto"):
            raise ValueError("Unknown sample language")
        if not sample["source"] or not sample["license"]:
            raise ValueError("Every sample needs source and license provenance")
        if sample["category"] in ("speech", "mixed", "code") and not sample["reference"].strip():
            raise ValueError("Speech requires an independent reference transcript")
        audio = (path.parent / sample["path"]).resolve()
        digest = sha256(audio)
        if digest != sample["sha256"] or digest in hashes:
            raise ValueError(f"Audio hash mismatch or duplicate recording: {sample['id']}")
        pcm = _fixture.pcm_f32(audio)
        if not pcm or len(pcm) % 4 or len(pcm) > 120 * 64000:
            raise ValueError("Expected nonempty audio of at most 120 seconds")
        if any(not math.isfinite(v[0]) or abs(v[0]) > 1 for v in struct.iter_unpack("<f", pcm)):
            raise ValueError("PCM must contain finite normalized samples")
        seconds = len(pcm) / 64000
        if not math.isfinite(sample["duration_s"]) or abs(seconds - sample["duration_s"]) > 1 / 16000:
            raise ValueError(f"Audio duration mismatch: {sample['id']}")
        ids.add(sample["id"])
        hashes.add(digest)
        samples.append((sample, pcm))
    return manifest, samples


def coverage(samples):
    counts = Counter((s["category"], s["language"]) for s, _ in samples)
    gaps = [f"{lang}: {counts['speech', lang]}/20 speech recordings" for lang in LANGUAGES if counts['speech', lang] < 20]
    categories = Counter(s["category"] for s, _ in samples)
    for category, minimum in (("mixed", 20), ("code", 10), ("noise", 1), ("silence", 1)):
        if categories[category] < minimum:
            gaps.append(f"{category}: {categories[category]}/{minimum} recordings")
    return gaps


def validate_result(result):
    if not isinstance(result.get("text"), str):
        raise ValueError("Adapter must return text, including an empty string for silence")
    for name in METRICS:
        value = result.get(name)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0):
            raise ValueError(f"Invalid measured metric: {name}")
    if result.get("inference_ms") is None or result.get("cold_load_ms") is None:
        raise ValueError("Adapter must measure cold_load_ms and inference_ms")
    if type(result.get("threads")) is not int or result["threads"] < 1:
        raise ValueError("Adapter must identify its thread count")
    if not result.get("engine") or not result.get("quantization") or not re.fullmatch(r"[a-f0-9]{64}", result.get("model_sha256", "")):
        raise ValueError("Adapter must identify engine, quantization and exact weight hash")
    return result


def aggregate(rows):
    groups = {}
    for row in rows:
        key = (row.get("measurement", {}).get("engine", "failed"), row["language"], row["category"])
        group = groups.setdefault(key, {"engine": key[0], "language": key[1], "category": key[2],
            "samples": 0, "failed": 0, "character_errors": 0, "reference_characters": 0,
            "word_errors": 0, "reference_words": 0, "unexpected_text_samples": 0})
        group["samples"] += 1
        if row["status"] != "ok":
            group["failed"] += 1
            continue
        for name in ("character_errors", "reference_characters", "word_errors", "reference_words"):
            group[name] += row["scores"][name]
        group["unexpected_text_samples"] += int(row["scores"]["unexpected_text"])
    for group in groups.values():
        group["cer"] = group["character_errors"] / group["reference_characters"] if group["reference_characters"] else None
        group["wer"] = group["word_errors"] / group["reference_words"] if group["reference_words"] else None
    return list(groups.values())


def host_info():
    cpu = platform.processor()
    info = Path("/proc/cpuinfo")
    if info.exists():
        cpu = next((line.split(":", 1)[1].strip() for line in info.read_text().splitlines() if line.startswith("model name")), cpu)
    return {"cpu": cpu, "logical_cpus": os.cpu_count(), "platform": platform.platform(), "python": platform.python_version()}


def write_report(path, report):
    lines = ["# ASR benchmark evidence", "", f"UTC: {report['created_at']}", f"CPU: {report['host']['cpu']}",
             f"Platform: {report['host']['platform']}", f"Source: `{report['source_revision']}` (dirty={report['source_dirty']})",
             f"Manifest SHA-256: `{report['manifest_sha256']}`", f"Adapter executable SHA-256: `{report['executable_sha256']}`", "",
             "Exploratory measurements only. Missing corpus/hardware coverage is not P0 acceptance.", "",
             "Normalization: NFKC + casefold, remove Unicode punctuation; CER excludes whitespace; WER uses whitespace words.",
             "WER is not linguistically segmented for CJK. Empty references have null CER/WER; unexpected output is reported separately.",
             "Cold load includes model verification. First partial and endpoint latency are null for batch engines.",
             "Process cold starts do not imply an empty OS disk cache. Peak RSS includes the test/runtime process.", "",
             "| Sample | Language | Engine / quantization / threads | Audio s | CER | WER | Cold ms | Decode ms | RTF | First partial ms | Endpoint-final ms | Peak MiB | Status |",
             "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"]
    def n(value):
        return "—" if value is None else f"{value:.3f}"
    for row in report["results"]:
        m = row.get("measurement", {})
        scores = row.get("scores", {})
        lines.append("| " + " | ".join([row["id"], row["language"], f"{m.get('engine', '—')} / {m.get('quantization', '—')} / {m.get('threads', '—')}",
            n(row["duration_s"]), n(scores.get("cer")), n(scores.get("wer")), n(m.get("cold_load_ms")), n(m.get("inference_ms")), n(row.get("rtf")),
            n(m.get("first_partial_ms")), n(m.get("endpoint_to_final_ms")), n(m["peak_rss_bytes"] / 1048576 if m.get("peak_rss_bytes") else None), row["status"]]) + " |")
    lines += ["", "Corpus gaps:", ""] + [f"- {gap}" for gap in report["corpus_gaps"]]
    lines += ["", "See results.json for references, raw transcripts, hashes, metrics and errors. Audio is never copied into the report.", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def run(args, samples):
    adapter = json.loads(args.adapter.read_text(encoding="utf-8"))
    command = adapter["command"]
    if not isinstance(command, list) or not command or not all(isinstance(s, str) for s in command):
        raise ValueError("Adapter command must be an argv array (never shell code)")
    executable = Path(command[0]).resolve()
    if not executable.is_file():
        raise ValueError("Build the native probe first and use an absolute executable path")
    command[0] = str(executable)
    # A fresh directory prevents old successful results from masquerading as this run.
    args.output.mkdir(parents=True, exist_ok=False)
    report = {
        "schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(), "host": host_info(),
        "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
        "source_files": {str(path.relative_to(ROOT)): sha256(path) for path in [
            ROOT / "src-tauri/src/asr/manager.rs", ROOT / "src-tauri/src/asr/catalog.rs",
            ROOT / "src-tauri/src/asr/sensevoice.rs", ROOT / "src-tauri/src/voice/streaming.rs",
            ROOT / "src-tauri/src/asr/benchmark.rs", ROOT / "src-tauri/Cargo.lock", Path(__file__).resolve(),
        ]},
        "manifest_sha256": sha256(args.manifest), "adapter_sha256": sha256(args.adapter),
        "executable_sha256": sha256(executable), "corpus_gaps": coverage(samples), "results": [],
    }
    for sample, pcm in samples:
        row = {**sample, "status": "failed"}
        folder = args.output / sample["id"]
        folder.mkdir()
        pcm_path, result_path = folder / "input.f32", folder / "measurement.json"
        pcm_path.write_bytes(pcm)
        environment = {**os.environ, **adapter.get("env", {}), "TAOMNI_ASR_BENCH_PCM": str(pcm_path.resolve()),
                       "TAOMNI_ASR_BENCH_RESULT": str(result_path.resolve()), "TAOMNI_ASR_BENCH_LANGUAGE": sample["language"]}
        start = time.monotonic()
        try:
            with (folder / "adapter.log").open("wb") as log:
                subprocess.run(command, env=environment, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=args.timeout)
            measurement = validate_result(json.loads(result_path.read_text(encoding="utf-8")))
            row.update(status="ok", measurement=measurement, scores=score(sample["reference"], measurement["text"]), rtf=measurement["inference_ms"] / (sample["duration_s"] * 1000))
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            row["error"] = str(error)
        finally:
            pcm_path.unlink(missing_ok=True)
        row["process_wall_ms"] = (time.monotonic() - start) * 1000
        report["results"].append(row)
        report["aggregates"] = aggregate(report["results"])
        (args.output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        write_report(args.output / "report.md", report)
        print(f"{sample['id']}: {row['status']}", flush=True)
    return 1 if any(row["status"] != "ok" for row in report["results"]) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--require-p0-corpus", action="store_true")
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--timeout", type=float, default=300)
    args = parser.parse_args()
    _, samples = load_manifest(args.manifest)
    gaps = coverage(samples)
    print(json.dumps({"samples": len(samples), "corpus_gaps": gaps}, ensure_ascii=False))
    if args.require_p0_corpus and gaps:
        return 2
    if args.validate_only:
        return 0
    if not args.adapter or not args.output or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("Running requires --adapter, --output and a positive timeout")
    return run(args, samples)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f"Benchmark rejected: {error}", file=sys.stderr)
        sys.exit(2)
