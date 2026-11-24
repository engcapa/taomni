//! A durable account receipt selects the live IMAP store after offline migration.

use std::{
    fs::{self, File, Metadata},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use crate::database::mail_db_file_stem;

pub const RECEIPT_SUFFIX: &str = ".imap-owner";

fn receipt(directory: &Path, account: &str) -> (PathBuf, String) {
    let stem = mail_db_file_stem(account);
    (
        directory.join(format!("{stem}{RECEIPT_SUFFIX}")),
        format!("taomni-imap-store-v1\n{stem}\n"),
    )
}

/// The receipt is only usable together with its ordinary account database.
pub fn database(directory: &Path, account: &str) -> io::Result<Option<PathBuf>> {
    let (receipt, expected) = receipt(directory, account);
    let metadata = match fs::symlink_metadata(&receipt) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !ordinary_file(&metadata) || metadata.len() != expected.len() as u64 {
        return Err(invalid("Invalid IMAP mailbox ownership receipt"));
    }
    let mut contents = Vec::with_capacity(expected.len());
    File::open(&receipt)?
        .take(expected.len() as u64 + 1)
        .read_to_end(&mut contents)?;
    if contents != expected.as_bytes() {
        return Err(invalid(
            "IMAP mailbox ownership receipt belongs to another account",
        ));
    }
    let database = directory.join(format!("{}.db", mail_db_file_stem(account)));
    require_database(&database)?;
    Ok(Some(database))
}

pub(crate) fn require_database(database: &Path) -> io::Result<()> {
    if !ordinary_file(&fs::symlink_metadata(database)?) {
        return Err(invalid("Owned IMAP mailbox must be an ordinary database"));
    }
    match fs::symlink_metadata(crate::database::redirect_path(database)) {
        Ok(_) => Err(invalid(
            "Owned IMAP mailbox cannot redirect outside its module",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Call only while preparing a complete offline account snapshot.
pub fn mark_owned(directory: &Path, account: &str) -> io::Result<()> {
    if database(directory, account)?.is_some() {
        return Ok(());
    }
    require_database(&directory.join(format!("{}.db", mail_db_file_stem(account))))?;
    let (target, expected) = receipt(directory, account);
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(expected.as_bytes())?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(target) {
        Ok(_) => {
            #[cfg(unix)]
            File::open(directory)?.sync_all()?;
            Ok(())
        }
        Err(error)
            if error.error.kind() == io::ErrorKind::AlreadyExists
                && database(directory, account)?.is_some() =>
        {
            Ok(())
        }
        Err(error) => Err(error.error),
    }
}

fn ordinary_file(metadata: &Metadata) -> bool {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.nlink() == 1
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 == 0
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
