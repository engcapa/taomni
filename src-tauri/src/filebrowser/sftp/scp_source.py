# Resumable SCP source. The initial transfer uses the host's scp binary; this
# source implements the same file/ack framing for a verified suffix on retry.
# Arguments are JSON, never interpolated into executable shell source.
import hashlib
import json
import os
import sys


def send(data):
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def ack():
    if sys.stdin.buffer.read(1) != b"\0":
        raise ValueError("SCP receiver did not acknowledge")


try:
    path, offset, expected = json.loads(sys.argv[1])
    with open(path, "rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else None
        if digest is None:
            source.seek(0)
            checksum = hashlib.sha256()
            for block in iter(lambda: source.read(262144), b""):
                checksum.update(block)
            digest = checksum.hexdigest()
        size = os.fstat(source.fileno()).st_size
        if digest != expected or not 0 <= offset <= size:
            raise ValueError("Remote file changed before SCP resume")
        source.seek(offset)
        ack()
        send(("C0644 %d payload\n" % (size - offset)).encode())
        ack()
        remaining = size - offset
        while remaining:
            block = source.read(min(262144, remaining))
            if not block:
                raise ValueError("Remote file shrank during SCP resume")
            send(block)
            remaining -= len(block)
        send(b"\0")
        ack()
except Exception as error:
    send(b"\2" + str(error).replace("\n", " ").encode() + b"\n")
    sys.exit(1)
