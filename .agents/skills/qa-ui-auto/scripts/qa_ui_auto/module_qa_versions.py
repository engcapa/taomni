"""Version identities for the signed lifecycle input packages."""
import re


MFA_LIFECYCLE_CASE = "TC-MODULES-103"
SERVERS_LIFECYCLE_CASE = "TC-MODULES-107"
SOCKSCAP_LIFECYCLE_CASE = "TC-MODULES-108"
SCREENSHOT_LIFECYCLE_CASE = "TC-MODULES-109"
VOICE_LIFECYCLE_CASE = "TC-MODULES-110"
MAIL_LIFECYCLE_CASE = "TC-MODULES-111"
VNC_CLIENT_LIFECYCLE_CASE = "TC-MODULES-112"
RDP_CLIENT_LIFECYCLE_CASE = "TC-MODULES-113"
RDP_SERVER_LIFECYCLE_CASE = "TC-MODULES-114"
VNC_SERVER_LIFECYCLE_CASE = "TC-MODULES-115"

OFFICIAL_LIFECYCLE_SLUGS = frozenset({
    "ai-voice-local",
    "mail",
    "mfa",
    "rdp-client",
    "rdp-server",
    "screenshot",
    "servers",
    "sockscap",
    "vnc-client",
    "vnc-server",
})

LIFECYCLE_CASES = {
    MFA_LIFECYCLE_CASE: "mfa",
    SERVERS_LIFECYCLE_CASE: "servers",
    SOCKSCAP_LIFECYCLE_CASE: "sockscap",
    SCREENSHOT_LIFECYCLE_CASE: "screenshot",
    VOICE_LIFECYCLE_CASE: "ai-voice-local",
    MAIL_LIFECYCLE_CASE: "mail",
    VNC_CLIENT_LIFECYCLE_CASE: "vnc-client",
    RDP_CLIENT_LIFECYCLE_CASE: "rdp-client",
    RDP_SERVER_LIFECYCLE_CASE: "rdp-server",
    VNC_SERVER_LIFECYCLE_CASE: "vnc-server",
}


def lifecycle_versions(slug: str, current: str) -> tuple[str, str]:
    if slug == "hello-plugin" and current == "0.1.0":
        return "0.0.9", "0.1.1"
    if slug in OFFICIAL_LIFECYCLE_SLUGS and re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", current):
        major, minor, patch = current.split(".")
        return current + "-qa.previous", f"{major}.{minor}.{int(patch) + 1}-qa.handshake-failure"
    raise ValueError(f"Unsupported lifecycle test version {slug}/{current}")
