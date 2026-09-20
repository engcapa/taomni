# Memory Index

- [react-resizable-panels v4 API](react-resizable-panels-v4.md) — repo pins v4: Group/Separator/orientation names, no autoSaveId, persist via defaultLayout+onLayoutChanged.
- [Parity doc audit lag](parity-doc-audit-lag.md) — claudedocs §2.11/§15.8 gap tables audit the previous commit; re-verify code before trusting "未交付" rows.
- [QA local service probes](qa-ui-auto-local-services.md) — MySQL readiness must use a real client query through the mapped host port; container exec is unreliable here.
- [Native WebDriver readiness](qa-native-webdriver-race.md) — tauri-driver can bind before WebKitWebDriver; wait for both ports and treat action-cleanup disconnects as best-effort.
- [Nix native QA toolchain](nix-native-qa-toolchain.md) — select 64-bit libclang and pass GCC’s full header search paths to bindgen before rebuilding the isolated QA binary.
- [Opt-in Linux native desktop](replit-native-qa-desktop.md) — Replit uses an opt-in Xvfb/Fluxbox/DBus/FCITX5 wrapper; local desktop environments bypass it.
- [Replit bindgen target variables](replit-native-bindgen-target-vars.md) — generic clang header args did not unblock libspa-sys; validate target-specific x86_64 variables before native build.
- [Replit latest Rust QA toolchain](replit-latest-rust-qa-toolchain.md) — use rustup stable latest and a rustc wrapper that removes Replit's LD_AUDIT before native builds.
