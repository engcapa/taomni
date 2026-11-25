"""Stage the Windows libraries supplied beside the Local Voice host."""

from pathlib import Path
from shutil import copyfile

WINDOWS_RUNTIME = (
    "sherpa-onnx-c-api.dll",
    "sherpa-onnx-cxx-api.dll",
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll",
)


def runtime_files(slug, platform):
    return WINDOWS_RUNTIME if (slug, platform) == ("ai-voice-local", "windows-x86_64") else ()


def stage_runtime(slug, platform, binaries: Path, payload: Path):
    for name in runtime_files(slug, platform):
        copyfile(binaries / name, payload / name)


def verify_runtime(slug, platform, payload: Path):
    for name in runtime_files(slug, platform):
        library = payload / name
        if not library.is_file() or not library.stat().st_size:
            raise ValueError(f"Missing Local Voice runtime library: {name}")
