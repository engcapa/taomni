# Sockscap macOS transparent-proxy provider

`SockscapTransparentProxyProvider.swift` is the real
`NETransparentProxyProvider` for the macOS transparent capture backend
(plan §4.1/§8, ADR-0003). It decides per flow whether the source app is in the
user-selected set and relays handled flows to the local Sockscap SOCKS5 backend
(port 1080) — so all routing/policy stays in the Rust engine.

## Why this lives here and not in the cargo build

A Network Extension provider must ship as a **system extension bundle**, built
as a **separate Xcode target** embedded in `Taomni.app/Contents/Library/
SystemExtensions/…`. It cannot be produced by `cargo build` (the main binary is
a Rust cdylib/staticlib). Turning this source into a loadable extension requires:

1. An Xcode Network Extension **App Proxy Provider** system-extension target.
2. The entitlement `com.apple.developer.networking.networkextension`
   = `[ app-proxy-provider-systemextension ]` on both the app and the extension.
3. A **Developer ID** signing identity and **notarization** of the app+extension.
4. User approval of the system extension on first activation (§8).

These are Apple-account / signing / hardware steps — external to a code-only
environment. Once the target exists, the Rust side manages the extension via
`OSSystemExtensionRequest` (activation) and hands it the selected app IDs; the
per-flow decision mirrors `sockscap::transparent::macos_provider_decision`.

## Integration checklist (Phase 6)

- [ ] Add the Xcode system-extension target that compiles this file.
- [ ] Wire `com.taomni.app` + extension entitlements and Developer ID signing.
- [ ] Notarize; verify user-approval + version-upgrade flows.
- [ ] Deliver the selected app signing identities via the provider configuration.
- [ ] Verify audit-token based identity and provider self-bypass.
