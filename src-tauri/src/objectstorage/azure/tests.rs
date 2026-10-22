use super::authentication::parse_connection_string;
use super::client::AzureClient;
use reqwest::Client;

/// End-to-end round trip against Azurite. Skipped unless `TAOMNI_AZ_IT` is
/// set. Uses Azurite's well-known public dev account/key (not a secret).
/// Exercises Shared Key signing, container/blob ops, and delimiter→folder
/// mapping.
#[tokio::test]
async fn azure_round_trip() {
    if std::env::var("TAOMNI_AZ_IT").is_err() {
        return;
    }
    let cs = std::env::var("TAOMNI_AZ_IT_CONNSTR").unwrap_or_else(|_| {
            "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;".into()
        });
    let (account, base, auth) = parse_connection_string(&cs).expect("parse connection string");
    let client = AzureClient::new(reqwest::Client::new(), account, base, auth);

    let container = format!("taomniit{}", uuid::Uuid::new_v4().simple());
    client
        .create_bucket(&container)
        .await
        .expect("create container");

    let buckets = client.list_buckets().await.expect("list containers");
    assert!(
        buckets.iter().any(|b| b.name == container),
        "new container listed"
    );

    client
        .put_object_bytes(&container, "dir/hello.txt", b"hi there".to_vec())
        .await
        .expect("put blob");
    client
        .create_folder(&container, "emptydir")
        .await
        .expect("create folder");

    let root = client
        .list_objects(&container, "", None, 1000)
        .await
        .expect("list root");
    assert!(
        root.entries.iter().any(|e| e.is_dir && e.name == "dir"),
        "dir/ surfaces as a folder"
    );

    let inside = client
        .list_objects(&container, "dir/", None, 1000)
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
        .get_object_bytes(&container, "dir/hello.txt")
        .await
        .expect("get");
    assert_eq!(bytes, b"hi there");

    // --- P3 management ops ---
    let meta = client
        .head_object(&container, "dir/hello.txt")
        .await
        .expect("head");
    assert_eq!(meta.size, 8);

    client
        .copy_object(&container, "dir/hello.txt", &container, "dir2/copy.txt")
        .await
        .expect("copy blob");
    let copied = client
        .get_object_bytes(&container, "dir2/copy.txt")
        .await
        .expect("get copy");
    assert_eq!(copied, b"hi there");

    // Service SAS should be fetchable with no auth header.
    let url = client
        .presign_get(&container, "dir/hello.txt", 300)
        .expect("presign");
    let presigned = reqwest::get(&url)
        .await
        .expect("fetch sas")
        .bytes()
        .await
        .expect("bytes");
    assert_eq!(&presigned[..], b"hi there");

    client
        .delete_prefix(&container, "dir/")
        .await
        .expect("delete_prefix");
    let after = client
        .list_objects(&container, "", None, 1000)
        .await
        .expect("relist");
    assert!(
        !after.entries.iter().any(|e| e.name == "dir"),
        "dir/ gone after delete_prefix"
    );

    client
        .delete_object(&container, "dir2/copy.txt")
        .await
        .expect("del copy");
    client
        .delete_object(&container, "emptydir/")
        .await
        .expect("del marker");
    client
        .delete_bucket(&container)
        .await
        .expect("del container");
}
