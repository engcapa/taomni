"""Deterministic gzip and TAR inputs for the shared archive viewer."""
import gzip
import io
import tarfile


def archives(text: bytes, image: bytes) -> dict[str, bytes]:
    def create(unsafe: bool) -> bytes:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, data in [("./notes/readme.txt", text), ("images/pixel.png", image)]:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if unsafe:
                link = tarfile.TarInfo("unsafe-link")
                link.type = tarfile.SYMTYPE
                link.linkname = "../notes.txt"
                archive.addfile(link)
        return gzip.compress(buffer.getvalue(), mtime=0)

    return {"quarterly.TAR.GZ": create(False), "unsafe.tgz": create(True)}


def compressed_text(text: bytes) -> bytes:
    return gzip.compress(text, mtime=0)
