import { type TerminalSplitLayout, type VaultUnlockMode } from "./types";

export const UI_FONT_FAMILY_KEY = "taomni.uiFontFamily";

export const UI_FONT_SIZE_KEY = "taomni.uiFontSize";

export const TERMINAL_SPLIT_LAYOUT_KEY = "taomni.terminalSplitLayout";

export const SQL_ECHO_KEY = "taomni.sqlEcho";

export const SIDEBAR_COLLAPSED_KEY = "taomni.sidebarCollapsed";

export const WORKSPACE_SIDEBAR_COLLAPSED_KEY = "taomni.workspaceSidebarCollapsed";

export const WELCOME_RECENT_SESSION_LIMIT_KEY = "taomni.welcomeRecentSessionLimit";

export const VAULT_UNLOCK_MODE_KEY = "taomni.vaultUnlockMode";

export const DEFAULT_WELCOME_RECENT_SESSION_LIMIT = 20;

export const MIN_WELCOME_RECENT_SESSION_LIMIT = 1;

export const MAX_WELCOME_RECENT_SESSION_LIMIT = 100;

export const MIN_UI_FONT_SIZE = 10;

export const MAX_UI_FONT_SIZE = 18;

export function readUiFontFamily(): string {
  try {
    return window.localStorage.getItem(UI_FONT_FAMILY_KEY) || "Inter";
  } catch {
    return "Inter";
  }
}

export function writeUiFontFamily(font: string) {
  try {
    window.localStorage.setItem(UI_FONT_FAMILY_KEY, font);
  } catch {
    // Ignore storage failures
  }
}

export function readUiFontSize(): number {
  try {
    const val = window.localStorage.getItem(UI_FONT_SIZE_KEY);
    if (val) {
      const parsed = parseInt(val, 10);
      if (!isNaN(parsed) && parsed >= MIN_UI_FONT_SIZE && parsed <= MAX_UI_FONT_SIZE) {
        return parsed;
      }
    }
    return 12;
  } catch {
    return 12;
  }
}

export function writeUiFontSize(size: number) {
  try {
    window.localStorage.setItem(UI_FONT_SIZE_KEY, size.toString());
  } catch {
    // Ignore storage failures
  }
}

export function clampUiFontSize(size: number): number {
  if (!Number.isFinite(size)) return 12;
  return Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(size)));
}

export function readTerminalSplitLayout(): TerminalSplitLayout {
  try {
    const value = window.localStorage.getItem(TERMINAL_SPLIT_LAYOUT_KEY);
    if (value === "horizontal" || value === "vertical" || value === "grid") {
      return value;
    }
    return "horizontal";
  } catch {
    return "horizontal";
  }
}

export function writeTerminalSplitLayout(layout: TerminalSplitLayout) {
  try {
    window.localStorage.setItem(TERMINAL_SPLIT_LAYOUT_KEY, layout);
  } catch {
    // Ignore storage failures; layout changes still apply for this run.
  }
}

export function readSqlEcho(): boolean {
  try {
    // Default on: only an explicit "false" disables it.
    return window.localStorage.getItem(SQL_ECHO_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeSqlEcho(enabled: boolean) {
  try {
    window.localStorage.setItem(SQL_ECHO_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage failures; the toggle still applies for this run.
  }
}

export function readVaultUnlockMode(): VaultUnlockMode {
  try {
    const value = window.localStorage.getItem(VAULT_UNLOCK_MODE_KEY);
    if (value === "on-demand") return "on-demand";
    return "startup";
  } catch {
    return "startup";
  }
}

export function writeVaultUnlockMode(mode: VaultUnlockMode) {
  try {
    window.localStorage.setItem(VAULT_UNLOCK_MODE_KEY, mode);
  } catch {
    // Ignore storage failures; the current session still reflects the change.
  }
}

export function readSidebarCollapsed(): boolean {
  try {
    const value = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (value === "true") return true;
    if (value === "false") return false;
    return false;
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
  } catch {
    // Ignore storage failures; the current session still reflects the change.
  }
}

export function readWorkspaceSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(WORKSPACE_SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeWorkspaceSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // The store still retains the preference for this run.
  }
}

export function clampWelcomeRecentSessionLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WELCOME_RECENT_SESSION_LIMIT;
  return Math.max(
    MIN_WELCOME_RECENT_SESSION_LIMIT,
    Math.min(MAX_WELCOME_RECENT_SESSION_LIMIT, Math.round(value)),
  );
}

export function readWelcomeRecentSessionLimit(): number {
  try {
    const value = window.localStorage.getItem(WELCOME_RECENT_SESSION_LIMIT_KEY);
    if (!value) return DEFAULT_WELCOME_RECENT_SESSION_LIMIT;
    return clampWelcomeRecentSessionLimit(parseInt(value, 10));
  } catch {
    return DEFAULT_WELCOME_RECENT_SESSION_LIMIT;
  }
}

export function writeWelcomeRecentSessionLimit(limit: number) {
  try {
    window.localStorage.setItem(
      WELCOME_RECENT_SESSION_LIMIT_KEY,
      String(clampWelcomeRecentSessionLimit(limit)),
    );
  } catch {
    // Ignore storage failures; the in-memory setting still applies.
  }
}

export const initialWelcomeRecentSessionLimit = readWelcomeRecentSessionLimit();
