mod filesystem;
mod html;
mod network;
mod windows_initialization;

use std::fs;
use std::path::PathBuf;

struct Fixture {
    _directory: tempfile::TempDir,
    path: PathBuf,
}

impl Fixture {
    fn new(name: &str, bytes: &[u8]) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(name);
        fs::write(&path, bytes).unwrap();
        Self {
            _directory: directory,
            path,
        }
    }

    fn path(&self) -> &str {
        self.path.to_str().unwrap()
    }
}
