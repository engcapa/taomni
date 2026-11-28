//! Profile-owned background extraction independent of the file viewer.
use super::stage::{Publication, Source, Stage, StageStamp, Target, read_json, save_json};
use super::{Entry, MAX_TOTAL, Selection, invalid, output_paths, visit_open};
use crate::viewer::paths::display;
use rars::ReadCancellation;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Preparing,
    Extracting,
    Verifying,
    Publishing,
    Cancelling,
    Cancelled,
    Completed,
    Failed,
}

impl Phase {
    fn cancellable(self) -> bool {
        matches!(self, Self::Preparing | Self::Extracting | Self::Verifying)
    }

    fn active(self) -> bool {
        self.cancellable() || matches!(self, Self::Publishing | Self::Cancelling)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    id: String,
    phase: Phase,
    destination: String,
    member: Option<String>,
    bytes: u64,
    total_bytes: Option<u64>,
    retained_bytes: u64,
    can_resume: bool,
    output: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    version: u32,
    snapshot: Snapshot,
    target: Target,
    selection: Option<Entry>,
    source: Option<Source>,
    stage: Option<StageStamp>,
    publication: Option<Publication>,
}

impl Journal {
    fn load(key: &Path) -> Result<Option<Self>, String> {
        let Some(mut journal) = read_json::<Self>(key)? else {
            return Ok(None);
        };
        if journal.version != 1 {
            return Err(invalid("Unsupported extraction checkpoint version"));
        }
        if journal.snapshot.phase.active() {
            let recovered = journal
                .publication
                .as_ref()
                .map(|planned| planned.recovered(&journal.target))
                .transpose();
            match recovered {
                Ok(Some(Some(output))) => journal.complete(output),
                Err(error) => {
                    journal.snapshot.phase = Phase::Failed;
                    journal.snapshot.can_resume = true;
                    journal.snapshot.error = Some(error);
                }
                _ => {
                    journal.snapshot.phase = Phase::Cancelled;
                    journal.snapshot.can_resume = true;
                }
            }
            save_json(key, &journal)?;
        }
        journal.remove_completed_stage(key);
        Ok(Some(journal))
    }

    fn complete(&mut self, output: String) {
        self.snapshot.phase = Phase::Completed;
        self.snapshot.can_resume = false;
        self.snapshot.output = Some(output);
        self.snapshot.error = None;
    }

    fn remove_completed_stage(&mut self, key: &Path) {
        if self.snapshot.phase == Phase::Completed
            && let Some(stage) = &self.stage
            && stage.clean(&self.target).is_ok()
        {
            self.stage = None;
            if let Err(error) = save_json(key, self) {
                tracing::warn!(%error, "Could not update completed archive checkpoint");
            }
        }
    }

    fn begin_attempt(&mut self) {
        self.snapshot.phase = Phase::Preparing;
        self.snapshot.bytes = 0;
        self.snapshot.retained_bytes = 0;
        self.snapshot.can_resume = false;
        self.snapshot.error = None;
    }
}

struct Job {
    snapshot: Mutex<Snapshot>,
    cancel: ReadCancellation,
}

impl Job {
    fn snapshot(&self) -> MutexGuard<'_, Snapshot> {
        self.snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn set_phase(&self, phase: Phase) -> Result<(), String> {
        let mut snapshot = self.snapshot();
        if self.cancel.is_cancelled() {
            return Err(invalid("Extraction cancelled"));
        }
        snapshot.phase = phase;
        Ok(())
    }

    fn request_cancel(&self) -> Snapshot {
        let mut snapshot = self.snapshot();
        if snapshot.phase.cancellable() {
            self.cancel.cancel();
            snapshot.phase = Phase::Cancelling;
        }
        snapshot.clone()
    }
}

type Registry = HashMap<PathBuf, Arc<Job>>;

fn registry() -> MutexGuard<'static, Registry> {
    static JOBS: OnceLock<Mutex<Registry>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn normalized_path(path: &str) -> String {
    // The original path remains usable as a lookup when the source is missing
    // or temporarily unmounted. Windows opens the same path across case variants.
    #[cfg(windows)]
    return path.replace('\\', "/").to_lowercase();
    #[cfg(not(windows))]
    path.to_owned()
}

fn key(profile: &Path, path: &str) -> Result<PathBuf, String> {
    if !Path::new(path).is_absolute() {
        return Err(invalid(
            "Archive extraction requires an absolute source path",
        ));
    }
    let digest = Sha256::digest(normalized_path(path).as_bytes());
    Ok(profile
        .join("archive-extractions")
        .join(format!("{}.json", hex::encode(digest))))
}

pub(crate) fn status(profile: &Path, path: &str) -> Result<Option<Snapshot>, String> {
    let key = key(profile, path)?;
    let jobs = registry();
    if let Some(job) = jobs.get(&key) {
        return Ok(Some(job.snapshot().clone()));
    }
    Ok(Journal::load(&key)?.map(|journal| journal.snapshot))
}

pub(crate) fn start(
    profile: &Path,
    path: String,
    destination: &str,
    selection: Option<Entry>,
    total_bytes: Option<u64>,
) -> Result<Snapshot, String> {
    let key = key(profile, &path)?;
    let mut jobs = registry();
    if let Some(job) = jobs.get(&key) {
        return Ok(job.snapshot().clone());
    }
    if let Some(mut previous) = Journal::load(&key)? {
        if previous.snapshot.can_resume {
            return Err(invalid("Resume or discard the previous extraction first"));
        }
        previous.remove_completed_stage(&key);
        if previous.stage.is_some() {
            return Err(invalid(
                "Could not clean up the previous extraction staging directory",
            ));
        }
    }
    let target = Target::new(destination)?;
    let snapshot = Snapshot {
        id: uuid::Uuid::new_v4().simple().to_string(),
        phase: Phase::Preparing,
        destination: display(&target.directory),
        member: selection.as_ref().map(|entry| entry.name.clone()),
        bytes: 0,
        total_bytes: total_bytes.filter(|total| *total <= MAX_TOTAL),
        retained_bytes: 0,
        can_resume: false,
        output: None,
        error: None,
    };
    fs::create_dir_all(key.parent().unwrap()).map_err(invalid)?;
    let journal = Journal {
        version: 1,
        snapshot,
        target,
        selection,
        source: None,
        stage: None,
        publication: None,
    };
    launch(&mut jobs, key, path, journal)
}

pub(crate) fn cancel(profile: &Path, path: &str, id: &str) -> Result<Snapshot, String> {
    let key = key(profile, path)?;
    let jobs = registry();
    if let Some(job) = jobs.get(&key).filter(|job| job.snapshot().id == id) {
        return Ok(job.request_cancel());
    }
    Ok(load_current(&key, id)?.snapshot)
}

pub(crate) fn resume(profile: &Path, path: String, id: &str) -> Result<Snapshot, String> {
    let key = key(profile, &path)?;
    let mut jobs = registry();
    if let Some(job) = jobs.get(&key).filter(|job| job.snapshot().id == id) {
        return Ok(job.snapshot().clone());
    }
    let mut journal = load_current(&key, id)?;
    if !journal.snapshot.can_resume {
        return Err(invalid("This extraction cannot be resumed"));
    }
    journal.begin_attempt();
    launch(&mut jobs, key, path, journal)
}

pub(crate) fn discard(profile: &Path, path: &str, id: &str) -> Result<(), String> {
    let key = key(profile, path)?;
    let jobs = registry();
    if jobs.contains_key(&key) {
        return Err(invalid(
            "Wait for the current extraction to finish stopping",
        ));
    }
    let journal = load_current(&key, id)?;
    if !matches!(journal.snapshot.phase, Phase::Cancelled | Phase::Failed) {
        return Err(invalid("Select a cancelled or failed extraction"));
    }
    if let Some(stage) = journal.stage {
        stage.clean(&journal.target)?;
    }
    fs::remove_file(key).map_err(invalid)
}

fn load_current(key: &Path, id: &str) -> Result<Journal, String> {
    Journal::load(key)?
        .filter(|journal| journal.snapshot.id == id)
        .ok_or_else(|| invalid("The extraction task has changed"))
}

fn launch(
    jobs: &mut Registry,
    key: PathBuf,
    path: String,
    journal: Journal,
) -> Result<Snapshot, String> {
    save_json(&key, &journal)?;
    let snapshot = journal.snapshot.clone();
    let job = Arc::new(Job {
        snapshot: Mutex::new(snapshot.clone()),
        cancel: ReadCancellation::new(),
    });
    let source_lease = crate::viewer::temporary::lease(Path::new(&path));
    jobs.insert(key.clone(), job.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _source_lease = source_lease;
        finish(&key, &path, journal, &job);
        registry().remove(&key);
    });
    Ok(snapshot)
}

pub(crate) fn cancel_all() {
    for job in registry().values() {
        job.request_cancel();
    }
}

fn finish(key: &Path, path: &str, mut journal: Journal, job: &Job) {
    let result = extract(key, path, &mut journal, job);
    let completed = job.snapshot().clone();
    journal.snapshot = completed;
    match result {
        Ok(output) => journal.complete(output),
        Err(error) => {
            let recovered = journal
                .publication
                .as_ref()
                .and_then(|planned| planned.recovered(&journal.target).ok().flatten());
            if let Some(output) = recovered {
                journal.complete(output);
            } else {
                journal.snapshot.phase = if job.cancel.is_cancelled() {
                    Phase::Cancelled
                } else {
                    Phase::Failed
                };
                journal.snapshot.can_resume = journal.stage.is_some() || job.cancel.is_cancelled();
                journal.snapshot.bytes = journal.snapshot.retained_bytes;
                if journal.snapshot.phase == Phase::Failed {
                    journal.snapshot.error = Some(error);
                }
            }
        }
    }
    if let Err(error) = save_json(key, &journal) {
        tracing::warn!(%error, "Could not record archive extraction outcome");
    } else {
        journal.remove_completed_stage(key);
    }
    *job.snapshot() = journal.snapshot;
}

fn extract(key: &Path, path: &str, journal: &mut Journal, job: &Job) -> Result<String, String> {
    if let Some(planned) = &journal.publication {
        if let Some(output) = planned.recovered(&journal.target)? {
            return Ok(output);
        }
    }
    let (source, input) = Source::open(path, &job.cancel)?;
    if journal
        .source
        .as_ref()
        .is_some_and(|previous| previous != &source)
    {
        return Err(invalid(
            "The source archive has changed. Discard this extraction and reload the archive",
        ));
    }
    if journal.stage.is_none() {
        let (guard, stamp) = Stage::allocate(&journal.target)?;
        journal.source = Some(source.clone());
        journal.stage = Some(stamp);
        save_json(key, journal)?;
        let _ = guard.keep();
    }
    let stamp = journal.stage.as_ref().unwrap();
    let stage = Stage::open(&journal.target, stamp)?;
    let selection = journal
        .selection
        .as_ref()
        .map_or(Selection::All, |entry| Selection::One(entry.index));
    job.set_phase(Phase::Extracting)?;
    let entries = visit_open(
        path,
        input,
        source.size(),
        selection,
        &job.cancel,
        |entry, reader| {
            stage.write(entry, reader, |delta| job.snapshot().bytes += delta)?;
            if !entry.directory {
                job.snapshot().retained_bytes += entry.size;
            }
            Ok(())
        },
    )?;
    let selected = || {
        entries
            .iter()
            .filter(|entry| selection.includes(entry.index))
    };
    job.snapshot().total_bytes = Some(
        selected()
            .filter(|entry| !entry.directory)
            .map(|entry| entry.size)
            .sum(),
    );
    let (relative, output_name) = output_paths(path, journal.selection.as_ref(), &entries)?;

    job.set_phase(Phase::Verifying)?;
    stage.verify(selected(), &job.cancel)?;
    let (current, _) = Source::open(path, &job.cancel)?;
    if current != source {
        return Err(invalid("The source archive changed during extraction"));
    }

    let planned = stage.prepare(relative, output_name)?;
    job.set_phase(Phase::Publishing)?;
    journal.publication = Some(planned);
    journal.snapshot = job.snapshot().clone();
    save_json(key, journal)?;
    stage.publish(
        &journal.target,
        stamp,
        relative,
        journal.publication.as_ref().unwrap(),
    )
}

#[cfg(test)]
mod tests;
