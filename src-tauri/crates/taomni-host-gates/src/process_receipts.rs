//! Process-tree fixture evidence. Each process publishes its own complete file;
//! independent processes must never append formatted fragments to one receipt.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn directory(base: &Path) -> PathBuf {
    base.with_extension("receipts")
}

pub fn record(base: &Path, role: &str, pid: u32) -> io::Result<()> {
    if !matches!(role, "host" | "hello" | "child" | "grandchild") || pid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid process identity",
        ));
    }
    let directory = directory(base);
    fs::create_dir_all(&directory)?;
    let name = format!("{role}-{pid}");
    let partial = directory.join(format!(".{name}.partial"));
    fs::write(&partial, format!("{role} {pid}\n"))?;
    fs::rename(partial, directory.join(format!("{name}.txt")))
}

pub fn read(base: &Path) -> io::Result<Vec<(String, u32)>> {
    let entries = match fs::read_dir(directory(base)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut receipts = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_none_or(|extension| extension != "txt") {
            continue;
        }
        let value = fs::read_to_string(&path)?;
        let parsed = value.strip_suffix('\n').and_then(|line| {
            let (role, pid) = line.split_once(' ')?;
            let pid = pid.parse::<u32>().ok()?;
            (pid != 0
                && matches!(role, "host" | "hello" | "child" | "grandchild")
                && path.file_stem()?.to_str()? == format!("{role}-{pid}"))
            .then(|| (role.to_owned(), pid))
        });
        receipts.push(parsed.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid PID receipt: {}", path.display()),
            )
        })?);
    }
    receipts.sort();
    Ok(receipts)
}

#[cfg(test)]
#[path = "process_receipts_tests.rs"]
mod tests;
