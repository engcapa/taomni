/**
 * Application command identifiers dispatched from the unified ControlBar app
 * menu (Windows/Linux) and the native macOS application menu. These used to
 * live on the now-removed Ribbon component as `RibbonCommand`; the compact-mode
 * and tool-button-bar toggles are gone since the chrome collapsed into a single
 * control bar.
 */
export type AppCommand =
  | "new-session"
  | "new-terminal"
  | "new-sftp"
  | "servers"
  | "tools"
  | "sessions"
  | "view"
  | "split"
  | "multiexec"
  | "tunneling"
  | "lan-chat"
  | "packages"
  | "settings"
  | "macros"
  | "help"
  | "toggle-xserver"
  | "exit"
  | "close-active"
  | "reload-sessions"
  | "toggle-quick-connect";
