"""Give each browser peer an immutable snapshot of the production phone bundle."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


@contextmanager
def bundle_lock(root):
    # Vite empties the shared output directory. Lock across build AND snapshot;
    # running servers must never serve that mutable directory directly.
    key = hashlib.sha256(str(Path(root).resolve()).encode()).hexdigest()
    path = Path(tempfile.gettempdir()) / f'taomni-qa-mobile-build-{key}.lock'
    with path.open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            if lock.tell() == 0:
                lock.write(b'0')
                lock.flush()
            while True:
                lock.seek(0)
                try:
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    time.sleep(0.1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def build_snapshot(root, case_dir):
    snapshot = tempfile.TemporaryDirectory(prefix='taomni-qa-mobile-assets-')
    try:
        with bundle_lock(root):
            build = subprocess.run([shutil.which('pnpm') or 'pnpm', 'build:mobile'], cwd=root,
                                   capture_output=True, text=True, timeout=120)
            (Path(case_dir) / 'mobile-build.log').write_text(build.stdout + build.stderr, encoding='utf-8')
            if build.returncode:
                raise RuntimeError('Mobile bundle build failed; see mobile-build.log')
            source = Path(root) / 'src-tauri/resources/mobile-web'
            if not (source / 'index.html').is_file() or not (source / 'assets').is_dir():
                raise RuntimeError('Mobile bundle is incomplete after successful build')
            shutil.copytree(source, snapshot.name, dirs_exist_ok=True)
        return snapshot
    except BaseException:
        snapshot.cleanup()
        raise
