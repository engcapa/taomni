use std::ffi::c_void;
use std::time::{Duration, Instant};

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::{CFString, CFStringRef};
use serde_json::{Value, json};

type AxElement = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateSystemWide() -> AxElement;
    fn AXUIElementCopyAttributeValue(
        element: AxElement,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementGetPid(element: AxElement, pid: *mut libc::pid_t) -> i32;
}

fn attribute(element: AxElement, name: &str) -> Option<CFType> {
    let name = CFString::new(name);
    let mut value = std::ptr::null();
    // SAFETY: AX receives a live element and writable output pointer. A
    // successful Copy returns an owned CF object, released by CFType.
    unsafe {
        if element.is_null()
            || AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut value) != 0
            || value.is_null()
        {
            return None;
        }
        Some(CFType::wrap_under_create_rule(value))
    }
}

fn text(element: AxElement, name: &str) -> String {
    attribute(element, name)
        .and_then(|value| value.downcast::<CFString>())
        .map(|value| value.to_string())
        .unwrap_or_default()
}

fn owned_process(mut pid: libc::pid_t) -> bool {
    // macOS config dialogs are opened by an osascript child of the QA app.
    // Accept only this app or its descendants before sending global input.
    for _ in 0..8 {
        if pid == std::process::id() as libc::pid_t {
            return true;
        }
        if pid <= 1 {
            return false;
        }
        // SAFETY: proc_pidinfo writes only into the sized, initialized struct.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if read != size || info.pbi_ppid == pid as u32 {
            return false;
        }
        pid = info.pbi_ppid as libc::pid_t;
    }
    false
}

fn snapshot() -> Value {
    // SAFETY: Create returns an owned AX object managed by CFType. All other
    // element objects remain retained while their attributes are queried.
    let system = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateSystemWide()) };
    let Some(focus) = attribute(system.as_CFTypeRef(), "AXFocusedUIElement") else {
        return json!({"ready":false,"error":"no focused AX element"});
    };
    let element = focus.as_CFTypeRef();
    let mut pid = 0;
    let queried = unsafe { AXUIElementGetPid(element, &mut pid) == 0 };
    let owned = queried && owned_process(pid);
    let role = text(element, "AXRole");
    let enabled = attribute(element, "AXEnabled")
        .and_then(|value| value.downcast::<CFBoolean>())
        .is_some_and(|value| bool::from(value));
    let value = text(element, "AXValue");
    let window = attribute(element, "AXWindow");
    let window_title = window
        .as_ref()
        .map(|window| text(window.as_CFTypeRef(), "AXTitle"));
    json!({"ready":owned && enabled && matches!(role.as_str(), "AXTextField" | "AXComboBox"),
        "processId":pid,"ownProcessTree":owned,"role":role,"enabled":enabled,"value":value,
        "description":text(element,"AXDescription"),"windowTitle":window_title})
}

fn wait_field(stage: &str, accepts: impl Fn(&str) -> bool) -> anyhow::Result<Value> {
    let started = Instant::now();
    loop {
        let mut state = snapshot();
        state["stage"] = json!(stage);
        state["waitedMs"] = json!(started.elapsed().as_millis());
        if state["ready"] == true && state["value"].as_str().is_some_and(&accepts) {
            return Ok(state);
        }
        if started.elapsed() >= Duration::from_secs(20) {
            anyhow::bail!("QA macOS save dialog input did not become ready: {state}");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(super) async fn wait_ready() -> anyhow::Result<Value> {
    tokio::task::spawn_blocking(|| wait_field("filename", |value| value.starts_with("Taomni-pin")))
        .await?
}

/// Called on the OS input worker after each keyboard transition. Checking
/// the focused field also catches truncated typing in a cold native panel.
pub(super) fn wait_value(expected: &str) -> anyhow::Result<Value> {
    wait_field("typed-value", |value| value == expected)
}

pub(super) fn wait_folder_field(filename: &str) -> anyhow::Result<Value> {
    wait_field("go-to-folder", |value| value != filename)
}
