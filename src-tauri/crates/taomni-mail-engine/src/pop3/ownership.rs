//! The receipt follows the account database in backups and completed migrations.

use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use super::super::database::mail_db_file_stem;

const VERSION: &[u8] = b"taomni-pop3-store-v1\n";

fn receipt(directory: &Path, account: &str) -> PathBuf {
    directory.join(format!("{}.pop3-owner", mail_db_file_stem(account)))
}

pub fn is_owned(directory: &Path, account: &str) -> io::Result<bool> {
    let path = receipt(directory, account);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() != VERSION.len() as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid POP3 ownership receipt",
        ));
    }
    let mut version = Vec::with_capacity(VERSION.len());
    File::open(path)?
        .take(VERSION.len() as u64 + 1)
        .read_to_end(&mut version)?;
    if version != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unknown POP3 ownership receipt",
        ));
    }
    Ok(true)
}

/// Called only after the full account cache has been durably staged.
pub fn mark_owned(directory: &Path, account: &str) -> io::Result<()> {
    if is_owned(directory, account)? {
        return Ok(());
    }
    let path = receipt(directory, account);
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(VERSION)?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(path) {
        Ok(_) => {
            #[cfg(unix)]
            File::open(directory)?.sync_all()?;
            Ok(())
        }
        Err(error)
            if error.error.kind() == io::ErrorKind::AlreadyExists
                && is_owned(directory, account)? =>
        {
            Ok(())
        }
        Err(error) => Err(error.error),
    }
}
