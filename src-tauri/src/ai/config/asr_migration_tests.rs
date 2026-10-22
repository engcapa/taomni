use super::asr::AsrConfig;

#[test]
fn local_route_preserves_cantonese_and_covers_eight_languages() {
    let mut config = AsrConfig::default();
    for language in ["zh", "yue", "en", "ja", "ko", "es", "fr", "it"] {
        config.language = language.into();
        config.normalize();
        assert_eq!(config.language, language);
        assert_eq!(
            config.routed_model(),
            if ["es", "fr", "it"].contains(&language) {
                "whisper-small-q8"
            } else {
                "sensevoice-small"
            }
        );
    }
    config.language = "auto".into();
    config.language_prior = "it".into();
    assert_eq!(config.routed_model(), "whisper-small-q8");
    config.active = "whisper-base".into();
    config.normalize();
    assert_eq!(
        config.routed_model(),
        "whisper-base",
        "do not silently replace a legacy selection"
    );
}
#[test]
fn legacy_asr_migrates_without_enabling_download_or_warmup() {
    let mut config = AsrConfig::default();
    config.active = "legacy-unavailable-engine".into();
    config.language = "invalid".into();
    config.warm_on_startup = true;
    config.normalize();
    assert_eq!(config.active, "local-auto");
    assert_eq!(config.language, "auto");
    assert!(!config.warm_on_startup);
    assert!(config.providers.contains_key("whisper-base"));
    assert!(config.providers.contains_key("sherpa-zipformer-zh-en"));
    assert!(config.providers.contains_key("aliyun"));
    assert!(config.providers.contains_key("deepgram"));
    assert!(config.providers.contains_key("gemini"));
    config.active = "whisper-small".into();
    config.normalize();
    assert_eq!(config.active, "whisper-small");
}
