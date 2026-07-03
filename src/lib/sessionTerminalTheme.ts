import type { SessionConfig } from "./ipc";
import {
  DEFAULT_TERMINAL_PROFILE,
  getSessionTerminalProfile,
  parseSessionOptions,
  type TerminalProfile,
} from "./terminalProfile";

export function isTerminalThemeSession(session: SessionConfig): boolean {
  return session.session_type !== "Mail";
}

export function getSessionTerminalTheme(session: SessionConfig): string {
  return (getSessionTerminalProfile(session.options_json) ?? DEFAULT_TERMINAL_PROFILE).theme;
}

export function getSessionTerminalProfileForThemeUpdate(session: SessionConfig): TerminalProfile {
  return getSessionTerminalProfile(session.options_json) ?? DEFAULT_TERMINAL_PROFILE;
}

export function withSessionTerminalTheme(
  session: SessionConfig,
  theme: string,
  updatedAt: number,
): SessionConfig {
  const options = parseSessionOptions(session.options_json);
  const terminalProfile = {
    ...getSessionTerminalProfileForThemeUpdate(session),
    theme,
  };
  return {
    ...session,
    options_json: JSON.stringify({
      ...options,
      terminalProfile,
    }),
    updated_at: updatedAt,
  };
}
