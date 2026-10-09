"""Verify the owned native desktop before expensive compilation/unit contracts."""
import argparse
import json
from pathlib import Path

from ci_desktop import Desktop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--capabilities", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    with Desktop(args.report, json.loads(args.capabilities), args.profile) as desktop:
        print(json.dumps(desktop.facts, indent=2), flush=True)


if __name__ == "__main__":
    main()
