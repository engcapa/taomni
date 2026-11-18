//! Fixed, bundled draw.io renderer assets for the WKWebView loopback host.

use axum::body::Body;
use axum::http::{Response, StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::OnceLock;

const PREFIX: &str = "/_drawio-renderer/";
const BRIDGE: &str = include_str!("../../../src/components/viewer/markdown/drawioFrame.js");
const ENGINE: &str =
    include_str!("../../../src/components/viewer/markdown/vendor/viewer-static.min.js");
const FONT: &[u8] =
    include_bytes!("../../../src/components/viewer/markdown/vendor/architects-daughter.ttf");

fn token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

pub(super) fn url() -> String {
    format!(
        "{}{PREFIX}{}/index.html",
        super::html_loopback::origin(),
        token()
    )
}

pub(super) fn serve(origin: &str, path: &str) -> Option<Response<Body>> {
    let path = path.strip_prefix(PREFIX)?;
    let asset = path
        .split_once('/')
        .filter(|(capability, _)| *capability == token())
        .map(|(_, asset)| asset);
    let mut response = Response::builder()
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
    let (status, mime, body) = match asset {
        Some("index.html") => {
            static FONT_BASE64: OnceLock<String> = OnceLock::new();
            let font = FONT_BASE64.get_or_init(|| STANDARD.encode(FONT));
            let root = format!("{origin}{PREFIX}{}/", token());
            response = response.header(
                "Content-Security-Policy",
                format!(
                    "default-src 'none'; sandbox allow-scripts; script-src {root}bridge.js {root}viewer.js; \
                     style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
                ),
            );
            let html = format!(
                r#"<!doctype html><meta charset="utf-8">
<style>@font-face{{font-family:"Architects Daughter";src:url("data:font/ttf;base64,{font}") format("truetype")}}</style>
<script defer src="{root}bridge.js" data-engine="{root}viewer.js"></script>"#
            );
            (StatusCode::OK, "text/html; charset=utf-8", Body::from(html))
        }
        Some("bridge.js") => (
            StatusCode::OK,
            "text/javascript; charset=utf-8",
            Body::from(BRIDGE),
        ),
        Some("viewer.js") => (
            StatusCode::OK,
            "text/javascript; charset=utf-8",
            Body::from(ENGINE),
        ),
        _ => (
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            Body::from("Draw.io renderer asset not found"),
        ),
    };
    Some(
        response
            .status(status)
            .header("Content-Type", mime)
            .body(body)
            .unwrap(),
    )
}
