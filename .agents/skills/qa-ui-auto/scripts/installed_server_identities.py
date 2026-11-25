"""Exercise the two services' legacy identity files in an isolated installed profile."""
from datetime import datetime, timedelta, timezone
import os

from modular_bundle_inventory import digest
from qa_ui_auto.module_retained_observation import ordinary

# Both sides use the actual monolith and module storage layouts.
FILES = {
    "rdp-server/cert.pem": "plugins/rdp-server/data/cert.pem",
    "rdp-server/key.pem": "plugins/rdp-server/data/key.pem",
    "ssh-server/host_ed25519": "plugins/servers/data/host_ed25519",
}


def seed(profile):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, ed25519
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=7))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
            .sign(key, hashes.SHA256()))
    pem = serialization.Encoding.PEM
    plain = serialization.NoEncryption()
    fixtures = {
        "rdp-server/cert.pem": cert.public_bytes(pem),
        "rdp-server/key.pem": key.private_bytes(pem, serialization.PrivateFormat.PKCS8, plain),
        "ssh-server/host_ed25519": ed25519.Ed25519PrivateKey.generate().private_bytes(
            pem, serialization.PrivateFormat.OpenSSH, plain,
        ),
    }
    # If the original already started a service, keep its complete identity.
    if (profile / "rdp-server/cert.pem").exists() != (profile / "rdp-server/key.pem").exists():
        raise RuntimeError("The legacy RDP TLS identity is incomplete")
    for relative, content in fixtures.items():
        path = profile / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
        ordinary(path)
    return {legacy: digest(profile / legacy) for legacy in FILES}


def verify(profile, original):
    receipts = {}
    for legacy, target in FILES.items():
        expected = original[legacy]
        for relative in (legacy, target):
            path = profile / relative
            ordinary(path)
            actual = digest(path)
            if actual != expected:
                raise RuntimeError(f"Installed server identity differs from its legacy input: {relative}")
            receipts[relative] = actual
    return receipts
