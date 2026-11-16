use super::*;

fn parse(value: &str) -> Result<AssetPath, &'static str> {
    parse_asset_uri(&value.parse::<Uri>().map_err(|_| "invalid URI")?)
}

#[test]
fn application_origin_alias_preserves_the_same_versioned_resource_validation() {
    for root in [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ] {
        let uri =
            format!("{root}/__taomni_plugins__/demo/1.2.0-rc.1%2Bbuild.2/frontend/assets/chunk.js")
                .parse()
                .unwrap();
        let target = app_asset_uri(&uri).unwrap().unwrap();
        assert_eq!(
            parse_asset_uri(&target).unwrap(),
            AssetPath {
                slug: "demo".into(),
                version: "1.2.0-rc.1+build.2".into(),
                relative: "frontend/assets/chunk.js".into(),
            }
        );
    }
    for uri in [
        "tauri://localhost/index.html",
        "tauri://localhost/assets/main.js",
        "tauri://localhost/__taomni_plugins__other/file.js",
    ] {
        assert!(app_asset_uri(&uri.parse().unwrap()).unwrap().is_none());
    }
}

#[test]
fn application_alias_denies_reserved_malformed_paths_instead_of_returning_spa_html() {
    for uri in [
        "https://evil.example/__taomni_plugins__/demo/1.0.0/frontend/index.js",
        "tauri://evil/__taomni_plugins__/demo/1.0.0/frontend/index.js",
        "tauri://localhost:80/__taomni_plugins__/demo/1.0.0/frontend/index.js",
        "tauri://localhost/__taomni_plugins__",
        "tauri://localhost/__taomni_plugins__/demo/1.0.0/frontend/index.js?alternate=true",
        "tauri://localhost/__taomni_plugins__/demo/1.0.0/frontend/%2e%2e/host",
        "tauri://localhost/__taomni_plugins__/demo/1.0.0/frontend/%252e%252e/host",
        "tauri://localhost/__taomni_plugins__/demo/1.0.0/frontend/a%2Fb.js",
        "tauri://localhost/__taomni_plugins__/demo/1.0.0/host",
    ] {
        assert!(app_asset_uri(&uri.parse().unwrap()).is_err(), "{uri}");
    }
}

#[test]
fn accepts_native_custom_and_webview2_mapping_without_encoding_path_separators() {
    for root in [
        "taomni-plugin://localhost",
        "http://taomni-plugin.localhost",
        "https://taomni-plugin.localhost",
    ] {
        assert_eq!(
            parse(&format!(
                "{root}/demo/1.2.0-rc.1%2Bbuild.2/frontend/my%20entry.js"
            ))
            .unwrap(),
            AssetPath {
                slug: "demo".into(),
                version: "1.2.0-rc.1+build.2".into(),
                relative: "frontend/my entry.js".into(),
            }
        );
        assert_eq!(
            parse(&format!("{root}/demo/1.2.0/frontend/assets/chunk.js"))
                .unwrap()
                .relative,
            "frontend/assets/chunk.js"
        );
    }
}

#[test]
fn denies_other_schemes_authorities_ports_credentials_queries_and_old_urls() {
    for value in [
        "https://evil.example/demo/1.0.0/frontend/index.js",
        "file://localhost/demo/1.0.0/frontend/index.js",
        "taomni-plugin://demo/1.0.0/frontend/index.js",
        "taomni-plugin://localhost:80/demo/1.0.0/frontend/index.js",
        "http://taomni-plugin.localhost:80/demo/1.0.0/frontend/index.js",
        "http://user@taomni-plugin.localhost/demo/1.0.0/frontend/index.js",
        "http://taomni-plugin.localhost.evil/demo/1.0.0/frontend/index.js",
        "taomni-plugin://localhost/demo/1.0.0/frontend/index.js?version=9.0.0",
        "taomni-plugin://localhost/demo/1.0.0/host",
        "taomni-plugin://localhost/demo/no-version/frontend/index.js",
    ] {
        assert!(parse(value).is_err(), "{value}");
    }
}

#[test]
fn rejects_raw_encoded_and_double_encoded_traversal_before_normalization() {
    for path in [
        "demo/1.0.0/frontend/../host",
        "demo/1.0.0/frontend/./index.js",
        "demo/1.0.0/frontend/%2e%2e/host",
        "demo/1.0.0/frontend/%252e%252e/host",
        "demo/1.0.0/frontend/a%2Fb.js",
        "demo/1.0.0/frontend/a%5Cb.js",
        "demo/1.0.0/frontend/a%00.js",
        "demo/1.0.0/frontend/a%3Astream",
        "demo/1.0.0/frontend/%ff.js",
        "demo/1.0.0/frontend/a%2.js",
        "demo/1.0.0/frontend/a%.js",
        "demo/1.0.0/frontend//index.js",
        "demo%2Fother/1.0.0/frontend/index.js",
        "demo/1.0.0%2Fother/frontend/index.js",
    ] {
        assert!(
            parse(&format!("taomni-plugin://localhost/{path}")).is_err(),
            "{path}"
        );
    }
}

#[test]
fn cors_allows_only_exact_renderer_and_configured_development_origins() {
    for origin in [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ] {
        let mut headers = HeaderMap::new();
        headers.insert("Origin", origin.parse().unwrap());
        assert_eq!(cors_origin(&headers, None).unwrap(), Some(origin));
        let response = response(
            StatusCode::OK,
            b"module".to_vec(),
            "text/javascript",
            Some(origin),
        );
        assert_eq!(response.headers()["Access-Control-Allow-Origin"], origin);
        assert_eq!(response.headers()["Vary"], "Origin");
        assert!(
            !response
                .headers()
                .contains_key("Access-Control-Allow-Credentials")
        );
    }
    let mut headers = HeaderMap::new();
    headers.insert("Origin", "http://localhost:1980".parse().unwrap());
    assert!(cors_origin(&headers, None).is_err());
    assert_eq!(
        cors_origin(&headers, Some("http://localhost:1980")).unwrap(),
        Some("http://localhost:1980")
    );
    for origin in [
        "null",
        "*",
        "https://evil.example",
        "http://tauri.localhost.evil",
        "http://tauri.localhost:80",
        "tauri://localhost/",
    ] {
        headers.insert("Origin", origin.parse().unwrap());
        assert!(cors_origin(&headers, None).is_err(), "{origin}");
    }
    headers.insert("Origin", "tauri://localhost".parse().unwrap());
    headers.append("Origin", "http://tauri.localhost".parse().unwrap());
    assert!(cors_origin(&headers, None).is_err());
    assert!(cors_origin(&HeaderMap::new(), None).unwrap().is_none());
    assert!(
        !response(StatusCode::FORBIDDEN, Vec::new(), "text/plain", None)
            .headers()
            .contains_key("Access-Control-Allow-Origin")
    );
}
