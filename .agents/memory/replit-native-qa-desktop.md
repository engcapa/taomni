---
name: Opt-in Linux native desktop
description: Replit's opt-in virtual desktop and the Nix DBus session configuration required by FCITX5.
---

Linux native QA must only create a virtual desktop when `TAOMNI_NATIVE_QA_DESKTOP=1`; the wrapper is a no-op on developer machines that already provide their own display.

**Why:** Starting Xvfb globally changes ordinary app development and can conflict with a real X11/Wayland session. Replit's Nix `dbus-run-session` also cannot use the `/etc/dbus-1/session.conf` placeholder because it has no `<listen>` element; the usable session config is the Nix package's `share/dbus-1/session.conf`.

**How to apply:** Keep Xvfb/Fluxbox/display setup in the opt-in wrapper, run native cases through that wrapper, and pass the discovered Nix session configuration to `dbus-run-session` before launching FCITX5.