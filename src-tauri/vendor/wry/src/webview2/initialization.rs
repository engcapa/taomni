// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! WebView2 registers document-created scripts in every frame. Enforce the
//! caller's main-only intent *before* any bootstrap or invoke key executes.

pub(super) const IPC_BOOTSTRAP: &str = r#"Object.defineProperty(window, 'ipc', { value: Object.freeze({ postMessage: s => window.chrome.webview.postMessage(s) }) });"#;

pub(super) fn for_frame(script: String, main_frame_only: bool) -> String {
    if main_frame_only {
        // window.top is the engine's unforgeable WindowProxy. Cross-origin access
        // to its identity is allowed without reading its document or properties.
        // Newline before the closing brace also contains a trailing // comment.
        format!("if (window.top === window) {{\n{script}\n}}")
    } else {
        script
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_only_scripts_are_guarded_before_the_original_body() {
        let script = for_frame("initializeTauri(); // trailing comment".into(), true);
        assert!(script.starts_with("if (window.top === window) {\n"));
        assert!(script.ends_with("// trailing comment\n}"));
    }

    #[test]
    fn intentionally_all_frame_scripts_are_byte_identical() {
        let source = "window.sharedFrameFeature = true;";
        assert_eq!(for_frame(source.into(), false), source);
    }

    #[test]
    fn ipc_bootstrap_uses_the_same_main_only_guard() {
        let script = for_frame(IPC_BOOTSTRAP.into(), true);
        assert!(script.starts_with("if (window.top === window) {\n"));
        assert!(script.contains("window.chrome.webview.postMessage(s)"));
    }
}
