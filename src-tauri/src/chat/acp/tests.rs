use super::conversation::grok_image_resource_links;
use super::media_generation::grok_media_prompt;
use crate::agent::acp_bridge::GROK_PROFILE_ID;
use crate::chat::MediaGenerationKind;
use crate::chat::store;

#[test]
fn grok_media_prompts_select_the_native_tools_for_each_flow() {
    let image = grok_media_prompt(MediaGenerationKind::Image, "a red kite", false);
    assert!(image.contains("image_gen"));
    assert!(image.ends_with("a red kite"));

    let edited_image = grok_media_prompt(MediaGenerationKind::Image, "make it blue", true);
    assert!(edited_image.contains("image_edit"));

    let video = grok_media_prompt(MediaGenerationKind::Video, "waves moving", false);
    assert!(video.contains("image_gen"));
    assert!(video.contains("image_to_video"));
    assert!(video.contains("6-second"));

    let referenced_video = grok_media_prompt(MediaGenerationKind::Video, "slow zoom", true);
    assert!(referenced_video.contains("image_to_video"));
    assert!(!referenced_video.contains("First use Grok's native image_gen"));
}

#[test]
fn grok_image_attachments_become_local_file_resource_links() {
    let dir = tempfile::tempdir().unwrap();
    let image = dir.path().join("reference image.png");
    std::fs::write(&image, [137, 80, 78, 71]).unwrap();
    let attachment = store::ChatAttachment {
        id: "image-1".into(),
        kind: "image".into(),
        path: image.to_string_lossy().into_owned(),
        name: "reference image.png".into(),
        size: 4,
        mime: Some("image/png".into()),
        preview_url: None,
    };

    let links = grok_image_resource_links(GROK_PROFILE_ID, &[attachment]);

    assert_eq!(links.len(), 1);
    assert_eq!(links[0].name, "reference image.png");
    assert_eq!(links[0].mime_type.as_deref(), Some("image/png"));
    let uri = url::Url::parse(&links[0].uri).unwrap();
    assert_eq!(uri.scheme(), "file");
    // Compare against a URL built the same way production builds it
    // (`canonicalize` → `from_file_path`). On Windows `canonicalize`
    // yields a `\\?\` verbatim path that `Url::to_file_path` normalizes
    // away, so asserting `to_file_path() == canonicalize()` fails on the
    // prefix alone. Round-tripping both through `from_file_path` keeps the
    // comparison symmetric across platforms.
    let expected = url::Url::from_file_path(std::fs::canonicalize(&image).unwrap()).unwrap();
    assert_eq!(uri, expected);
    assert!(grok_image_resource_links("another-agent", &[]).is_empty());
}
