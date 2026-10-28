"""Run a historical QA builder with the same source identity rules as the probe.

The historical product, build recipe and configuration stay untouched. Loading
the measurement runner's provenance first makes additions to its input boundary
(such as dependency patches) consistent for both build and measurement.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import runpy
import sys

from qa_ui_auto import provenance  # noqa: F401 -- retain this module in sys.modules


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True)
    args = parser.parse_args()
    checkout = args.checkout.resolve()
    scripts = checkout / ".agents/skills/qa-ui-auto/scripts"
    builder = scripts / "native_build.py"
    os.chdir(checkout)
    sys.path.insert(0, str(scripts))
    sys.argv = [str(builder), "--release"]
    runpy.run_path(str(builder), run_name="__main__")


if __name__ == "__main__":
    main()
