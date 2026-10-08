#!/usr/bin/env python3
"""Prepare an explicit, isolated real-audio Whisper test fixture (no microphone)."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import urllib.request

MODEL_SHA = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin"
WAV_SHA = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e"
ZH_SHA = "a72c0b59fdba80850552af7991de07f9f4940846d2d70f0890eeb153c40f164b"
ZH_FIXTURE = Path(__file__).resolve().parents[1] / "qa-ui-auto-tests/fixtures/voice/fleurs-cmn-hans-cn-1906.wav"
WAV_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav"


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def download(url, path, expected=None):
    if path.exists() and (expected is None or digest(path) == expected):
        return
    part = path.with_suffix(path.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as source, part.open("wb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
        if expected and digest(part) != expected:
            raise ValueError(f"SHA-256 mismatch: {path.name}")
        part.replace(path)
    finally:
        part.unlink(missing_ok=True)


def pcm_f32(wav):
    """Read the two fixed fixture formats: PCM16 and IEEE-float32 mono WAV."""
    data = wav.read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("Expected RIFF WAVE")
    offset, fmt, audio = 12, None, None
    while offset + 8 <= len(data):
        name, size = struct.unpack_from("<4sI", data, offset)
        chunk = data[offset + 8:offset + 8 + size]
        if len(chunk) != size:
            raise ValueError("Truncated WAV")
        if name == b"fmt ":
            fmt = struct.unpack_from("<HHIIHH", chunk)
        if name == b"data":
            audio = chunk
        offset += 8 + size + (size % 2)
    if fmt is None or audio is None or fmt[1] != 1 or fmt[2] != 16000:
        raise ValueError("Expected 16 kHz mono audio")
    if fmt[0] == 3 and fmt[5] == 32:
        return audio
    if fmt[0] == 1 and fmt[5] == 16:
        count = len(audio) // 2
        samples = struct.unpack(f"<{count}h", audio)
        return struct.pack(f"<{count}f", *(v / 32768.0 for v in samples))
    raise ValueError("Unsupported fixture encoding")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    root = parser.parse_args().root.resolve()
    cache = root if root.name == "com.taomni.app.qa" else root / "com.taomni.app.qa"
    model = cache / "taomni/models/whisper-base" / MODEL_SHA / "ggml-base.bin"
    model.parent.mkdir(parents=True, exist_ok=True)
    print("Preparing official Base weights (~148 MB) and English/Chinese WAVs", flush=True)
    download(MODEL_URL, model, MODEL_SHA)
    receipt = {"model_url": MODEL_URL, "model_sha256": digest(model), "audio": []}
    wav = root / "jfk.wav"
    download(WAV_URL, wav, WAV_SHA)
    if digest(ZH_FIXTURE) != ZH_SHA:
        raise ValueError("Bundled Chinese fixture SHA-256 mismatch")
    for name, source, provenance in [("jfk", wav, WAV_URL), ("zh", ZH_FIXTURE, "google/fleurs cmn_hans_cn test id=1906; see fixture README")]:
        pcm = pcm_f32(source)
        (root / f"{name}.f32").write_bytes(pcm)
        receipt["audio"].append({"name": name, "source": provenance, "sha256": digest(source), "seconds": len(pcm) / 64000})
    (root / "fixture.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
