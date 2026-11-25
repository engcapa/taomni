"""Deterministic child of the installed application's real PTY."""
import os
import sys
import tty

tty.setraw(sys.stdin.fileno())
sys.stdout.write("AC13-READY\n")
for line in sys.stdin:
    if line.startswith("ping-"):
        sys.stdout.write("ACK-" + line[5:])
    elif line == "burst\n":
        sys.stdout.write("x" * 1_048_576 + "AC13-END\n")
    else:
        raise RuntimeError("Unexpected synthetic PTY request")
    sys.stdout.flush()
