use super::{model::*, service::Inner};

pub(super) fn setup() -> (tempfile::TempDir, Inner, String) {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("repo");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(
        project.join("AGENTS.md"),
        "Keep lifecycle ownership in Rust.",
    )
    .unwrap();
    let inner = Inner::open(temp.path().join("state")).unwrap();
    let mut settings = inner.settings().unwrap();
    settings.resources.push(AgentResource {
        id: "api".into(),
        name: "Planning".into(),
        kind: "api".into(),
        protocol: AgentProtocol::AnthropicMessages,
        provider_id: String::new(),
        model: "fixture-complete".into(),
        base_url: "http://127.0.0.1:12345/v1".into(),
        key_ref: String::new(),
        harness: "claude_code".into(),
        binary: String::new(),
        args: Vec::new(),
        cost_coefficient: 1.0,
        proxy_mode: "none".into(),
        custom_proxy: None,
    });
    settings.planning_resource_id = "api".into();
    settings.review_resource_id = "api".into();
    inner.save_settings(&settings, 1).unwrap();
    (temp, inner, project.to_string_lossy().into_owned())
}
pub(super) fn submission(project: &str, id: &str, revision: u64) -> AgentSubmission {
    AgentSubmission {
        command_id: id.into(),
        project_path: project.into(),
        goal: "Design a settings feature".into(),
        intent: AgentIntent::Plan,
        source_paths: Vec::new(),
        expected_settings_revision: revision,
    }
}

#[test]
fn submissions_share_defaults_and_old_snapshots_remain_immutable() {
    let (_temp, mut inner, project) = setup();
    let first = inner.create(submission(&project, "a", 2)).unwrap();
    let duplicate = inner.create(submission(&project, "a", 2)).unwrap();
    assert_eq!(first.id, duplicate.id);
    let second = inner.create(submission(&project, "b", 2)).unwrap();
    assert_eq!(
        first.settings_snapshot.revision,
        second.settings_snapshot.revision
    );
    let mut settings = inner.settings().unwrap();
    settings.name = "Updated defaults".into();
    inner.save_settings(&settings, 2).unwrap();
    let third = inner.create(submission(&project, "c", 3)).unwrap();
    assert_eq!(
        inner.store.get(&first.id).unwrap().settings_snapshot.name,
        "日常开发"
    );
    assert_eq!(third.settings_snapshot.name, "Updated defaults");
    assert!(inner.create(submission(&project, "d", 2)).is_err());
}
#[test]
fn duplicate_claim_and_capacity_are_transactional() {
    let (_temp, mut inner, project) = setup();
    let run = inner.create(submission(&project, "a", 2)).unwrap();
    let (attempt, request) = inner.store.claim(&run.id, &inner.owner, false, 2).unwrap();
    assert!(inner.store.claim(&run.id, &inner.owner, false, 2).is_err());
    let other = inner.create(submission(&project, "b", 2)).unwrap();
    assert!(
        inner
            .store
            .claim(&other.id, &inner.owner, false, 1)
            .is_err()
    );
    inner
        .store
        .finish_attempt(&attempt, &request, "completed")
        .unwrap();
    assert!(inner.store.claim(&other.id, &inner.owner, false, 1).is_ok());
}
#[test]
fn complete_candidate_is_retained_on_disk_without_acceptance() {
    let (_temp, mut inner, project) = setup();
    let run = inner.create(submission(&project, "a", 2)).unwrap();
    let artifact = AgentArtifact {
        id: uuid::Uuid::new_v4().to_string(),
        item_id: "design".into(),
        name: "design.md".into(),
        format: "markdown".into(),
        content: "Candidate design, not test evidence.".into(),
        hash: digest(b"Candidate design, not test evidence."),
        status: "candidate".into(),
    };
    let saved = inner.save_candidate(&run.id, artifact.clone()).unwrap();
    assert_eq!(saved.status, "planned");
    assert_eq!(saved.artifacts.len(), 1);
    let bytes = std::fs::read(inner.root.join("artifacts").join(&artifact.id)).unwrap();
    assert_eq!(digest(&bytes), artifact.hash);
    assert!(inner.save_candidate(&run.id, artifact).is_err());
}
#[test]
fn interrupted_owner_is_not_redispatched_or_treated_as_dead() {
    let (temp, mut inner, project) = setup();
    let run = inner.create(submission(&project, "a", 2)).unwrap();
    inner.store.claim(&run.id, &inner.owner, false, 2).unwrap();
    inner
        .mutate(&run.id, "start", "started", |r| {
            r.status = "running".into();
            Ok(())
        })
        .unwrap();
    let path = inner.root.clone();
    drop(inner);
    let mut restored = Inner::open(path).unwrap();
    assert_eq!(restored.store.get(&run.id).unwrap().status, "interrupted");
    assert!(
        restored
            .store
            .claim(&run.id, &restored.owner, false, 2)
            .is_err()
    );
    assert!(Inner::open(temp.path().join("state")).is_err());
}
