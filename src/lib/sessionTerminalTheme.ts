import type { SessionConfig } from "./ipc";
import {
  getSessionTerminalProfile,
  loadTerminalDefaultProfile,
  normalizeTerminalProfile,
  parseSessionOptions,
  type TerminalProfile,
} from "./terminalProfile";

export type SessionTerminalAppearancePatch = Partial<Pick<TerminalProfile, "theme" | "fontFamily" | "fontSize">>;

export function isTerminalThemeSession(session: SessionConfig): boolean {
  return session.session_type !== "Mail";
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
