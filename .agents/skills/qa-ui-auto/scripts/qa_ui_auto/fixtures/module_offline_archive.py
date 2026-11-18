"""An untrusted local module archive, retained inside this case's report.

This fixture never supplies a trusted key or changes the product trust root.
Browser mode uses the same input to prove a truthful renderer rejection;
native mode reaches the real file and signature boundary.
"""

from base64 import b64encode
from pathlib import Path
import tempfile


def setup(ctx):
    root = Path(ctx.case_dir).parent.resolve() / "module-offline-archives"
    root.mkdir(parents=True, exist_ok=True)
    owned = Path(tempfile.mkdtemp(prefix="untrusted-", dir=root))
    archive = owned / "untrusted.taomni-plugin"
    archive.write_bytes(b"untrusted fixture; overwritten by the testcase\n")
    # Structurally shaped as minisign, with a zero key ID and invalid signature.
    # It cannot pass the key embedded in the application binary.
    signature = (
        "untrusted comment: negative module installation fixture\n"
        + b64encode(b"ED" + bytes(8) + bytes(64)).decode("ascii")
        + "\ntrusted comment: id=taomni-plugin-untrusted version=1.0.0 "
        "platform=linux-x86_64 coreApiVersion=1 sha256=" + "0" * 64
        + "\n" + b64encode(bytes(64)).decode("ascii") + "\n"
    )
    signature_path = owned / "untrusted.minisig"
    signature_path.write_text(signature, encoding="utf-8")
    ctx.values.update(module_untrusted_archive=archive.as_posix(), module_untrusted_signature=signature,
                      module_untrusted_signature_path=signature_path.as_posix())
