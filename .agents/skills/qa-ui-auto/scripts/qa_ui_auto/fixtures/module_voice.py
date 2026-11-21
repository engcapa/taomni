"""Stage signed Local Voice and the verified speech fixture for the native case."""

import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import zipfile

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env

from .backup_policy import isolated_data_root
from .module_signed_archive import load_artifact, platform_key

CASE = "TC-MODULES-067"
SLUG = "ai-voice-local"


def setup(ctx):
    if ctx.case_id != CASE:
        raise RuntimeError(f"The signed Local Voice fixture belongs to {CASE}")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    root = Path(__file__).resolve().parents[6]
    manifest = json.loads((root / "src-tauri/plugins" / SLUG / "module.json").read_text(encoding="utf-8"))
    package = Path(os.environ["QA_SIGNED_LOCAL_VOICE_ROOT"])
    receipt, archive, signature, _ = load_artifact(package, source, platform_key(), SLUG, version=manifest["version"])
    host = manifest["entry"]["host"] + (".exe" if platform.system() == "Windows" else "")
    with zipfile.ZipFile(archive) as zipped, zipped.open(host) as executable:
        receipt["hostSha256"] = hashlib.file_digest(executable, "sha256").hexdigest()

    data = isolated_data_root(ctx)
    isolation = native_isolation_env(Path(ctx.report_root))
    cache = (Path(isolation["NEWMOB_CACHE_DIR"]) / QA_APP_ID
             if "NEWMOB_CACHE_DIR" in isolation else Path(isolation["XDG_CACHE_HOME"]))
    audio = Path(os.environ["QA_LOCAL_VOICE_AUDIO_ROOT"])
    inputs = json.loads((audio / "fixture.json").read_text(encoding="utf-8"))
    model = Path("taomni/models/whisper-base") / inputs["model_sha256"] / "ggml-base.bin"
    weights = audio / QA_APP_ID / model
    with weights.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != model.parent.name:
            raise RuntimeError("Local Voice model hash changed after preparation")
    (cache / model).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(weights, cache / model)

    data.mkdir(parents=True, exist_ok=True)
    pcm = data / "qa-local-voice.f32le"
    shutil.copyfile(audio / "jfk.f32", pcm)
    config = (Path(isolation["NEWMOB_CONFIG_DIR"]) / QA_APP_ID
              if "NEWMOB_CONFIG_DIR" in isolation else Path(isolation["XDG_CONFIG_HOME"]))
    config = config / "taomni/ai.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps({"asr": {"active": "whisper-base", "language": "en", "cleanup": "off"}}), encoding="utf-8")

    owned = Path(ctx.case_dir).resolve() / "signed-local-voice"
    owned.mkdir()
    destination = owned / archive.name
    shutil.copyfile(archive, destination)
    (owned / "provenance.json").write_text(json.dumps({
        **receipt, "inputs": inputs, "pcmSha256": hashlib.sha256(pcm.read_bytes()).hexdigest(),
    }, indent=2) + "\n", encoding="utf-8")
    ctx.values.update(
        local_voice_archive=destination.as_posix(),
        local_voice_signature=signature,
        local_voice_host=(data / "plugins" / SLUG / "versions" / manifest["version"] / host).as_posix(),
        local_voice_host_sha256=receipt["hostSha256"],
    )
