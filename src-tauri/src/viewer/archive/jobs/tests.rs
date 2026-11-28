use super::*;
use std::io::{self, Read, Write};

struct Fixture {
    tree: tempfile::TempDir,
    path: String,
    key: PathBuf,
    journal: Journal,
}

impl Fixture {
    fn new() -> Self {
        let tree = tempfile::tempdir().unwrap();
        let path = display(&tree.path().join("bundle.zip"));
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("nested/first.txt", options).unwrap();
        zip.write_all(b"first").unwrap();
        zip.start_file("second.txt", options).unwrap();
        zip.write_all(b"second").unwrap();
        zip.finish().unwrap();
        let journal = Journal {
            version: 1,
            snapshot: Snapshot {
                id: "task".into(),
                phase: Phase::Preparing,
                destination: display(tree.path()),
                member: None,
                bytes: 0,
                total_bytes: Some(11),
                retained_bytes: 0,
                can_resume: false,
                output: None,
                error: None,
            },
            target: Target::new(&display(tree.path())).unwrap(),
            selection: None,
            source: None,
            stage: None,
            publication: None,
        };
        let key = tree.path().join("checkpoint.json");
        Self {
            tree,
            path,
            key,
            journal,
        }
    }

    fn finish(&self, journal: Journal) -> Journal {
        let job = Job {
            snapshot: Mutex::new(journal.snapshot.clone()),
            cancel: ReadCancellation::new(),
        };
        finish(&self.key, &self.path, journal, &job);
        Journal::load(&self.key).unwrap().unwrap()
    }

    fn interrupted(&mut self) -> PathBuf {
        let entries = super::super::list(&self.path).unwrap();
        let (guard, stamp) = Stage::allocate(&self.journal.target).unwrap();
        let stage = Stage::open(&self.journal.target, &stamp).unwrap();
        let cancel = ReadCancellation::new();
        self.journal.source = Some(Source::open(&self.path, &cancel).unwrap().0);
        self.journal.stage = Some(stamp);
        stage
            .write(&entries[0], &mut &b"first"[..], |_| {})
            .unwrap();
        struct AbortAfterFirstRead<'a>(&'a ReadCancellation);
        impl Read for AbortAfterFirstRead<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.0.is_cancelled() {
                    return Err(io::Error::other("Cancelled during member"));
                }
                buffer[0] = b's';
                self.0.cancel();
                Ok(1)
            }
        }
        assert!(
            stage
                .write(&entries[1], &mut AbortAfterFirstRead(&cancel), |_| {})
                .is_err()
        );
        drop(stage);
        let stage = guard.keep();
        assert!(!stage.join("files/second.txt").exists());
        assert!(!stage.join("1.json").exists());
        assert!(!fs::read_dir(&stage).unwrap().any(|item| {
            item.unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "part")
        }));
        self.journal.snapshot.phase = Phase::Extracting;
        save_json(&self.key, &self.journal).unwrap();
        stage
    }

    fn reload(&self) -> Journal {
        Journal::load(&self.key).unwrap().unwrap()
    }
}

#[test]
fn resume_after_interruption_reuses_synced_member_and_atomically_publishes_all_files() {
    let mut fixture = Fixture::new();
    let stage = fixture.interrupted();
    let before = fs::metadata(stage.join("files/nested/first.txt"))
        .unwrap()
        .modified()
        .unwrap();
    let mut journal = fixture.reload();
    assert_eq!(journal.snapshot.phase, Phase::Cancelled);
    assert_eq!(journal.snapshot.id, "task");
    assert!(journal.snapshot.can_resume);
    assert!(!fixture.tree.path().join("bundle").exists());
    journal.begin_attempt();
    let result = fixture.finish(journal);
    assert_eq!(
        result.snapshot.phase,
        Phase::Completed,
        "{:?}",
        result.snapshot.error
    );
    assert_eq!(result.snapshot.bytes, 11);
    assert_eq!(result.snapshot.retained_bytes, 11);
    let first = fixture.tree.path().join("bundle/nested/first.txt");
    assert_eq!(fs::metadata(&first).unwrap().modified().unwrap(), before);
    assert_eq!(fs::read(first).unwrap(), b"first");
    assert_eq!(
        fs::read(fixture.tree.path().join("bundle/second.txt")).unwrap(),
        b"second"
    );
    assert!(!stage.exists());
}

#[test]
fn rejects_changed_source_or_staged_bytes_and_preserves_destination_collisions() {
    let mut changed = Fixture::new();
    changed.interrupted();
    fs::write(&changed.path, b"A different archive").unwrap();
    let result = changed.finish(changed.reload());
    assert_eq!(result.snapshot.phase, Phase::Failed);
    assert!(
        result
            .snapshot
            .error
            .unwrap()
            .contains("source archive has changed")
    );
    assert!(!changed.tree.path().join("bundle").exists());

    let mut tampered = Fixture::new();
    let stage = tampered.interrupted();
    fs::write(stage.join("files/nested/first.txt"), b"other").unwrap();
    let result = tampered.finish(tampered.reload());
    assert_eq!(result.snapshot.phase, Phase::Failed);
    assert!(
        result
            .snapshot
            .error
            .unwrap()
            .contains("staged archive member has changed")
    );
    assert!(!tampered.tree.path().join("bundle").exists());

    let mut collision = Fixture::new();
    collision.interrupted();
    let original = collision.tree.path().join("bundle");
    fs::create_dir(&original).unwrap();
    fs::write(original.join("second.txt"), b"existing bytes").unwrap();
    let result = collision.finish(collision.reload());
    assert_eq!(result.snapshot.phase, Phase::Failed);
    assert!(
        result
            .snapshot
            .error
            .unwrap()
            .contains("Could not publish archive output")
    );
    assert_eq!(
        fs::read(original.join("second.txt")).unwrap(),
        b"existing bytes"
    );
    assert!(!original.join("nested").exists());
}

#[test]
fn rejects_replaced_destination_before_resuming() {
    let mut fixture = Fixture::new();
    let destination = fixture.tree.path().join("target");
    fs::create_dir(&destination).unwrap();
    fixture.journal.target = Target::new(&display(&destination)).unwrap();
    fixture.interrupted();
    fs::rename(&destination, fixture.tree.path().join("previous")).unwrap();
    fs::create_dir(&destination).unwrap();

    let result = fixture.finish(fixture.reload());
    assert_eq!(result.snapshot.phase, Phase::Failed);
    assert!(
        result
            .snapshot
            .error
            .unwrap()
            .contains("destination has changed")
    );
    assert!(fs::read_dir(&destination).unwrap().next().is_none());
}

#[test]
fn a_restart_after_the_no_replace_rename_recovers_the_completed_result() {
    let mut fixture = Fixture::new();
    let stage_path = fixture.interrupted();
    let stamp = fixture.journal.stage.as_ref().unwrap();
    let stage = Stage::open(&fixture.journal.target, stamp).unwrap();
    let entries = super::super::list(&fixture.path).unwrap();
    stage
        .write(&entries[1], &mut &b"second"[..], |_| {})
        .unwrap();
    let publication = stage.prepare("", "bundle").unwrap();
    fixture.journal.publication = Some(publication);
    fixture.journal.snapshot.phase = Phase::Publishing;
    save_json(&fixture.key, &fixture.journal).unwrap();
    stage
        .publish(
            &fixture.journal.target,
            stamp,
            "",
            fixture.journal.publication.as_ref().unwrap(),
        )
        .unwrap();
    let recovered = fixture.reload();
    assert_eq!(recovered.snapshot.phase, Phase::Completed);
    assert_eq!(
        recovered.snapshot.output,
        Some(display(&fixture.tree.path().join("bundle")))
    );
    assert!(!stage_path.exists());
}
