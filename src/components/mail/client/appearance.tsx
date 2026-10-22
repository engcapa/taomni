import { type CSSProperties } from "react";
import { DEFAULT_MAIL_TERMINAL_PROFILE, type TerminalProfile } from "../../../lib/terminalProfile";
import { resolveMailTheme } from "../../../lib/mailTheme";

export const MAILBOX_RIBBON_THRESHOLD = 7;

export const MAILBOX_EXPANDED_SIZE = 14;

export const MAIL_BASE_FONT_SIZE = DEFAULT_MAIL_TERMINAL_PROFILE.fontSize;

export const MAIL_MIN_FONT_SIZE = 8;

export const MAIL_MAX_FONT_SIZE = 32;


export function clampMailFontSize(value: number): number {
  if (!Number.isFinite(value)) return MAIL_BASE_FONT_SIZE;
  return Math.min(MAIL_MAX_FONT_SIZE, Math.max(MAIL_MIN_FONT_SIZE, Math.round(value)));
}


export function color(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}


export function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return null;
  const raw = match[1];
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}


export function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}


export function mixColor(foreground: string, background: string, amount: number): string {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return amount >= 50 ? foreground : background;
  const ratio = Math.max(0, Math.min(100, amount)) / 100;
  const mixed = fg.map((channel, index) => channel * ratio + bg[index] * (1 - ratio));
  return `#${hex(mixed[0])}${hex(mixed[1])}${hex(mixed[2])}`;
}


export function colorLuminance(value: string): number | null {
  const rgb = parseHexColor(value);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}


export function mailAppearanceStyle(profile: TerminalProfile | undefined, fontSize: number, appPrefersDark: boolean): CSSProperties {
  const terminalProfile = profile ?? DEFAULT_MAIL_TERMINAL_PROFILE;
  const theme = resolveMailTheme(terminalProfile.theme, appPrefersDark);
  const background = color(theme.background, "#1d1f21");
  const foreground = color(theme.foreground, "#eaeaea");
  const accent = color(theme.blue ?? theme.cyan ?? theme.cursor, "#83a7d8");
  const darkBackground = (colorLuminance(background) ?? 0) < 0.5;
  const accentSoft = darkBackground
    ? mixColor(foreground, accent, 24)
    : mixColor(background, accent, 24);
  const divider = mixColor(foreground, background, 18);
  const buttonFrom = darkBackground
    ? mixColor(foreground, background, 12)
    : mixColor(foreground, background, 2);
  const buttonTo = darkBackground
    ? mixColor(foreground, background, 8)
    : mixColor(foreground, background, 7);
  const buttonHoverFrom = darkBackground
    ? mixColor(foreground, background, 18)
    : mixColor(foreground, background, 4);
  const buttonHoverTo = darkBackground
    ? mixColor(foreground, background, 13)
    : mixColor(foreground, background, 11);
  const buttonDisabled = darkBackground
    ? mixColor(foreground, background, 5)
    : mixColor(foreground, background, 6);
  return {
    "--taomni-color-scheme": darkBackground ? "dark" : "light",
    "--taomni-bg": background,
    "--taomni-panel-bg": mixColor(foreground, background, 5),
    "--taomni-sidebar-bg": mixColor(foreground, background, 8),
    "--taomni-chrome-bg": mixColor(foreground, background, 11),
    "--taomni-quick-bg": mixColor(foreground, background, 9),
    "--taomni-input-bg": mixColor(foreground, background, 6),
    "--taomni-input-border": divider,
    "--taomni-chrome-border": divider,
    "--taomni-divider": divider,
    "--taomni-hover": mixColor(accent, background, 16),
    "--taomni-selected": mixColor(accent, background, 26),
    "--taomni-accent": accent,
    "--taomni-accent-soft": accentSoft,
    "--taomni-button-from": buttonFrom,
    "--taomni-button-to": buttonTo,
    "--taomni-button-hover-from": buttonHoverFrom,
    "--taomni-button-hover-to": buttonHoverTo,
    "--taomni-button-disabled": buttonDisabled,
    "--taomni-text": foreground,
    "--taomni-text-muted": mixColor(foreground, background, 62),
    colorScheme: darkBackground ? "dark" : "light",
    fontFamily: terminalProfile.fontFamily || DEFAULT_MAIL_TERMINAL_PROFILE.fontFamily,
    zoom: clampMailFontSize(fontSize) / MAIL_BASE_FONT_SIZE,
  } as CSSProperties;
}
