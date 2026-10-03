import type { SessionConfig } from "./ipc";
import {
  getSessionTerminalProfile,
  loadTerminalDefaultProfile,
  normalizeTerminalProfile,
  parseSessionOptions,
  type TerminalProfile,
} from "./terminalProfile";

export type SessionTerminalAppearancePatch = Partial<Pick<TerminalProfile, "theme" | "fontFamily" | "fontSize">>;

const TERMINAL_APPEARANCE_SESSION_TYPES = new Set([
  "SSH",
  "LocalShell",
  "FTP",
  "Telnet",
  "Rlogin",
  "Serial",
  "Mosh",
]);

export function supportsTerminalAppearanceSessionType(sessionType: string | undefined | null): boolean {
  return !!sessionType && TERMINAL_APPEARANCE_SESSION_TYPES.has(sessionType);
}

export function isTerminalThemeSession(session: SessionConfig): boolean {
  return supportsTerminalAppearanceSessionType(session.session_type);
}

export function getSessionTerminalTheme(session: SessionConfig): string {
  return (getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile()).theme;
}

export function getSessionTerminalProfileForThemeUpdate(session: SessionConfig): TerminalProfile {
  return getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile();
}

export function withSessionTerminalTheme(
  session: SessionConfig,
  theme: string,
  updatedAt: number,
): SessionConfig {
  return withSessionTerminalAppearance(session, { theme }, updatedAt);
}

export function withSessionTerminalAppearance(
  session: SessionConfig,
  patch: SessionTerminalAppearancePatch,
  updatedAt: number,
): SessionConfig {
  const options = parseSessionOptions(session.options_json);
  const terminalProfile = normalizeTerminalProfile({
    ...getSessionTerminalProfileForThemeUpdate(session),
    ...patch,
  });
  return {
    ...session,
    options_json: JSON.stringify({
      ...options,
      terminalProfile,
    }),
    updated_at: updatedAt,
  };
}
