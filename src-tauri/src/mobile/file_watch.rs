//! Coarse invalidation: a bounded dirty set keeps builds from flooding events.
use super::server::Service;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

pub fn watch(service: Service) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use notify::{RecursiveMode, Watcher};
        let mut watches = HashMap::new();
        let dirty = Arc::new(Mutex::new(HashSet::new()));
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        loop {
            let roots = service
                .runtime
                .file_roots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            watches.retain(|id, (root, _)| roots.get(id) == Some(root));
            for (id, root) in roots {
                if watches.contains_key(&id) {
                    continue;
                }
                let pending = dirty.clone();
                let task = id.clone();
                let base = root.clone();
                let watcher =
                    notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                        let changed = match result {
                            Ok(event)
                                if event.kind.is_modify()
                                    || event.kind.is_create()
                                    || event.kind.is_remove() =>
                            {
                                event.paths.iter().any(|path| {
                                    path.strip_prefix(&base).is_ok_and(|relative| {
                                        !relative.components().any(|c| {
                                            matches!(
                                                c.as_os_str().to_str(),
                                                Some(".git" | "node_modules" | "target")
                                            )
                                        })
                                    })
                                })
                            }
                            Err(_) => true,
                            _ => false,
                        };
                        if changed {
                            pending
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .insert(task.clone());
                        }
                    });
                if let Ok(mut watcher) = watcher {
                    if watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
                        watches.insert(id, (root, watcher));
                    }
                }
            }
            tokio::select! {
                _ = service.cancel.cancelled() => break,
                _ = service.runtime.roots_changed.notified() => {},
                _ = tick.tick() => {
                    let changed = std::mem::take(&mut *dirty.lock().unwrap_or_else(|e| e.into_inner()));
                    for id in changed {
                        if watches.contains_key(&id) {
                            service.runtime.events.publish(serde_json::json!({"type":"file_changed", "task_id":format!("thread:{id}"), "change_kind":"changed"}));
                        }
                    }
                }
            }
        }
    })
}
