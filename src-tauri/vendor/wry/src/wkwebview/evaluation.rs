// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use objc2::{runtime::AnyObject, AllocAnyThread};
use objc2_foundation::{NSError, NSJSONSerialization, NSString, NSUTF8StringEncoding};
#[cfg(feature = "tracing")]
use std::sync::Mutex;

#[cfg(target_os = "ios")]
use super::ios::WKWebView::WKWebView;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

use super::pending_scripts::ScriptEvaluation;

/// Both queued and immediate evaluations use the same WebKit completion path.
/// Callers release the pending queue lock before dispatching into WebKit.
pub(super) fn evaluate_script(webview: &WKWebView, evaluation: ScriptEvaluation) {
  // Safety: objc runtime calls are unsafe.
  unsafe {
    #[cfg(feature = "tracing")]
    let span = Mutex::new(Some(tracing::debug_span!("wry::eval").entered()));

    // Check outside the handler; passing a handler without a callback can segfault.
    if let Some(callback) = evaluation.callback {
      let handler = block2::RcBlock::new(move |val: *mut AnyObject, _err: *mut NSError| {
        #[cfg(feature = "tracing")]
        span.lock().unwrap().take();

        let mut result = String::new();
        if !val.is_null() {
          let json_ns_data = NSJSONSerialization::dataWithJSONObject_options_error(
            &*val,
            objc2_foundation::NSJSONWritingOptions::FragmentsAllowed,
          )
          .unwrap();
          let json_string = NSString::alloc();
          let json_string =
            NSString::initWithData_encoding(json_string, &json_ns_data, NSUTF8StringEncoding)
              .unwrap();
          result = json_string.to_string();
        }
        callback(result);
      });
      webview.evaluateJavaScript_completionHandler(
        &NSString::from_str(&evaluation.script),
        Some(&handler),
      );
    } else {
      #[cfg(feature = "tracing")]
      let handler = Some(block2::RcBlock::new(
        move |_val: *mut AnyObject, _err: *mut NSError| {
          span.lock().unwrap().take();
        },
      ));
      #[cfg(not(feature = "tracing"))]
      let handler: Option<block2::RcBlock<dyn Fn(*mut AnyObject, *mut NSError)>> = None;
      webview.evaluateJavaScript_completionHandler(
        &NSString::from_str(&evaluation.script),
        handler.as_deref(),
      );
    }
  }
}
