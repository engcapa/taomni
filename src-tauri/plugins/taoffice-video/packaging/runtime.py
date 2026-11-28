"""Pinned, relocatable FFmpeg runtime used by the TaOffice Media host."""

import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

VCPKG_REVISION = "ba33ef1a2fb3c6519e819cd767bb8fd1677f1323"
VCPKG_REPOSITORY = "https://github.com/microsoft/vcpkg.git"
FFMPEG_ARCHIVE = "ffmpeg-ffmpeg-n9.1.tar.gz"
FFMPEG_SHA512 = (
    "07f011a15b40b3620dddd438be595952858c10868c799a50fda2adc14dbf605a47fe"
    "2819db387d9bf6fbf960b7182b6f1648bd933b5bf62f6f6db7153a0fe822"
)
FFMPEG_FEATURES = "avcodec,avformat,swscale,swresample,vpx,opus,openh264"
PORTS = ("ffmpeg", "libvpx", "opus", "openh264")
PLATFORMS = {
    "linux-x86_64": "x64-linux",
    "windows-x86_64": "x64-windows",
    "darwin-x86_64": "x64-osx",
    "darwin-aarch64": "arm64-osx",
}
LIBRARIES = {
    "avcodec": 63,
    "avformat": 63,
    "avutil": 61,
    "swresample": 7,
    "swscale": 10,
}
LICENSE_DIR = Path("licenses/media")
SOURCE = Path(__file__).resolve().parent / "SOURCE.md"
HOST = "taomni-plugin-taoffice-video"
MAX_PAYLOAD_BYTES = 100 * 1024 * 1024


def work_dir():
    default = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "taoffice-media-runtime"
    return Path(os.environ.get("TAOFFICE_MEDIA_BUILD_DIR", default)).resolve()


def triplet(platform):
    return "taoffice-" + PLATFORMS[platform]


def prefix(platform):
    return work_dir() / "installed" / triplet(platform)


def runtime_libraries(platform):
    for name, major in LIBRARIES.items():
        if platform.startswith("windows-"):
            yield f"{name}-{major}.dll"
        elif platform.startswith("darwin-"):
            yield f"lib{name}.{major}.dylib"
        else:
            yield f"lib{name}.so.{major}"


def runtime_files(platform):
    return [
        *runtime_libraries(platform),
        *((LICENSE_DIR / f"{port}.txt").as_posix() for port in PORTS),
        (LICENSE_DIR / "SOURCE.md").as_posix(),
        (LICENSE_DIR / FFMPEG_ARCHIVE).as_posix(),
    ]


def verify_source(path):
    digest = hashlib.sha512()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != FFMPEG_SHA512:
        raise ValueError("FFmpeg source archive does not match the pinned vcpkg recipe.")


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def output(*args):
    return subprocess.check_output(args, text=True)
