"""Version identities for the signed lifecycle input packages."""
import re


MFA_LIFECYCLE_CASE = "TC-MODULES-103"


def lifecycle_versions(slug: str, current: str) -> tuple[str, str]:
    if slug == "hello-plugin" and current == "0.1.0":
        return "0.0.9", "0.1.1"
    if slug == "mfa" and re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", current):
        major, minor, patch = current.split(".")
        return current + "-qa.previous", f"{major}.{minor}.{int(patch) + 1}-qa.handshake-failure"
    raise ValueError(f"Unsupported lifecycle test version {slug}/{current}")
