# Memory Index

- [react-resizable-panels v4 API](react-resizable-panels-v4.md) — repo pins v4: Group/Separator/orientation names, no autoSaveId, persist via defaultLayout+onLayoutChanged.
- [Parity doc audit lag](parity-doc-audit-lag.md) — claudedocs §2.11/§15.8 gap tables audit the previous commit; re-verify code before trusting "未交付" rows.
- [QA local service probes](qa-ui-auto-local-services.md) — MySQL readiness must use a real client query through the mapped host port; container exec is unreliable here.
- [Native WebDriver readiness](qa-native-webdriver-race.md) — tauri-driver can bind before WebKitWebDriver; wait for both ports and treat action-cleanup disconnects as best-effort.
