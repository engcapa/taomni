"""Exact user-reported Markdown; optionally read the original on a local QA host.

The external source is only opened for viewing/export. Editing tests use the
owned copy. Record and compare source hashes before/after, including failures.
"""
import hashlib
import json
import os
from pathlib import Path
from . import file_open_files

SOURCE_SHA = "c669a35a1cc8ec37aba798b496fa5b6c8c6405118079482bcaec03ee4c27f900"


def setup(ctx):
    file_open_files.setup(ctx)
    data = (Path(__file__).parent / "data/markdown-testing.md").read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA:
        raise RuntimeError("Reported Markdown fixture changed")
    root = ctx.values["file_open_root"]
    native = ctx.cfg["app"]["mode"] == "native"
    original = os.environ.get("TAOMNI_QA_MARKDOWN_SOURCE_FILE", "") if native else ""
    if original:
        path = Path(original).resolve(strict=True)
        if path.read_bytes() != data:
            raise RuntimeError("Local original does not match the reported Markdown")
    else:
        path = Path(root) / "testing.md"
    if native:
        (Path(root) / "testing.md").write_bytes(data)
        (Path(root) / "exports").mkdir(exist_ok=True)
    else:
        ctx.page.evaluate("""async ({root, bytes}) => {
          const vfs = await import('/src/stubs/localVfs.ts');
          await vfs.vfsWriteBytes(root + '/testing.md', new Uint8Array(bytes).buffer);
        }""", {"root": root, "bytes": list(data)})
    ctx.values.update(markdown_testing_directory=str(path.parent) if native else root,
                      markdown_testing_filename=path.name if native else "testing.md",
                      markdown_testing_source=str(path) if native else root + "/testing.md",
                      markdown_testing_exports=root + "/exports", markdown_testing_sha=SOURCE_SHA)
    ctx._markdown_testing_record = dict(path=ctx.values["markdown_testing_source"],
                                       original=bool(original), beforeSha256=SOURCE_SHA)
    _record(ctx)


def _record(ctx):
    (ctx.case_dir / "reported-markdown-source.json").write_text(
        json.dumps(ctx._markdown_testing_record, ensure_ascii=False, indent=2), encoding="utf-8")


def teardown(ctx):
    if hasattr(ctx, "_markdown_testing_record"):
        if ctx.cfg["app"]["mode"] == "native":
            data = Path(ctx.values["markdown_testing_source"]).read_bytes()
        else:
            data = bytes(ctx.page.evaluate("""async path => {
              const vfs = await import('/src/stubs/localVfs.ts');
              return Array.from(new Uint8Array(await vfs.vfsReadBytes(path)));
            }""", ctx.values["markdown_testing_source"]))
        actual = hashlib.sha256(data).hexdigest()
        ctx._markdown_testing_record.update(afterSha256=actual, unchanged=actual == SOURCE_SHA)
        _record(ctx)
        if actual != SOURCE_SHA:
            raise RuntimeError("Viewing/export changed the reported Markdown")
    file_open_files.teardown(ctx)
