# VNC client

The provisional module host owns VNC connections and their WebSocket relays.
It accepts a direct endpoint or an authenticated desktop-managed loopback
route, then returns an ephemeral relay token and session ID. The host keeps
live sessions in memory. The desktop owns saved session records and supplies
credentials for each connection.

The hosted protocol workflow verifies single-use forwarding, framebuffer bytes,
cancellation during RFB setup, explicit close, and upstream socket release when
the host exits.
The desktop adapter routes an enabled module's connections through the signed
host. Disabling or uninstalling the module unmounts the viewer and keeps its
saved session. The release desktop loads the viewer from the active signed
version. The saved-session and quick-connect routes use the same module loader
in the main window, Workspace and detached windows.

`pnpm exec vite build --config src-tauri/plugins/vnc-client/vite.config.ts`
builds the standalone ESM at `dist/frontend/index.js` within the module
directory. The bundle uses the core's React, Zustand, context menu, screenshot,
clipboard and VNC session bridge. Its CSS travels with the ESM and is removed
when its view unmounts. The build rejects bundled core implementations and
unresolved ESM imports. Development and isolated QA builds include a fallback
for retained cases using an uninstalled fixture.

The signed QA and module release workflows build the renderer from matching
trusted inputs in a separate job. They attach its verified bytes at
`frontend/index.js` before signing the archive. TC-MODULES-053 checks the
versioned native URL, real frame pixels, input, disable and enable, and a
detached WebView that reattaches to the original main window. TC-MODULES-054
checks the corresponding development preview flow.

The Windows special-key helper builds from `key-helper/` without linking the
desktop application. The current VNC adapter starts it by executable name and
keeps the helper's input pipe open for the life of the owner. The helper
handles the existing special keys while a window owned by that process is
in the foreground.

The transition installer stages the helper under
`resources/vnc/windows/`. Development and native QA builds use the helper
beside the application binary. Native QA ties both binaries to the build
identity and verifies early and normal owner-pipe exit.

Windows VNC packages stage the helper beside the module host before signing the
archive. The signature covers the helper's bytes. An installed module starts its
packaged helper and owns its lifetime.
