# VNC client

The Windows special-key helper builds from `key-helper/` without linking the
desktop application. The current VNC adapter starts it by executable name and
keeps the helper's input pipe open for the life of the owner. The helper
handles the existing special keys while a window owned by that process is
in the foreground.

The transition installer stages the helper under
`resources/vnc/windows/`. Development and native QA builds use the helper
beside the application binary. Native QA ties both binaries to the build
identity and verifies early and normal owner-pipe exit.

The VNC module package will own this executable when the client host and
frontend move out of the desktop application.
