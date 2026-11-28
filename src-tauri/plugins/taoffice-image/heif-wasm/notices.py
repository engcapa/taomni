"""Write the locked Rust decoder and runtime license notices for packaging."""

import json
from pathlib import Path
import sys


def write_notices(metadata: Path, sysroot: Path) -> None:
    packages = json.loads(metadata.read_text(encoding="utf-8"))["packages"]
    for package in sorted(packages, key=lambda item: (item["name"], item["version"])):
        if package["source"] is None:
            continue
        name, version, license_id = package["name"], package["version"], package["license"]
        print(f"\n{name} {version} ({license_id})\nhttps://crates.io/crates/{name}/{version}")
        folder = Path(package["manifest_path"]).parent
        licenses = sorted(path for path in folder.iterdir() if path.is_file()
                          and path.name.startswith(("LICENSE", "COPYING", "NOTICE")))
        if not licenses:
            raise ValueError(f"{name} {version} has no license texts in its crate source")
        for path in licenses:
            print(f"\n{path.name}\n{path.read_text(encoding='utf-8')}")

    runtime = sysroot / "share" / "doc" / "rust"
    print("\nRust Standard Library and bundled runtime notices\nhttps://github.com/rust-lang/rust")
    for name in ("MIT", "APACHE"):
        path = next((runtime / "html" / "static.files").glob(f"LICENSE-{name}-*.txt"))
        print(f"\nLICENSE-{name}\n{path.read_text(encoding='utf-8')}")
    print((runtime / "COPYRIGHT-library.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    write_notices(Path(sys.argv[1]), Path(sys.argv[2]))
