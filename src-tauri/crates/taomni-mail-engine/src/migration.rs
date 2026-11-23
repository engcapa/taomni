//! Stage a mailbox from the monolith's storage layout for the module.
//!
//! The upgrade coordinator owns the profile and must stop old mailbox writers
//! before staging. Only a coordinator may publish the staged data.

use std::{
    ffi::OsStr,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OpenFlags};
use taomni_sqlite_snapshot::{
    SnapshotControl, SnapshotOptions, SnapshotOutcome, snapshot_existing,
};

use crate::{archive::verify_message_with, database::mail_db_file_stem, storage::object_path};

pub struct LegacyMailbox {
    pub account_id: String,
    pub database: PathBuf,
    pub pop3: bool,
}

/// A core-only upgrade can retain an older signed Mail host. Only hand it
/// ownership of mailbox tables its installed manifest can actually write.
#[derive(Clone, Copy, Default)]
pub struct HostedMailboxData {
    pub drafts: bool,
    pub address_book: bool,
    pub agenda: bool,
    pub filter_rules: bool,
    pub pop3_cache: bool,
}

impl HostedMailboxData {
    pub const ALL: Self = Self {
        drafts: true,
        address_book: true,
        agenda: true,
        filter_rules: true,
        pop3_cache: true,
    };
}

/// Staging is scoped to one attempt. Dropping it discards every partial copy.
pub struct StagedMailData {
    directory: tempfile::TempDir,
    mailbox_count: usize,
}

impl StagedMailData {
    pub fn prepare(
        staging_root: &Path,
        mailboxes: &[LegacyMailbox],
        hosted: HostedMailboxData,
        control: &SnapshotControl,
    ) -> Result<Self, String> {
        check(control)?;
        if !directory_exists(staging_root)? {
            return Err("Mail migration staging directory is unavailable".into());
        }
        let staging_root = staging_root.canonicalize().map_err(string_error)?;
        let directory = tempfile::Builder::new()
            .prefix(".mail-upgrade-")
            .tempdir_in(staging_root)
            .map_err(string_error)?;
        let target = directory.path().join("data");
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&target).map_err(string_error)?;
        let mut mailbox_count = 0;
        for mailbox in mailboxes {
            check(control)?;
            if stage_account(mailbox, &target, hosted, control)? {
                mailbox_count += 1;
            }
        }
        sync_directories(&target, control)?;
        Ok(Self {
            directory,
            mailbox_count,
        })
    }

    pub fn data(&self) -> PathBuf {
        self.directory.path().join("data")
    }

    pub fn mailbox_count(&self) -> usize {
        self.mailbox_count
    }
}

fn stage_account(
    mailbox: &LegacyMailbox,
    target: &Path,
    hosted: HostedMailboxData,
    control: &SnapshotControl,
) -> Result<bool, String> {
    let stem = mail_db_file_stem(&mailbox.account_id);
    let filename = format!("{stem}.db");
    if mailbox.database.file_name() != Some(OsStr::new(&filename)) {
        return Err("Legacy Mail source does not belong to the account".into());
    }
    let Some(source) = resolve_database(&mailbox.database, &filename, control)? else {
        return Ok(false);
    };
    let source_root = source.parent().ok_or("Invalid legacy Mail database path")?;
    let destination = target.join(filename);
    if metadata(&destination)?.is_some() {
        return Err("Duplicate legacy Mail account".into());
    }
    match snapshot_existing(&source, &destination, &SnapshotOptions::default(), control)
        .map_err(string_error)?
    {
        SnapshotOutcome::Missing => return Err("Legacy Mail database disappeared".into()),
        SnapshotOutcome::Created(_) => {}
    }

    let db = Connection::open_with_flags(&destination, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(string_error)?;
    let cancellation = control.clone();
    db.progress_handler(1_000, Some(move || cancellation.check().is_err()))
        .map_err(string_error)?;
    copy_originals(
        &db,
        &mailbox.account_id,
        &stem,
        source_root,
        target,
        control,
    )?;
    copy_attachments(&stem, source_root, target, control)?;
    // Upgrade the snapshot's schema so the read-only host can open it. Some
    // old schema migrations read the original message objects during backfill.
    crate::cache::init_mail_tables(&db).map_err(string_error)?;
    if hosted.drafts {
        crate::draft_import::mark_owned(&db, &mailbox.account_id).map_err(string_error)?;
    }
    if hosted.address_book {
        crate::contacts::handoff::mark_owned(&db, &mailbox.account_id).map_err(string_error)?;
    }
    if hosted.agenda {
        crate::agenda::handoff::mark_owned(&db, &mailbox.account_id).map_err(string_error)?;
    }
    if hosted.filter_rules {
        crate::filters::rules::mark_owned(&db, &mailbox.account_id).map_err(string_error)?;
    }
    db.close().map_err(|(_, error)| string_error(error))?;
    OpenOptions::new()
        .write(true)
        .open(destination)
        .and_then(|file| file.sync_all())
        .map_err(string_error)?;
    if hosted.pop3_cache && mailbox.pop3 {
        crate::pop3::ownership::mark_owned(target, &mailbox.account_id).map_err(string_error)?;
    }
    check(control)?;
    Ok(true)
}

fn resolve_database(
    database: &Path,
    filename: &str,
    control: &SnapshotControl,
) -> Result<Option<PathBuf>, String> {
    let mut path = database.to_owned();
    for _ in 0..32 {
        check(control)?;
        let root = path.parent().ok_or("Invalid legacy Mail database path")?;
        match metadata(root)? {
            Some(metadata) if metadata.is_dir() => (),
            Some(_) => return Err("Legacy Mail storage path is not a directory".into()),
            None if path != database => {
                return Err("Legacy Mail relocation target is missing".into());
            }
            None => return Ok(None),
        }
        let redirect = crate::database::redirect_path(&path);
        if regular_file_exists(&redirect)? {
            const MAX_REDIRECT_BYTES: u64 = 64 * 1024;
            let mut bytes = Vec::new();
            open_file(&redirect)?
                .take(MAX_REDIRECT_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(string_error)?;
            if bytes.len() as u64 > MAX_REDIRECT_BYTES {
                return Err("Legacy Mail relocation record is too large".into());
            }
            let target: PathBuf = serde_json::from_slice(&bytes).map_err(string_error)?;
            if !target.is_absolute() || target.file_name() != Some(OsStr::new(filename)) {
                return Err("Invalid legacy Mail relocation target".into());
            }
            path = target;
            continue;
        }
        // SQLite rejects links in the entire filename. Resolve known platform
        // aliases in the parent, for example the macOS temporary directory.
        // The database and its sidecars still require individual checks.
        let root = root.canonicalize().map_err(string_error)?;
        let canonical_path = root.join(filename);
        let exists = regular_file_exists(&canonical_path)?;
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = root.join(format!("{filename}{suffix}"));
            if regular_file_exists(&sidecar)? && !exists {
                return Err("Legacy Mail database is missing with retained sidecars".into());
            }
        }
        if !exists && path != database {
            return Err("Legacy Mail relocation target is missing".into());
        }
        return Ok(exists.then_some(canonical_path));
    }
    Err("Legacy Mail relocation chain is too long or contains a cycle".into())
}

/// An explicitly installed module on an older modular profile may encounter
/// drafts in the desktop cache. Inspect the existing database and relocation
/// chain without initializing the account or changing its journal mode.
pub fn read_legacy_mailbox<T>(
    database: &Path,
    account: &str,
    read: impl FnOnce(&Connection, &str) -> rusqlite::Result<T>,
) -> Result<Option<T>, String> {
    let filename = format!("{}.db", mail_db_file_stem(account));
    let control = SnapshotControl::with_timeout(std::time::Duration::from_secs(5));
    let Some(path) = resolve_database(database, &filename, &control)? else {
        return Ok(None);
    };
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(string_error)?;
    let snapshot = db.unchecked_transaction().map_err(string_error)?;
    let result = read(&snapshot, account).map_err(string_error)?;
    snapshot.commit().map_err(string_error)?;
    Ok(Some(result))
}

fn copy_originals(
    database: &Connection,
    account: &str,
    stem: &str,
    source_root: &Path,
    target_root: &Path,
    control: &SnapshotControl,
) -> Result<(), String> {
    let has_index: bool = database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_full_messages')",
            [],
            |row| row.get(0),
        )
        .map_err(string_error)?;
    if !has_index {
        return Ok(());
    }
    let source = source_root.join(format!("{stem}.mail"));
    let target = target_root.join(format!("{stem}.mail"));
    let mut query = database
        .prepare("SELECT DISTINCT sha256, raw_size FROM mail_full_messages WHERE account_id=?1")
        .map_err(string_error)?;
    let mut objects = query.query([account]).map_err(string_error)?;
    while let Some(row) = objects.next().map_err(string_error)? {
        let hash: String = row.get(0).map_err(string_error)?;
        let raw_size = u64::try_from(row.get::<_, i64>(1).map_err(string_error)?)
            .map_err(|_| "Invalid size of the saved email")?;
        let previous = object_path(&source, &hash)?;
        let prefix = source.join("objects");
        for path in [&source, &prefix, &prefix.join(&hash[..2])] {
            if !directory_exists(path)? {
                return Err("A saved original email is missing from the legacy store".into());
            }
        }
        let staged = object_path(&target, &hash)?;
        copy_file(&previous, &staged, control)?;
        verify_message_with(open_file(&staged)?, &hash, raw_size, io::sink(), || {
            check(control)
        })?;
    }
    Ok(())
}

fn copy_attachments(
    stem: &str,
    source_root: &Path,
    target_root: &Path,
    control: &SnapshotControl,
) -> Result<(), String> {
    let attachments = source_root.join("attachments");
    let source = attachments.join(stem);
    if !directory_exists(&attachments)? || !directory_exists(&source)? {
        return Ok(());
    }
    let target = target_root.join("attachments").join(stem);
    for folder in fs::read_dir(source).map_err(string_error)? {
        check(control)?;
        let folder = folder.map_err(string_error)?;
        if !directory_exists(&folder.path())? {
            continue;
        }
        for entry in fs::read_dir(folder.path()).map_err(string_error)? {
            check(control)?;
            let entry = entry.map_err(string_error)?;
            let path = entry.path();
            if path.extension().is_some_and(|extension| extension == "bin") {
                let destination = target.join(folder.file_name()).join(entry.file_name());
                copy_file(&path, &destination, control)?;
            }
        }
    }
    Ok(())
}

/// A core-only upgrade can leave old attachment bytes in the account's
/// custom storage directory. Open a single regular file from that layout.
pub fn legacy_attachment(
    db: &Connection,
    account: &str,
    folder: &str,
    uid: u32,
    part: &str,
) -> Result<Option<File>, String> {
    let root = Path::new(db.path().ok_or("Missing Mail database path")?)
        .parent()
        .ok_or("Missing Mail storage directory")?;
    let relative = crate::attachment_cache::attachment_cache_path(
        Path::new(""),
        &mail_db_file_stem(account),
        folder,
        uid,
        part,
    );
    let mut parent = root.to_owned();
    for component in relative
        .parent()
        .ok_or("Invalid Mail cache directory")?
        .components()
    {
        let std::path::Component::Normal(name) = component else {
            return Err("Invalid Mail attachment directory".into());
        };
        parent.push(name);
        if !directory_exists(&parent)? {
            return Ok(None);
        }
    }
    let path = root.join(relative);
    if regular_file_exists(&path)? {
        open_file(&path).map(Some)
    } else {
        Ok(None)
    }
}

fn copy_file(source: &Path, target: &Path, control: &SnapshotControl) -> Result<(), String> {
    let mut input = open_file(source)?;
    let parent = target.parent().ok_or("Invalid Mail staging path")?;
    fs::create_dir_all(parent).map_err(string_error)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(string_error)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        check(control)?;
        let read = input.read(&mut buffer).map_err(string_error)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read]).map_err(string_error)?;
    }
    output.sync_all().map_err(string_error)
}

fn check(control: &SnapshotControl) -> Result<(), String> {
    control.check().map_err(string_error)
}

fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if linked(&metadata) => Err("Legacy Mail path is a symbolic link".into()),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn directory_exists(path: &Path) -> Result<bool, String> {
    Ok(metadata(path)?.is_some_and(|metadata| metadata.is_dir()))
}

fn regular_file_exists(path: &Path) -> Result<bool, String> {
    match metadata(path)? {
        Some(metadata) if metadata.is_file() => Ok(true),
        Some(_) => Err("Legacy Mail input is not a regular file".into()),
        None => Ok(false),
    }
}

fn open_file(path: &Path) -> Result<File, String> {
    if !regular_file_exists(path)? {
        return Err("A legacy Mail file is missing".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(string_error)?;
    let actual = file.metadata().map_err(string_error)?;
    if !actual.is_file() || linked(&actual) {
        return Err("Legacy Mail input is not a regular file".into());
    }
    Ok(file)
}

fn linked(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn sync_directories(path: &Path, control: &SnapshotControl) -> Result<(), String> {
    check(control)?;
    #[cfg(unix)]
    {
        for entry in fs::read_dir(path).map_err(string_error)? {
            check(control)?;
            let entry = entry.map_err(string_error)?;
            if entry.file_type().map_err(string_error)?.is_dir() {
                sync_directories(&entry.path(), control)?;
            }
        }
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(string_error)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    check(control)
}

#[cfg(test)]
#[path = "migration_tests.rs"]
mod tests;
