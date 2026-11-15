//! HTML is parsed, not concatenated into srcdoc. Security response headers are
//! authoritative; a second meta CSP helps WebKit custom-protocol compatibility.
use super::html::Preview;
use crate::workspace::viewer_io::decode_text_bytes;
use tauri::utils::html2::{parse_doc, serialize_doc};

pub(super) fn csp(preview: &Preview) -> String {
    let root = preview.url_root();
    // Even after opt-in the WebView cannot contact HTTP(S): every request must
    // use the same token's native, strict proxy-aware GET transport.
    let network = "";
    let scripts = if preview.allow_scripts {
        format!("{root} 'unsafe-inline' 'unsafe-eval'{network}")
    } else {
        format!("'nonce-{}'", preview.nonce)
    };
    // sandbox creates an opaque origin even if a renderer accidentally omits
    // its sandbox attribute. It never grants same-origin, popups or top-nav.
    format!(
        "default-src 'none'; sandbox allow-scripts; script-src {scripts}; \
         style-src {root} 'unsafe-inline'{network}; img-src {root} data: blob:{network}; \
         media-src {root} data: blob:{network}; font-src {root} data:{network}; \
         connect-src {root}{network}; frame-src 'none'; child-src 'none'; \
         worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
}

pub(super) fn document(bytes: &[u8], preview: &Preview) -> Result<Vec<u8>, String> {
    document_with_base(bytes, preview, None)
}

pub(super) fn document_with_base(
    bytes: &[u8],
    preview: &Preview,
    base: Option<&url::Url>,
) -> Result<Vec<u8>, String> {
    let (source, _, _) =
        decode_text_bytes(bytes, None).map_err(|error| format!("binary: {error}"))?;
    let document = parse_doc(source);
    // Meta refresh bypasses click mediation. Base can redirect relative URLs;
    // CSP already rejects it, and removing it also avoids engine differences.
    document.select("base, meta[http-equiv]").remove();
    if !preview.allow_scripts {
        document.select("script").remove();
        for node in document.select("*").nodes() {
            for attr in node.attrs() {
                let name = attr.name.local.as_ref();
                if name.starts_with("on") || name == "nonce" {
                    node.remove_attr(name);
                }
            }
        }
    }
    // Static resources are routed before the parser can start loading them.
    for node in document.select("*").nodes() {
        for attribute in ["src", "poster", "background", "data"] {
            if let Some(value) = node.attr(attribute) {
                let rewritten = super::network_rewrite::reference(&value, base, preview)?;
                node.set_attr(attribute, &rewritten);
            }
        }
        if node
            .node_name()
            .is_some_and(|name| matches!(name.as_ref(), "link" | "image" | "use"))
        {
            if let Some(value) = node.attr("href") {
                let rewritten = super::network_rewrite::reference(&value, base, preview)?;
                node.set_attr("href", &rewritten);
            }
        }
        if let Some(value) = node.attr("srcset") {
            node.set_attr(
                "srcset",
                &super::network_rewrite::srcset(&value, base, preview)?,
            );
        }
        if let Some(value) = node.attr("style") {
            node.set_attr(
                "style",
                &super::network_rewrite::css(&value, base, preview)?,
            );
        }
        // Remote resource module relative imports remain unmediated and CSP
        // rejects them; do not accidentally allow their origin through.
    }
    for node in document.select("style").nodes() {
        let rewritten = super::network_rewrite::css(&node.text(), base, preview)?;
        node.set_text(rewritten.as_str());
    }
    let head = document.head().ok_or("binary: HTML document has no head")?;
    let bridge = document.tree.new_element("script");
    bridge.set_attr("nonce", &preview.nonce);
    let script = include_str!("html_bridge.js")
        .replace(
            "__VIEWER_NETWORK_BRIDGE__",
            include_str!("html_network_bridge.js"),
        )
        .replace(
            "__VIEWER_ALLOW_NETWORK__",
            if preview.allow_network {
                "true"
            } else {
                "false"
            },
        )
        .replace(
            "__VIEWER_SOURCE_BASE__",
            &serde_json::to_string(&base.map(url::Url::as_str)).unwrap(),
        )
        .replace(
            "__VIEWER_TOKEN__",
            &serde_json::to_string(&preview.token).unwrap(),
        )
        .replace(
            "__VIEWER_ROOT__",
            &serde_json::to_string(&preview.url_root()).unwrap(),
        );
    bridge.set_text(script.as_str());
    head.prepend_child(&bridge);
    let meta = document.tree.new_element("meta");
    meta.set_attr("http-equiv", "Content-Security-Policy");
    meta.set_attr("content", &csp(preview));
    head.prepend_child(&meta);
    let charset = document.tree.new_element("meta");
    charset.set_attr("charset", "utf-8");
    head.prepend_child(&charset);
    // Never retain a legacy charset after rewriting the response to UTF-8.
    for meta in document.select("meta[charset]").nodes().iter().skip(1) {
        meta.remove_attr("charset");
    }
    Ok(serialize_doc(&document))
}
