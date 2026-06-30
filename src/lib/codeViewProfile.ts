import type { ITheme } from "@xterm/xterm";
import { DEFAULT_TERMINAL_PROFILE, resolveTerminalTheme, type TerminalProfile } from "./terminalProfile";
import { makeTerminalFontFamily } from "./systemFonts";
import { resolveThemeId, terminalThemes } from "./themes";

export const CODE_VIEW_THEME_APP = "app";
export const CODE_VIEW_THEME_TERMINAL = "terminal";

export interface CodeViewProfile {
  fontFamily: string;
  fontSize: number;
  fontLigatures: boolean;
  theme: string;
}

export const DEFAULT_CODE_VIEW_PROFILE: CodeViewProfile = {
  fontFamily: makeTerminalFontFamily("JetBrains Mono"),
  fontSize: 13,
  fontLigatures: true,
  theme: CODE_VIEW_THEME_APP,
};

const CODE_VIEW_PROFILE_STORAGE_KEY = "taomni.codeViewProfile.v1";

const CODE_THEME_COLOR_VARS = [
  "--taomni-code-bg",
  "--taomni-code-gutter-bg",
  "--taomni-code-text",
  "--taomni-code-muted",
  "--taomni-code-line-number",
  "--taomni-code-line-number-active",
  "--taomni-code-border",
  "--taomni-code-active-line-bg",
  "--taomni-code-active-line-gutter-bg",
  "--taomni-code-selection-bg",
  "--taomni-code-selection-text",
  "--taomni-code-selection-match-bg",
  "--taomni-code-selection-match-border",
  "--taomni-code-caret",
  "--taomni-code-bracket-match-bg",
  "--taomni-code-bracket-match-border",
  "--taomni-code-bracket-error-bg",
  "--taomni-code-tooltip-bg",
  "--taomni-code-scrollbar-track",
  "--taomni-code-scrollbar-thumb",
  "--taomni-code-syntax-keyword",
  "--taomni-code-syntax-variable",
  "--taomni-code-syntax-property",
  "--taomni-code-syntax-function",
  "--taomni-code-syntax-type",
  "--taomni-code-syntax-string",
  "--taomni-code-syntax-escape",
  "--taomni-code-syntax-number",
  "--taomni-code-syntax-atom",
  "--taomni-code-syntax-comment",
  "--taomni-code-syntax-operator",
  "--taomni-code-syntax-punctuation",
  "--taomni-code-syntax-link",
  "--taomni-code-syntax-heading",
  "--taomni-code-syntax-inserted",
  "--taomni-code-syntax-deleted",
  "--taomni-code-syntax-changed",
  "--taomni-code-syntax-invalid",
  "--taomni-code-diff-added-bg",
  "--taomni-code-diff-added-word",
  "--taomni-code-diff-deleted-bg",
  "--taomni-code-diff-deleted-word",
  "--taomni-code-diff-deleted-border",
  "--taomni-code-diff-modified-bg",
  "--taomni-code-diff-modified-word",
  "--taomni-code-diff-connector-added",
  "--taomni-code-diff-connector-deleted",
  "--taomni-code-diff-connector-modified",
  "--taomni-code-diff-connector-stroke",
] as const;

export function loadCodeViewProfile(): CodeViewProfile {
  if (typeof window === "undefined") return DEFAULT_CODE_VIEW_PROFILE;
  try {
    const raw = window.localStorage.getItem(CODE_VIEW_PROFILE_STORAGE_KEY);
    return normalizeCodeViewProfile(raw ? JSON.parse(raw) : undefined);
  } catch {
    return DEFAULT_CODE_VIEW_PROFILE;
  }
}

export function saveCodeViewProfile(profile: CodeViewProfile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CODE_VIEW_PROFILE_STORAGE_KEY,
      JSON.stringify(normalizeCodeViewProfile(profile)),
    );
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

export function normalizeCodeViewProfile(input: unknown): CodeViewProfile {
  const source = isRecord(input) ? input : {};
  return {
    fontFamily: readString(source.fontFamily, DEFAULT_CODE_VIEW_PROFILE.fontFamily),
    fontSize: clampInteger(source.fontSize, DEFAULT_CODE_VIEW_PROFILE.fontSize, 8, 32),
    fontLigatures: readBoolean(source.fontLigatures, DEFAULT_CODE_VIEW_PROFILE.fontLigatures),
    theme: readTheme(source.theme, DEFAULT_CODE_VIEW_PROFILE.theme),
  };
}

export function resolveCodeViewTerminalTheme(
  profile: CodeViewProfile,
  terminalProfile: TerminalProfile = DEFAULT_TERMINAL_PROFILE,
): ITheme | null {
  if (profile.theme === CODE_VIEW_THEME_APP) return null;
  if (profile.theme === CODE_VIEW_THEME_TERMINAL) return resolveTerminalTheme(terminalProfile.theme);
  return resolveTerminalTheme(profile.theme);
}

export function applyCodeViewProfile(
  profile: CodeViewProfile,
  terminalProfile: TerminalProfile = DEFAULT_TERMINAL_PROFILE,
  root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement,
): void {
  if (!root) return;
  const normalized = normalizeCodeViewProfile(profile);
  root.style.setProperty("--taomni-code-font-family", normalized.fontFamily);
  root.style.setProperty("--taomni-code-font-size", `${normalized.fontSize}px`);
  root.style.setProperty(
    "--taomni-code-font-features",
    normalized.fontLigatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
  );
  root.style.setProperty("--taomni-mono-font", "var(--taomni-code-font-family)");

  const theme = resolveCodeViewTerminalTheme(normalized, terminalProfile);
  if (!theme) {
    for (const variable of CODE_THEME_COLOR_VARS) {
      root.style.removeProperty(variable);
    }
    return;
  }

  const colors = codeThemeVariables(theme);
  for (const [variable, value] of Object.entries(colors)) {
    root.style.setProperty(variable, value);
  }
}

export function codeThemeVariables(theme: ITheme): Record<(typeof CODE_THEME_COLOR_VARS)[number], string> {
  const bg = color(theme.background, "#1d1f21");
  const fg = color(theme.foreground, "#eaeaea");
  const black = color(theme.black, bg);
  const red = color(theme.red, "#ff6b6b");
  const green = color(theme.green, "#62d36f");
  const yellow = color(theme.yellow, "#e3a85e");
  const blue = color(theme.blue, "#83a7d8");
  const magenta = color(theme.magenta, "#c792ea");
  const cyan = color(theme.cyan, "#89ddff");
  const white = color(theme.white, fg);
  const selection = color(theme.selectionBackground, mix(blue, 30, bg));
  const muted = mix(fg, 58, bg);

  return {
    "--taomni-code-bg": bg,
    "--taomni-code-gutter-bg": mix(black, 78, bg),
    "--taomni-code-text": fg,
    "--taomni-code-muted": muted,
    "--taomni-code-line-number": mix(fg, 48, bg),
    "--taomni-code-line-number-active": mix(fg, 82, bg),
    "--taomni-code-border": mix(fg, 18, bg),
    "--taomni-code-active-line-bg": mix(selection, 38, "transparent"),
    "--taomni-code-active-line-gutter-bg": mix(selection, 42, "transparent"),
    "--taomni-code-selection-bg": selection,
    "--taomni-code-selection-text": fg,
    "--taomni-code-selection-match-bg": mix(yellow, 26, "transparent"),
    "--taomni-code-selection-match-border": mix(yellow, 58, "transparent"),
    "--taomni-code-caret": color(theme.cursor, fg),
    "--taomni-code-bracket-match-bg": mix(green, 24, "transparent"),
    "--taomni-code-bracket-match-border": mix(green, 44, "transparent"),
    "--taomni-code-bracket-error-bg": mix(red, 18, "transparent"),
    "--taomni-code-tooltip-bg": mix(black, 82, bg),
    "--taomni-code-scrollbar-track": mix(black, 82, bg),
    "--taomni-code-scrollbar-thumb": mix(fg, 32, bg),
    "--taomni-code-syntax-keyword": yellow,
    "--taomni-code-syntax-variable": fg,
    "--taomni-code-syntax-property": magenta,
    "--taomni-code-syntax-function": blue,
    "--taomni-code-syntax-type": cyan,
    "--taomni-code-syntax-string": green,
    "--taomni-code-syntax-escape": red,
    "--taomni-code-syntax-number": mix(yellow, 82, white),
    "--taomni-code-syntax-atom": mix(yellow, 88, red),
    "--taomni-code-syntax-comment": muted,
    "--taomni-code-syntax-operator": mix(fg, 78, bg),
    "--taomni-code-syntax-punctuation": mix(fg, 64, bg),
    "--taomni-code-syntax-link": blue,
    "--taomni-code-syntax-heading": blue,
    "--taomni-code-syntax-inserted": green,
    "--taomni-code-syntax-deleted": red,
    "--taomni-code-syntax-changed": yellow,
    "--taomni-code-syntax-invalid": red,
    "--taomni-code-diff-added-bg": mix(green, 22, "transparent"),
    "--taomni-code-diff-added-word": mix(green, 38, "transparent"),
    "--taomni-code-diff-deleted-bg": mix(red, 19, "transparent"),
    "--taomni-code-diff-deleted-word": mix(red, 34, "transparent"),
    "--taomni-code-diff-deleted-border": red,
    "--taomni-code-diff-modified-bg": mix(blue, 18, "transparent"),
    "--taomni-code-diff-modified-word": mix(blue, 32, "transparent"),
    "--taomni-code-diff-connector-added": mix(green, 26, "transparent"),
    "--taomni-code-diff-connector-deleted": mix(red, 22, "transparent"),
    "--taomni-code-diff-connector-modified": mix(blue, 23, "transparent"),
    "--taomni-code-diff-connector-stroke": mix(fg, 22, "transparent"),
  };
}

function readTheme(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const theme = value.trim();
  if (theme === CODE_VIEW_THEME_APP || theme === CODE_VIEW_THEME_TERMINAL) return theme;
  return terminalThemes[resolveThemeId(theme)] ? theme : fallback;
}

function color(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function mix(colorValue: string, percent: number, target: string): string {
  return `color-mix(in srgb, ${colorValue} ${percent}%, ${target})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
