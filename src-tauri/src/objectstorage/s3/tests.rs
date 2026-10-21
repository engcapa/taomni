use super::client::S3Client;
use super::metadata::folder_marker_key;
use super::metadata::move_prefix_plan;
use super::response::confirmed_part_etag_from_xml;
use reqwest::Client;
use rusty_s3::Credentials;
use rusty_s3::actions::ListObjectsV2;
use std::path::Path;
use url::Url;

use rusty_s3::UrlStyle;

#[test]
fn list_objects_decodes_url_encoded_keys() {
    let input = r#"
        <?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>bucket</Name>
            <Prefix>report%2F</Prefix>
            <KeyCount>2</KeyCount>
            <MaxKeys>1000</MaxKeys>
            <Delimiter>%2F</Delimiter>
            <IsTruncated>false</IsTruncated>
            <Contents>
                <Key>report%2F%E6%89%8B%E6%9C%BA%2BCRM.txt</Key>
                <LastModified>2026-07-07T12:00:00.000Z</LastModified>
                <ETag>"etag"</ETag>
                <Size>42</Size>
                <StorageClass>STANDARD</StorageClass>
            </Contents>
            <CommonPrefixes>
                <Prefix>report%2F%E5%AD%90%E7%9B%AE%E5%BD%95%2F</Prefix>
            </CommonPrefixes>
            <EncodingType>url</EncodingType>
        </ListBucketResult>
        "#;

    let parsed = ListObjectsV2::parse_response(input).expect("parse list response");
    let page = S3Client::list_response_to_page("report/", parsed);

    let file = page.entries.iter().find(|e| !e.is_dir).expect("file entry");
    assert_eq!(file.key, "report/手机+CRM.txt");
    assert_eq!(file.name, "手机+CRM.txt");

    let folder = page
        .entries
        .iter()
        .find(|e| e.is_dir)
        .expect("folder entry");
    assert_eq!(folder.key, "report/子目录/");
    assert_eq!(folder.name, "子目录");
}

#[test]
fn list_objects_treats_zero_byte_folder_markers_as_dirs() {
    let input = r#"
        <?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>bucket</Name>
            <Prefix></Prefix>
            <KeyCount>2</KeyCount>
            <MaxKeys>1000</MaxKeys>
            <Delimiter>/</Delimiter>
            <IsTruncated>false</IsTruncated>
            <CommonPrefixes>
                <Prefix>existing/</Prefix>
            </CommonPrefixes>
            <Contents>
                <Key>empty/</Key>
                <LastModified>2026-07-07T12:00:00.000Z</LastModified>
                <ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag>
                <Size>0</Size>
                <StorageClass>STANDARD</StorageClass>
            </Contents>
            <Contents>
                <Key>existing/</Key>
                <LastModified>2026-07-07T12:00:00.000Z</LastModified>
                <ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag>
                <Size>0</Size>
                <StorageClass>STANDARD</StorageClass>
            </Contents>
        </ListBucketResult>
        "#;

    let parsed = ListObjectsV2::parse_response(input).expect("parse list response");
    let page = S3Client::list_response_to_page("", parsed);

    let empty = page
        .entries
        .iter()
        .find(|e| e.key == "empty/")
        .expect("folder marker entry");
    assert!(empty.is_dir);
    assert_eq!(empty.name, "empty");
    assert_eq!(
        page.entries.iter().filter(|e| e.key == "existing/").count(),
        1,
        "common-prefix folder should not be duplicated by its marker object"
    );
}

#[test]
fn list_objects_skips_current_folder_marker() {
    let input = r#"
        <?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>bucket</Name>
            <Prefix>empty/</Prefix>
            <KeyCount>1</KeyCount>
            <MaxKeys>1000</MaxKeys>
            <Delimiter>/</Delimiter>
            <IsTruncated>false</IsTruncated>
            <Contents>
                <Key>empty/</Key>
                <LastModified>2026-07-07T12:00:00.000Z</LastModified>
                <ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag>
                <Size>0</Size>
                <StorageClass>STANDARD</StorageClass>
            </Contents>
        </ListBucketResult>
        "#;

    let parsed = ListObjectsV2::parse_response(input).expect("parse list response");
    let page = S3Client::list_response_to_page("empty/", parsed);

    assert!(page.entries.is_empty());
}

#[test]
fn folder_marker_key_normalizes_trailing_slash() {
    assert_eq!(folder_marker_key(""), "");
    assert_eq!(folder_marker_key("empty"), "empty/");
    assert_eq!(folder_marker_key("empty/"), "empty/");
}

#[test]
fn move_prefix_plan_includes_marker_and_nested_objects() {
    let plan = move_prefix_plan(
        "old/",
        "new/",
        vec![
            "old/".to_string(),
            "old/a.txt".to_string(),
            "old/nested/b.txt".to_string(),
        ],
    )
    .expect("plan");

    assert_eq!(
        plan,
        vec![
            ("old/".to_string(), "new/".to_string()),
            ("old/a.txt".to_string(), "new/a.txt".to_string()),
            (
                "old/nested/b.txt".to_string(),
                "new/nested/b.txt".to_string(),
            ),
        ]
    );
}

#[test]
fn list_parts_confirmation_requires_matching_number_and_size() {
    let input = r#"
        <ListPartsResult>
            <MaxParts>1</MaxParts>
            <IsTruncated>false</IsTruncated>
            <Part>
                <PartNumber>2</PartNumber>
                <LastModified>2026-07-09T10:00:00.000Z</LastModified>
                <ETag>"part-etag"</ETag>
                <Size>8388608</Size>
            </Part>
        </ListPartsResult>
        "#;

    assert_eq!(
        confirmed_part_etag_from_xml(input, 2, 8 * 1024 * 1024).as_deref(),
        Some("\"part-etag\"")
    );
    assert_eq!(
        confirmed_part_etag_from_xml(input, 1, 8 * 1024 * 1024),
        None
    );
    assert_eq!(confirmed_part_etag_from_xml(input, 2, 1024), None);
}

/// End-to-end round trip against a live S3-compatible endpoint (MinIO in
/// CI/dev). Skipped unless `TAOMNI_S3_IT_ENDPOINT` is set, so the normal
/// `cargo test` run stays offline. Exercises bucket/object signing, XML
/// list parsing, delimiter→folder mapping, and pagination plumbing.
#[tokio::test]
async fn s3_round_trip() {
    let endpoint = match std::env::var("TAOMNI_S3_IT_ENDPOINT") {
        Ok(e) => e,
        Err(_) => return,
    };
    let key = std::env::var("TAOMNI_S3_IT_KEY").unwrap_or_else(|_| "minioadmin".into());
    let secret = std::env::var("TAOMNI_S3_IT_SECRET").unwrap_or_else(|_| "minioadmin".into());

    let client = S3Client::new(
        reqwest::Client::new(),
        Credentials::new(key, secret),
        url::Url::parse(&endpoint).expect("endpoint url"),
        "us-east-1".to_string(),
        UrlStyle::Path,
    );

    let bucket = format!("taomni-it-{}", uuid::Uuid::new_v4().simple());
    client.create_bucket(&bucket).await.expect("create_bucket");

    let buckets = client.list_buckets().await.expect("list_buckets");
    assert!(
        buckets.iter().any(|b| b.name == bucket),
        "new bucket listed"
    );

    client
        .put_object_bytes(&bucket, "dir/hello.txt", b"hi there".to_vec())
        .await
        .expect("put_object");
    client
        .create_folder(&bucket, "emptydir")
        .await
        .expect("create_folder");

    let root = client
        .list_objects(&bucket, "", None, 1000)
        .await
        .expect("list root");
    assert!(
        root.entries.iter().any(|e| e.is_dir && e.name == "dir"),
        "dir/ surfaces as a folder"
    );
    assert!(
        root.entries.iter().all(|e| e.is_dir),
        "root has only folders, no loose files"
    );

    let inside = client
        .list_objects(&bucket, "dir/", None, 1000)
        .await
        .expect("list dir/");
    let file = inside
        .entries
        .iter()
        .find(|e| !e.is_dir)
        .expect("file under dir/");
    assert_eq!(file.name, "hello.txt");
    assert_eq!(file.size, 8);

    let bytes = client
        .get_object_bytes(&bucket, "dir/hello.txt")
        .await
        .expect("get");
    assert_eq!(bytes, b"hi there");

    // --- P3 management ops ---
    let meta = client
        .head_object(&bucket, "dir/hello.txt")
        .await
        .expect("head");
    assert_eq!(meta.size, 8);

    // Server-side copy (same bucket) then verify the copy's bytes.
    client
        .copy_object(&bucket, "dir/hello.txt", &bucket, "dir2/copy.txt")
        .await
        .expect("copy");
    let copied = client
        .get_object_bytes(&bucket, "dir2/copy.txt")
        .await
        .expect("get copy");
    assert_eq!(copied, b"hi there");

    // Presigned GET should be fetchable with no further credentials.
    let url = client
        .presign_get(&bucket, "dir/hello.txt", 300)
        .expect("presign");
    let presigned = reqwest::get(&url)
        .await
        .expect("fetch presigned")
        .bytes()
        .await
        .expect("bytes");
    assert_eq!(&presigned[..], b"hi there");

    // Recursive delete removes everything under the prefix.
    client
        .delete_prefix(&bucket, "dir/")
        .await
        .expect("delete_prefix");
    let after = client
        .list_objects(&bucket, "", None, 1000)
        .await
        .expect("relist");
    assert!(
        !after.entries.iter().any(|e| e.name == "dir"),
        "dir/ gone after delete_prefix"
    );

    // cleanup
    client
        .delete_object(&bucket, "dir2/copy.txt")
        .await
        .expect("del copy");
    client
        .delete_object(&bucket, "emptydir/")
        .await
        .expect("del marker");
    client.delete_bucket(&bucket).await.expect("del bucket");
}

// NOTE: the multipart-upload + streaming-download paths
// (`upload_from_file`/`download_to_file`) need a Tauri `AppHandle` for
// progress emission. Driving them in a unit test requires
// `tauri::test::mock_app()` (the `test` feature), which fails to link a
// bare test binary on Windows (STATUS_ENTRYPOINT_NOT_FOUND from the
// windowing DLLs). Those paths are therefore covered by manual smoke
// testing through the UI rather than an automated round-trip here.
