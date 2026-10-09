//! Native Wayland shortcuts belong to the compositor's GlobalShortcuts portal.
//! An X11 grab can succeed on XWayland while never receiving Wayland input.

use super::*;
use ashpd::desktop::{
    Session,
    global_shortcuts::{GlobalShortcuts, NewShortcut},
};
use futures::StreamExt;
use tokio::sync::{Mutex as AsyncMutex, OnceCell};

struct Registration {
    session: Session<'static, GlobalShortcuts<'static>>,
    listener: tokio::task::JoinHandle<()>,
}

static REGISTRATION: AsyncMutex<Option<Registration>> = AsyncMutex::const_new(None);
static HOST_IDENTITY: OnceCell<()> = OnceCell::const_new();

/// XDG shortcut triggers use XKB key names and uppercase modifier names.
fn trigger(shortcut: Shortcut) -> String {
    shortcut
        .into_string()
        .split('+')
        .map(|part| match part {
            "control" => "CTRL".into(),
            "shift" => "SHIFT".into(),
            "alt" => "ALT".into(),
            "super" => "LOGO".into(),
            key => key
                .strip_prefix("Key")
                .or_else(|| key.strip_prefix("Digit"))
                .unwrap_or(key)
                .into(),
        })
        .collect::<Vec<String>>()
        .join("+")
}

pub(super) async fn ensure_identity(identifier: &str) -> Result<(), String> {
    // Host processes have no sandbox metadata from which the portal can infer
    // an app ID. Register on ashpd's shared bus connection before opening the
    // shortcut session. This identifies the app; BindShortcuts still requests
    // the user's permission for each new binding.
    HOST_IDENTITY
        .get_or_try_init(|| async {
            let app_id = identifier
                .parse::<ashpd::AppID>()
                .map_err(|e| format!("shortcut application ID: {e}"))?;
            ashpd::register_host_app(app_id)
                .await
                .map_err(|e| format!("register shortcut application: {e}"))
        })
        .await?;
    Ok(())
}

async fn register(app: &AppHandle, shortcut: Shortcut) -> Result<Registration, String> {
    ensure_identity(&app.config().identifier).await?;
    let portal = GlobalShortcuts::new()
        .await
        .map_err(|e| format!("GlobalShortcuts portal: {e}"))?;
    let session = portal
        .create_session()
        .await
        .map_err(|e| format!("create shortcut session: {e}"))?;
    let id = format!("taomni-screenshot-{}", shortcut.id());
    let preferred = trigger(shortcut);
    let request =
        NewShortcut::new(&id, "Take a screenshot").preferred_trigger(Some(preferred.as_str()));
    let events = match portal.receive_activated().await {
        Ok(events) => events,
        Err(error) => {
            let _ = session.close().await;
            return Err(format!("listen for shortcut activation: {error}"));
        }
    };
    let bound = async {
        portal
            .bind_shortcuts(&session, &[request], None)
            .await?
            .response()
    }
    .await;
    match bound {
        Ok(response)
            if response
                .shortcuts()
                .iter()
                .any(|s| s.id() == id && !s.trigger_description().is_empty()) => {}
        result => {
            let _ = session.close().await;
            return Err(format!(
                "desktop did not grant screenshot shortcut '{preferred}': {result:?}"
            ));
        }
    }
    let session_path = match serde_json::to_value(&session) {
        Ok(path) => path,
        Err(error) => {
            let _ = session.close().await;
            return Err(error.to_string());
        }
    };
    let app = app.clone();
    let listener = tokio::spawn(async move {
        let mut events = Box::pin(events);
        while let Some(event) = events.next().await {
            if event.shortcut_id() == id
                && session_path.as_str() == Some(event.session_handle().as_str())
            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_from_shortcut(&app).await {
                        log::warn!("Wayland screenshot shortcut: {error}");
                    }
                });
            }
        }
    });
    Ok(Registration { session, listener })
}

pub(super) async fn apply(app: &AppHandle, accelerator: String) -> Result<ShortcutStatus, String> {
    let shortcut = if accelerator.is_empty() {
        None
    } else {
        Some(parse(&accelerator)?)
    };
    let mut registration = REGISTRATION.lock().await;
    if let Some(current) = CURRENT.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        if current.accelerator == accelerator && (registration.is_some() || shortcut.is_none()) {
            return Ok(status_of(current));
        }
    }
    // Keep the previous live session until the compositor accepts the change.
    // Cancelling its real consent dialog leaves the old binding operational.
    let next = match shortcut {
        Some(s) => Some(register(app, s).await?),
        None => None,
    };
    if let Some(previous) = registration.take() {
        previous.listener.abort();
        let _ = previous.session.close().await;
    }
    *registration = next;
    let current = Current {
        accelerator,
        registered: shortcut,
        error: None,
    };
    let status = status_of(&current);
    *CURRENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(current);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portal_trigger_preserves_modifiers_letters_digits_and_function_keys() {
        for (input, expected) in [
            ("Control+Shift+F9", "SHIFT+CTRL+F9"),
            ("Control+Alt+A", "CTRL+ALT+A"),
            ("Super+5", "LOGO+5"),
        ] {
            assert_eq!(trigger(parse(input).unwrap()), expected);
        }
    }
}
