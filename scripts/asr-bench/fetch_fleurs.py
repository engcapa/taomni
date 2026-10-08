#!/usr/bin/env python3
"""Fetch the exact licensed benchmark subset, without ambient proxy settings.

Completed WAVs are hash-verified and reused across retries. TAR streams restart
on retry; incomplete WAVs never replace a verified recording. No archive paths
are extracted onto the filesystem.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
CONFIGS = dict(zh="cmn_hans_cn", yue="yue_hant_hk", en="en_us", ja="ja_jp",
               es="es_419", fr="fr_fr", it="it_it", ko="ko_kr")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    proxy = parser.add_mutually_exclusive_group(required=True)
    proxy.add_argument("--proxy", help="Explicit HTTP proxy URL")
    proxy.add_argument("--no-proxy", action="store_true")
    args = parser.parse_args()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(
        {"https": args.proxy} if args.proxy else {}))
    manifest = json.loads((ROOT / "qa-ui-auto-tests/fixtures/voice/benchmark-fleurs.json").read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    for language, config in CONFIGS.items():
        samples = [s for s in manifest["samples"] if s["language"] == language]
        wanted = {}
        for sample in samples:
            target = args.output / sample["path"]
            if target.is_file() and digest(target) == sample["sha256"]:
                continue
            upstream_name = sample["source"].split("file=", 1)[1]
            wanted[upstream_name] = sample
        if not wanted:
            print(f"{language}: 20/20 verified, reusing", flush=True)
            continue
        url = f"https://huggingface.co/datasets/google/fleurs/resolve/{REVISION}/data/{config}/audio/test.tar.gz"
        print(f"{language}: connecting; {len(wanted)} recordings remaining", flush=True)
        with opener.open(url, timeout=120) as response, tarfile.open(fileobj=response, mode="r|gz") as archive:
            for member in archive:
                name = Path(member.name).name
                if name not in wanted or not member.isfile():
                    continue
                if member.size > 16_000 * 4 * 120 + 4096:
                    raise ValueError("Unexpected oversized WAV in source archive")
                sample = wanted[name]
                target = args.output / sample["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                part = target.with_suffix(".part")
                data = archive.extractfile(member).read()
                part.write_bytes(data)
                if hashlib.sha256(data).hexdigest() != sample["sha256"]:
                    raise ValueError(f"Checksum mismatch: {sample['id']}")
                part.replace(target)
                del wanted[name]
                print(f"{language}: {20 - len(wanted)}/20 verified", flush=True)
                if not wanted:
                    break
        if wanted:
            raise ValueError(f"Missing pinned recordings: {language}")
    (args.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Ready: {args.output / 'manifest.json'}", flush=True)


if __name__ == "__main__":
    main()
