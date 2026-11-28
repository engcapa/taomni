//! A private sibling directory owns the checkpoints and the tree to publish.
use super::codec::Cancellable;
use super::{Entry, MAX_ARCHIVE, MAX_ENTRY, invalid};
use crate::viewer::filesystem::open_regular;
use crate::viewer::paths::{ScopedRoot, absolute, display};
use rars::ReadCancellation;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

mod identity;
use identity::{Identity, directory_exists, sync_directory};

const TREE: &str = "files";
const BUFFER: usize = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) struct Source {
    path: PathBuf,
    identity: Identity,
    size: u64,
    sha256: [u8; 32],
}

impl Source {
    pub(super) fn open(path: &str, cancel: &ReadCancellation) -> Result<(Self, File), String> {
        let (canonical, mut file, meta) = open_regular(path)?;
        if meta.len() > MAX_ARCHIVE {
            return Err(invalid("Archive input exceeds 64 MiB"));
        }
        let identity = Identity::of(&file).map_err(invalid)?;
        let sha256 = digest(
            &mut Cancellable::new(&mut file, cancel),
            meta.len(),
            io::sink(),
        )?;
        file.seek(SeekFrom::Start(0)).map_err(invalid)?;
        Ok((
            Self {
                path: canonical,
                identity,
                size: meta.len(),
                sha256,
            },
            file,
        ))
    }

    pub(super) fn size(&self) -> u64 {
        self.size
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Target {
    pub(super) directory: PathBuf,
    identity: Identity,
}

impl Target {
    pub(super) fn new(path: &str) -> Result<Self, String> {
        let directory = absolute(path)?;
        let identity = Identity::at(&directory)?;
        if !directory_exists(&directory)? {
            return Err(invalid("The extraction destination is missing"));
        }
        Ok(Self {
            directory,
            identity,
        })
    }

    fn verify(&self) -> Result<(), String> {
        self.identity
            .verify(&self.directory, "The extraction destination has changed")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct StageStamp {
    name: String,
    identity: Identity,
    tree: Identity,
}

impl StageStamp {
    pub(super) fn clean(&self, target: &Target) -> Result<(), String> {
        target.verify()?;
        let path = target.directory.join(&self.name);
        if directory_exists(&path)? {
            self.identity
                .verify(&path, "The extraction staging directory has changed")?;
            fs::remove_dir_all(path).map_err(invalid)?;
            sync_directory(&target.directory).map_err(invalid)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Publication {
    output_name: String,
    payload_identity: Identity,
}

impl Publication {
    pub(super) fn recovered(&self, target: &Target) -> Result<Option<String>, String> {
        target.verify()?;
        let path = target.directory.join(&self.output_name);
        Ok((Identity::at(&path).ok() == Some(self.payload_identity)).then(|| display(&path)))
    }
}

#[derive(Debug, Eq, PartialEq, Serialize, Deserialize)]
struct Checkpoint {
    name: String,
    size: u64,
    sha256: [u8; 32],
}

pub(super) struct Stage {
    path: PathBuf,
    wrapper: ScopedRoot,
    tree: ScopedRoot,
}

impl Stage {
    pub(super) fn allocate(target: &Target) -> Result<(tempfile::TempDir, StageStamp), String> {
        target.verify()?;
        let mut builder = tempfile::Builder::new();
        builder.prefix(".taomni-extract-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o700));
        }
        let dir = builder.tempdir_in(&target.directory).map_err(invalid)?;
        let stamp = Self::initialize(&dir, target)?;
        Ok((dir, stamp))
    }

    fn initialize(dir: &tempfile::TempDir, target: &Target) -> Result<StageStamp, String> {
        target.verify()?;
        let path = dir.path();
        let tree = path.join(TREE);
        fs::create_dir(&tree).map_err(invalid)?;
        sync_directory(path).map_err(invalid)?;
        sync_directory(&target.directory).map_err(invalid)?;
        let stamp = StageStamp {
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            identity: Identity::at(path)?,
            tree: Identity::at(&tree)?,
        };
        target.verify()?;
        Ok(stamp)
    }

    pub(super) fn open(target: &Target, stamp: &StageStamp) -> Result<Self, String> {
        target.verify()?;
        let path = target.directory.join(&stamp.name);
        stamp
            .identity
            .verify(&path, "The extraction staging directory has changed")?;
        let tree_path = path.join(TREE);
        stamp
            .tree
            .verify(&tree_path, "The extraction output tree has changed")?;
        let wrapper = ScopedRoot::new(&path)?;
        let tree = ScopedRoot::new(&tree_path)?;
        stamp
            .identity
            .verify(&path, "The extraction staging directory has changed")?;
        stamp
            .tree
            .verify(&tree_path, "The extraction output tree has changed")?;
        Ok(Self {
            path,
            wrapper,
            tree,
        })
    }

    fn checkpoint(&self, entry: &Entry) -> PathBuf {
        self.path.join(format!("{}.json", entry.index))
    }

    pub(super) fn write(
        &self,
        entry: &Entry,
        reader: &mut dyn Read,
        mut progress: impl FnMut(u64),
    ) -> Result<(), String> {
        if entry.directory {
            return self.tree.create_directory(&entry.name);
        }
        let checkpoint = self.checkpoint(entry);
        let path = self.tree.path.join(&entry.name);
        if let Some(previous) = read_json::<Checkpoint>(&checkpoint)? {
            if previous.name != entry.name || previous.size != entry.size {
                return Err(invalid(
                    "An extraction checkpoint no longer matches the archive",
                ));
            }
            match fs::symlink_metadata(&path) {
                Ok(_) => {
                    let mut staged = self.tree.open(&entry.name)?;
                    let observed = digest(&mut staged, entry.size, io::sink())?;
                    let archived = digest(reader, entry.size, io::sink())?;
                    if observed != previous.sha256 || archived != previous.sha256 {
                        return Err(invalid("A staged archive member has changed"));
                    }
                    progress(entry.size);
                    return Ok(());
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(invalid(error)),
            }
        }
        if let Some((parent, _)) = entry.name.rsplit_once('/') {
            self.tree.create_directory(parent)?;
        }
        let scratch_name = format!("{}.part", Uuid::new_v4().simple());
        let mut scratch = self.wrapper.create(&scratch_name).map_err(invalid)?;
        let result = (|| {
            let sha256 = digest(
                reader,
                entry.size,
                Progress {
                    output: &mut scratch,
                    update: &mut progress,
                },
            )?;
            scratch.sync_all().map_err(invalid)?;
            save_json(
                &checkpoint,
                &Checkpoint {
                    name: entry.name.clone(),
                    size: entry.size,
                    sha256,
                },
            )?;
            drop(scratch);
            self.wrapper
                .rename_into(&scratch_name, &self.tree, &entry.name)
                .map_err(invalid)?;
            sync_directory(path.parent().unwrap()).map_err(invalid)?;
            Ok(())
        })();
        if result.is_err() {
            self.wrapper.remove_created(&scratch_name);
        }
        result
    }

    pub(super) fn verify<'a>(
        &self,
        entries: impl Iterator<Item = &'a Entry>,
        cancel: &ReadCancellation,
    ) -> Result<(), String> {
        let mut directories = HashSet::new();
        let mut files = HashSet::new();
        for entry in entries {
            if cancel.is_cancelled() {
                return Err(invalid("Extraction cancelled"));
            }
            let relative = Path::new(&entry.name);
            for parent in relative
                .ancestors()
                .skip(1)
                .filter(|value| !value.as_os_str().is_empty())
            {
                directories.insert(parent.to_owned());
            }
            if entry.directory {
                directories.insert(relative.to_owned());
                continue;
            }
            let checkpoint = read_json::<Checkpoint>(&self.checkpoint(entry))?
                .ok_or_else(|| invalid("An archive member is missing its checkpoint"))?;
            let file = self.tree.open(&entry.name)?;
            let observed = digest(&mut Cancellable::new(file, cancel), entry.size, io::sink())?;
            if checkpoint.name != entry.name
                || checkpoint.size != entry.size
                || checkpoint.sha256 != observed
            {
                return Err(invalid("A staged archive member has changed"));
            }
            if !files.insert(relative.to_owned()) {
                return Err(invalid("Duplicate archive member name"));
            }
        }
        let mut pending = vec![PathBuf::new()];
        while let Some(directory) = pending.pop() {
            if cancel.is_cancelled() {
                return Err(invalid("Extraction cancelled"));
            }
            for item in fs::read_dir(self.tree.path.join(&directory)).map_err(invalid)? {
                let item = item.map_err(invalid)?;
                let relative = directory.join(item.file_name());
                let kind = item.file_type().map_err(invalid)?;
                if kind.is_dir() && directories.remove(&relative) {
                    pending.push(relative);
                } else if !kind.is_file() || !files.remove(&relative) {
                    return Err(invalid(
                        "The extraction staging tree contains an unexpected entry",
                    ));
                }
                // Also reject Windows junctions that look like directories.
                Identity::at(&item.path())?;
            }
        }
        if !directories.is_empty() || !files.is_empty() {
            return Err(invalid("The extraction staging tree is incomplete"));
        }
        Ok(())
    }

    pub(super) fn prepare(&self, relative: &str, output_name: &str) -> Result<Publication, String> {
        let payload_identity = Identity::at(&self.tree.path.join(relative))?;
        Ok(Publication {
            output_name: output_name.to_owned(),
            payload_identity,
        })
    }

    pub(super) fn publish(
        self,
        target: &Target,
        stamp: &StageStamp,
        relative: &str,
        publication: &Publication,
    ) -> Result<String, String> {
        target.verify()?;
        stamp
            .identity
            .verify(&self.path, "The extraction staging directory has changed")?;
        publication.payload_identity.verify(
            &self.tree.path.join(relative),
            "The extraction output has changed",
        )?;
        let destination = ScopedRoot::new(&target.directory)?;
        target.verify()?;
        let output = target.directory.join(&publication.output_name);
        let tree = self.tree;
        let result = if relative.is_empty() {
            // Windows needs the directory's own no-delete handle closed before renaming.
            drop(tree);
            self.wrapper
                .rename_into(TREE, &destination, &publication.output_name)
        } else {
            tree.rename_into(relative, &destination, &publication.output_name)
        };
        result.map_err(|error| invalid(format!("Could not publish archive output: {error}")))?;
        sync_directory(&target.directory).map_err(invalid)?;
        Ok(display(&output))
    }
}

pub(super) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match File::open(path) {
        Ok(file) => serde_json::from_reader(file.take(32 * 1024))
            .map(Some)
            .map_err(invalid),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(invalid(error)),
    }
}

pub(super) fn save_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().unwrap();
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(invalid)?;
    serde_json::to_writer(&mut temp, value).map_err(invalid)?;
    temp.as_file().sync_all().map_err(invalid)?;
    temp.persist(path).map_err(invalid)?;
    sync_directory(parent).map_err(invalid)
}

fn digest(reader: &mut dyn Read, size: u64, mut writer: impl Write) -> Result<[u8; 32], String> {
    debug_assert!(size <= MAX_ARCHIVE.max(MAX_ENTRY));
    let mut sha = Sha256::new();
    let mut buffer = [0; BUFFER];
    let mut input = reader.take(size + 1);
    let mut done = 0;
    loop {
        let count = input.read(&mut buffer).map_err(invalid)?;
        if count == 0 {
            break;
        }
        done += count as u64;
        if done > size {
            return Err(invalid("File size differs from the directory"));
        }
        sha.update(&buffer[..count]);
        writer.write_all(&buffer[..count]).map_err(invalid)?;
    }
    if done != size {
        return Err(invalid("File size differs from the directory"));
    }
    Ok(sha.finalize().into())
}

struct Progress<W, F> {
    output: W,
    update: F,
}

impl<W: Write, F: FnMut(u64)> Write for Progress<W, F> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = self.output.write(buffer)?;
        (self.update)(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}
