//! Console and redacted operational logging without a desktop runtime.
use super::MobileRuntime;
use std::sync::Arc;
struct Logger;
impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target().starts_with("taomni_lib") && metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("{} {}", record.level(), record.args());
        }
    }
    fn flush(&self) {}
}
static LOGGER: Logger = Logger;
pub fn initialize() {
    #[cfg(windows)]
    unsafe {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn AttachConsole(process: u32) -> i32;
            fn AllocConsole() -> i32;
        }
        if AttachConsole(u32::MAX) == 0 {
            AllocConsole();
        }
    }
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}
pub fn observe(runtime: Arc<MobileRuntime>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            timer.tick().await;
            let failures = runtime
                .auth
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .failed_attempts;
            let im = runtime.im.snapshot();
            // Only counters and fixed machine codes; never content or secrets.
            log::info!(
                "Mobile failures={failures}; Feishu state={} delivered={} failed={} rejected={} reconnects={}",
                im.state,
                im.delivered,
                im.failed_deliveries,
                im.rejected,
                im.reconnects
            );
        }
    })
}
pub fn secret(value: Option<String>) -> Result<zeroize::Zeroizing<String>, String> {
    value.filter(|v| !v.is_empty()).map(zeroize::Zeroizing::new)
        .ok_or_else(|| "Headless Feishu requires TAOMNI_FEISHU_APP_SECRET; the vault is locked and headless has no unlock prompt".into())
}
