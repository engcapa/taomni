"""Download planned QA shard evidence as it becomes available during a run."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
import zipfile


PROGRESS_POLL_SECONDS = 60


class GitHubArtifacts:
    def __init__(self, repository: str, run_id: str):
        self.repository = repository
        self.run_id = run_id
        self._cached: dict[str, tuple[str, dict]] = {}

    def _read(self, resource: str = "") -> dict:
        endpoint = f"repos/{self.repository}/actions/runs/{self.run_id}{resource}"
        command = ["gh", "api", "--include", endpoint]
        cached = self._cached.get(resource)
        if cached:
            command.extend(["--header", f"If-None-Match: {cached[0]}"])
        response = subprocess.run(command, capture_output=True, timeout=120)
        header, separator, body = response.stdout.partition(b"\r\n\r\n")
        if not separator:
            header, _, body = response.stdout.partition(b"\n\n")
        status, *headers = header.splitlines() or [b""]
        if cached and status.split()[1:2] == [b"304"]:
            return cached[1]
        response.check_returncode()
        value = json.loads(body)
        for line in headers:
            name, _, etag = line.partition(b":")
            if name.lower() == b"etag":
                self._cached[resource] = (etag.strip().decode("ascii"), value)
                break
        else:
            self._cached.pop(resource, None)
        return value

    def listing(self, resource: str) -> list[dict]:
        # Explicit pages also work with older authenticated gh installations
        # that do not support api --slurp. A failed page remains a retryable
        # observation error; never return an incomplete listing as success.
        items = []
        page = 1
        while True:
            current = self._read(f"/{resource}?per_page=100&page={page}")[resource]
            items.extend(current)
            if len(current) < 100:
                return items
            page += 1

    def run_status(self) -> str:
        return self._read()["status"]

    def download(self, artifact: dict, target: Path) -> None:
        # gh handles the REST archive endpoint's signed storage redirect. Do not
        # forward an API Authorization header to the artifact storage host.
        result = subprocess.run(
            ["gh", "api", f"repos/{self.repository}/actions/artifacts/{artifact['id']}/zip"],
            check=True, capture_output=True, timeout=180,
        )
        extract_archive(result.stdout, target)


def extract_archive(payload: bytes, target: Path) -> None:
    staging = target.with_name(target.name + ".partial")
    shutil.rmtree(staging, ignore_errors=True)
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for member in archive.infolist():
                relative = PurePosixPath(member.filename)
                if (relative.is_absolute() or ".." in relative.parts
                        or "\\" in member.filename or ":" in member.filename
                        or (member.external_attr >> 16) & 0o170000 == 0o120000):
                    raise ValueError(f"unsafe artifact path: {member.filename}")
            archive.extractall(staging)
        staging.rename(target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def expected_entries(selection: dict) -> dict[str, dict]:
    entries = {}
    for entry in selection["entries"]:
        identifier = entry["id"]
        if (not isinstance(identifier, str)
                or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", identifier)
                or identifier in entries):
            raise ValueError(f"invalid or duplicate planned shard id: {identifier}")
        entries[identifier] = entry
    return entries


def blocked_entries(entries: dict[str, dict], jobs: list[dict]) -> set[str]:
    """Missing shards are terminal only when their execution/producer is terminal.

    Native execution jobs may not exist until a build succeeds. Their absence
    while the build runs must keep collection alive, even after every browser
    shard has finished.
    """
    blocked = set()
    for identifier, entry in entries.items():
        group = f"execute-{entry['platform_key']}-{entry['mode']}"
        if entry["mode"] == "browser" and entry["platform_key"] != "macos":
            group = "execute-browser"
        execution = [job for job in jobs if job["name"] == group
                     or (job["name"].startswith(group + " / ")
                         and job["name"].endswith(" / " + identifier))]
        if not execution and group == "execute-macos-browser":
            # Older runs published individual macOS shards in the shared group.
            execution = [job for job in jobs if job["name"] == "execute-browser / " + identifier]
        if execution:
            if all(job["status"] == "completed" for job in execution):
                blocked.add(identifier)
            continue
        if entry["mode"] == "native":
            prefix = f"build-{entry['platform_key']}"
            producers = [job for job in jobs if job["name"] == prefix
                         or job["name"] == f"{prefix} / {entry['build_id']}"]
            if producers and all(job["status"] == "completed"
                                 and job.get("conclusion") != "success" for job in producers):
                blocked.add(identifier)
    return blocked


def report_shard(path: Path, summary_path: Path | None) -> None:
    rows = []
    for junit in sorted(path.rglob("junit.xml")):
        try:
            cases = ET.parse(junit).getroot().iter("testcase")
        except ET.ParseError as error:
            print(f"[{path.name}] Invalid JUnit at {junit.relative_to(path)}: {error}", flush=True)
            try:
                report = json.loads(junit.with_name("summary.json").read_text(encoding="utf-8"))
                rows.extend(f"{case['id']} {case['title']}: {case['status']}" for case in report["cases"])
            except (OSError, ValueError, KeyError, TypeError):
                print(f"[{path.name}] Raw evidence retained, case summary unavailable", flush=True)
            continue
        for case in cases:
            outcome = next((status for tag, status in
                            (("failure", "failed"), ("error", "error"), ("skipped", "skipped"))
                            if case.find(tag) is not None), "passed")
            rows.append(f"{case.attrib.get('name', '')}: {outcome}")
    if rows:
        print(f"[{path.name}] " + "; ".join(rows), flush=True)
        if summary_path:
            with summary_path.open("a", encoding="utf-8") as stream:
                stream.write(f"\n### Live shard: {path.name}\n\n")
                stream.write("\n".join(f"- {row}" for row in rows) + "\n")
    else:
        print(f"[{path.name}] downloaded; no case results in this artifact", flush=True)


def collect(client: GitHubArtifacts, destination: Path, run_id: str, artifact_key: str,
            *, summary_path: Path | None = None, timeout_seconds: float = 6 * 60 * 60,
            poll_seconds: float = 15, sleep=time.sleep, monotonic=time.monotonic) -> int:
    destination.mkdir(parents=True, exist_ok=True)
    selection_name = f"qa-selection-{artifact_key}"
    seen: set[str] = set()
    entries: dict[str, dict] | None = None
    blocked: set[str] = set()
    deadline = monotonic() + timeout_seconds
    next_jobs_read = monotonic()
    settled_polls = 0
    timed_out = False
    try:
        while monotonic() < deadline:
            try:
                artifacts = {artifact["name"]: artifact for artifact in client.listing("artifacts")
                             if not artifact.get("expired")}
                allowed = {selection_name}
                if entries is not None:
                    allowed.update(f"qa-{identifier}-{artifact_key}" for identifier in entries)
                for name in sorted(allowed - seen):
                    artifact = artifacts.get(name)
                    if artifact is None:
                        continue
                    try:
                        target = destination / name
                        client.download(artifact, target)
                        if name == selection_name:
                            entries = expected_entries(json.loads((target / "selection.json").read_text()))
                        else:
                            report_shard(target, summary_path)
                        seen.add(name)
                        print(f"Downloaded completed artifact {name}", flush=True)
                    except (OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
                        shutil.rmtree(destination / name, ignore_errors=True)
                        print(f"Retrying artifact {name}: {type(error).__name__}", flush=True)

                if entries is not None:
                    missing = {identifier for identifier in entries
                               if f"qa-{identifier}-{artifact_key}" not in seen}
                    if not missing:
                        break
                    if monotonic() >= next_jobs_read:
                        next_jobs_read = monotonic() + PROGRESS_POLL_SECONDS
                        jobs = client.listing("jobs")
                        blocked = blocked_entries({identifier: entries[identifier] for identifier in missing}, jobs)
                    blocked.intersection_update(missing)
                    # Give the artifact listing time to catch up with terminal
                    # jobs. An available but failed transfer keeps retrying.
                    downloadable = {identifier for identifier in missing
                                    if f"qa-{identifier}-{artifact_key}" in artifacts}
                    settled_polls = settled_polls + 1 if missing <= blocked and not downloadable else 0
                    if settled_polls >= 3:
                        break
                    print(f"Waiting for {len(missing)} planned shards; downloaded {len(seen)} artifacts", flush=True)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                print(f"Retrying GitHub artifact/job listing: {type(error).__name__}", flush=True)
            sleep(poll_seconds)
        else:
            timed_out = True
    finally:
        identifiers = set(entries or {})
        missing = sorted(identifier for identifier in identifiers
                         if f"qa-{identifier}-{artifact_key}" not in seen)
        index = {"run_id": run_id, "artifact_key": artifact_key, "artifacts": sorted(seen),
                 "expected_shards": sorted(identifiers), "missing_shards": missing,
                 "blocked_shards": sorted(blocked), "selection_downloaded": selection_name in seen,
                 "timed_out": timed_out}
        (destination / "live-shard-index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    return int(timed_out or entries is None or bool(missing))


def main() -> int:
    repository = os.environ["QA_REPOSITORY"]
    run_id = os.environ["QA_RUN_ID"]
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    return collect(GitHubArtifacts(repository, run_id), Path("live-shards"), run_id,
                   os.environ["QA_ARTIFACT_KEY"], summary_path=Path(summary) if summary else None)


if __name__ == "__main__":
    raise SystemExit(main())
