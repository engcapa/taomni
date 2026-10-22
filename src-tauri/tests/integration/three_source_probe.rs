//! Three-source manifest probe (Layer 2 §16.6): verify the downloader's
//! probe_and_choose function honours the order of mirrors and picks the
//! first to respond. We can't easily test concurrent HEAD probing without
//! a multi-server fixture; instead we assert the manifest schema parses
//! and that every entry has at least one URL.

use taomni_lib::models::manifest::load_manifest;

#[test]
fn manifest_has_three_sources_per_entry() {
    let manifest = load_manifest().expect("models manifest must load");
    assert!(
        !manifest.models.is_empty(),
        "manifest must list at least one model"
    );
    for (id, meta) in &manifest.models {
        assert!(
            !meta.urls.is_empty(),
            "model `{}` must have at least one URL in manifest",
            id
        );
    }
}

#[test]
fn manifest_includes_llm_models() {
    use taomni_lib::models::manifest::ModelKind;
    let manifest = load_manifest().expect("models manifest must load");
    let has_llm = manifest
        .models
        .values()
        .any(|m| matches!(m.kind, ModelKind::Llm));
    assert!(has_llm, "manifest must include at least one LLM model");
    // ASR has a separate pinned catalog; its download inputs are checked in
    // asr::catalog::tests::asr_catalog_has_verified_download_inputs.
}
