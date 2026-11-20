# VNC client

The provisional module host owns VNC connections and their WebSocket relays.
It accepts a direct endpoint or an authenticated desktop-managed loopback
route, then returns an ephemeral relay token and session ID. The host keeps
live sessions in memory. The desktop owns saved session records and supplies
credentials for each connection.

The hosted protocol workflow verifies single-use forwarding, framebuffer bytes,
cancellation during RFB setup, explicit close, and upstream socket release when
the host exits.
Desktop tabs continue to use the existing adapter while the signed frontend,
desktop routing and module packaging are being integrated.

The Windows special-key helper builds from `key-helper/` without linking the
desktop application. The current VNC adapter starts it by executable name and
keeps the helper's input pipe open for the life of the owner. The helper
handles the existing special keys while a window owned by that process is
in the foreground.

The transition installer stages the helper under
`resources/vnc/windows/`. Development and native QA builds use the helper
beside the application binary. Native QA ties both binaries to the build
identity and verifies early and normal owner-pipe exit.

The Windows signed VNC QA package carries the helper beside the module host in
the archive. The package signature covers the helper's bytes and the other
targets have only the declared module files. Desktop launches switch to the
module package when the client host and frontend move out of the application.
