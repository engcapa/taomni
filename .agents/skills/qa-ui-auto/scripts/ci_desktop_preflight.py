"""Verify the owned native desktop before expensive compilation/unit contracts."""
import argparse
import json
from pathlib import Path
import subprocess

from ci_desktop import Desktop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--capabilities", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    with Desktop(args.report, json.loads(args.capabilities), args.profile) as desktop:
        if args.profile == "ubuntu-26.04-wayland":
            # Gio is provided by the distro Python. The main CI Python may be
            # setup-python's interpreter without the system GI module.
            probe = Path(__file__).with_name("ci_wayland_portal_probe.py")
            result = subprocess.check_output(["/usr/bin/python3", "-c",
                "import json,sys; from pathlib import Path; "
                "from ci_wayland_portal_probe import verify_portals; "
                "print(json.dumps(verify_portals(Path(sys.argv[1]),remote_desktop=sys.argv[2]=='true')))",
                str(args.report.resolve()), "true" if "rdp" in desktop.capabilities else "false"],
                cwd=probe.parent, text=True, timeout=180)
            desktop.facts["portal_requests"] = json.loads(result)
        print(json.dumps(desktop.facts, indent=2), flush=True)


if __name__ == "__main__":
    main()
