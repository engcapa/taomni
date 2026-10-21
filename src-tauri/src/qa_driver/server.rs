use super::about::native_about;
use super::actions::actions;
use super::actions::execute_sync;
use super::actions::release_actions;
use super::capture::desktop_screenshot;
use super::capture::screenshot;
use super::elements::element_clear;
use super::elements::element_click;
use super::elements::element_rect;
use super::elements::element_text;
use super::elements::element_value;
use super::elements::find_element;
use super::elements::find_elements;
use super::model::BRIDGE_STARTED;
use super::model::DriverState;
use super::response::error;
use super::session::create_session;
use super::session::current_url;
use super::session::delete_session;
use super::session::refresh;
use super::session::status;
use axum::Router;
use axum::routing::delete;
use axum::routing::get;
use axum::routing::post;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Runtime;
use tauri::WebviewWindow;
use tokio::sync::Mutex;

/// Start the opt-in bridge and return immediately so Tauri can finish setup.
pub fn start<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, host: String, port: u16) {
    if BRIDGE_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let state = DriverState {
        app,
        window,
        elements: Arc::new(Mutex::new(HashMap::new())),
        next_element: Arc::new(AtomicU64::new(1)),
    };
    tauri::async_runtime::spawn(async move {
        let address = format!("{host}:{port}");
        let listener = match tokio::net::TcpListener::bind(&address).await {
            Ok(listener) => listener,
            Err(error) => {
                log::error!("qa webdriver bridge failed to bind {address}: {error}");
                return;
            }
        };
        let router = Router::new()
            .route("/status", get(status))
            .route("/session", post(create_session))
            .route("/session/{session_id}", delete(delete_session::<R>))
            .route("/session/{session_id}/element", post(find_element::<R>))
            .route("/session/{session_id}/elements", post(find_elements::<R>))
            .route(
                "/session/{session_id}/element/{element_id}/click",
                post(element_click::<R>),
            )
            .route(
                "/session/{session_id}/element/{element_id}/rect",
                get(element_rect::<R>),
            )
            .route(
                "/session/{session_id}/element/{element_id}/text",
                get(element_text::<R>),
            )
            .route(
                "/session/{session_id}/element/{element_id}/value",
                post(element_value::<R>),
            )
            .route(
                "/session/{session_id}/element/{element_id}/clear",
                post(element_clear::<R>),
            )
            .route(
                "/session/{session_id}/actions",
                post(actions::<R>).delete(release_actions),
            )
            .route(
                "/session/{session_id}/execute/sync",
                post(execute_sync::<R>),
            )
            .route(
                "/session/{session_id}/qa/native-about",
                post(native_about::<R>),
            )
            .route("/session/{session_id}/refresh", post(refresh::<R>))
            .route("/session/{session_id}/url", get(current_url::<R>))
            .route("/session/{session_id}/screenshot", get(screenshot::<R>))
            .route(
                "/session/{session_id}/qa/desktop-screenshot",
                get(desktop_screenshot),
            )
            .with_state(state);
        log::info!("qa webdriver bridge listening on {address}");
        if let Err(error) = axum::serve(listener, router).await {
            log::error!("qa webdriver bridge stopped: {error}");
        }
    });
}
