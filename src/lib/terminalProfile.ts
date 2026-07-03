import type { ITheme } from "@xterm/xterm";
import { terminalThemes } from "./themes";
import { makeTerminalFontFamily, SYSTEM_MONOSPACE_FONT } from "./systemFonts";

export type TerminalCursorStyle = "block" | "underline" | "bar";
export type TerminalRightClickBehavior = "menu" | "paste" | "copy-or-paste";
export type TerminalSyntaxMode = "default" | "keywords" | "shell" | "cisco" | "perl" | "sql";
export type InlineSuggestionsSource = "history" | "history+path" | "history+path+ai";

export interface UserCommonCommand {
  command: string;
  description?: string;
}

export interface TerminalProfile {
  fontFamily: string;
  fontSize: number;
  fontLigatures: boolean;
  theme: string;
  scrollback: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  showScrollbar: boolean;
  webglRenderer: boolean;
  copyOnSelect: boolean;
  allowRemoteOsc52Clipboard: boolean;
  rightClickBehavior: TerminalRightClickBehavior;
  readOnly: boolean;
  bracketedPaste: boolean;
  multilinePasteConfirm: boolean;
  syntaxMode: TerminalSyntaxMode;
  loggingEnabled: boolean;
  logPath?: string;
  inlineSuggestions: boolean;
  inlineSuggestionsMax: number;
  inlineSuggestionsSource: InlineSuggestionsSource;
  aiCommandRewriteEnabled: boolean;
  aiCommandRewriteShortcut: string;
  /// Experimental: render `?? <q>` inline in the terminal (ANSI-styled) when
  /// true, instead of routing the question to the AI Chat Drawer. Off by
  /// default — see plan §8.4 for the safety considerations.
  aiInlineQqRender: boolean;
  commonCommands: UserCommonCommand[];
  commonCommandsShortcut: string;
}

export const SYSTEM_TERMINAL_THEME = "system";
export const SYSTEM_DARK_TERMINAL_THEME = "termius-dark";
export const SYSTEM_LIGHT_TERMINAL_THEME = "termius-light";

export const DEFAULT_TERMINAL_PROFILE: TerminalProfile = {
  fontFamily: makeTerminalFontFamily(SYSTEM_MONOSPACE_FONT),
  fontSize: 14,
  fontLigatures: false,
  theme: SYSTEM_TERMINAL_THEME,
  scrollback: 10000,
  cursorStyle: "block",
  cursorBlink: true,
  showScrollbar: true,
  webglRenderer: true,
  copyOnSelect: false,
  allowRemoteOsc52Clipboard: false,
  rightClickBehavior: "menu",
  readOnly: false,
  bracketedPaste: true,
  multilinePasteConfirm: true,
  syntaxMode: "default",
  loggingEnabled: false,
  inlineSuggestions: true,
  inlineSuggestionsMax: 2000,
  inlineSuggestionsSource: "history",
  aiCommandRewriteEnabled: false,
  aiCommandRewriteShortcut: "Ctrl+K",
  aiInlineQqRender: false,
  commonCommands: [],
  commonCommandsShortcut: "Ctrl+Shift+P",
};

export const DEFAULT_LOCAL_TERMINAL_PROFILE: TerminalProfile = {
  ...DEFAULT_TERMINAL_PROFILE,
  theme: "classic",
};

export const DEFAULT_MAIL_TERMINAL_PROFILE: TerminalProfile = {
  ...DEFAULT_TERMINAL_PROFILE,
  theme: SYSTEM_TERMINAL_THEME,
};

const LOCAL_TERMINAL_PROFILE_STORAGE_KEY = "taomni.localTerminalProfile.v1";

export function parseSessionOptions(optionsJson: string | null | undefined): Record<string, unknown> {
  if (!optionsJson?.trim()) return {};
  try {
    const parsed = JSON.parse(optionsJson) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isWslSessionOptions(optionsJson: string | null | undefined): boolean {
  const options = parseSessionOptions(optionsJson);
  const path = typeof options.localShellPath === "string" ? options.localShellPath : "";
  const basename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return basename === "wsl.exe";
}

export function sessionTypeLabel(
  sessionType: string | undefined | null,
  optionsJson: string | null | undefined,
): string {
  if (sessionType === "LocalShell" && isWslSessionOptions(optionsJson)) return "WSL";
  return sessionType ?? "";
}

export function getSessionTerminalProfile(optionsJson: string | null | undefined): TerminalProfile | undefined {
  const options = parseSessionOptions(optionsJson);
  if (!("terminalProfile" in options)) return undefined;
  return normalizeTerminalProfile(options.terminalProfile);
}

export function loadLocalTerminalDefaultProfile(): TerminalProfile {
  if (typeof window === "undefined") return DEFAULT_LOCAL_TERMINAL_PROFILE;
  try {
    const raw = window.localStorage.getItem(LOCAL_TERMINAL_PROFILE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : DEFAULT_LOCAL_TERMINAL_PROFILE;
    return normalizeTerminalProfile({
      ...DEFAULT_LOCAL_TERMINAL_PROFILE,
      ...(isRecord(parsed) ? parsed : {}),
    });
  } catch {
    return DEFAULT_LOCAL_TERMINAL_PROFILE;
  }
}

export function saveLocalTerminalDefaultProfile(profile: TerminalProfile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LOCAL_TERMINAL_PROFILE_STORAGE_KEY,
      JSON.stringify(normalizeTerminalProfile(profile)),
    );
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

export function normalizeTerminalProfile(input: unknown): TerminalProfile {
  const source = isRecord(input) ? input : {};
  const profile: TerminalProfile = {
    fontFamily: readString(source.fontFamily, DEFAULT_TERMINAL_PROFILE.fontFamily),
    fontSize: clampInteger(source.fontSize, DEFAULT_TERMINAL_PROFILE.fontSize, 8, 32),
    fontLigatures: readBoolean(source.fontLigatures, DEFAULT_TERMINAL_PROFILE.fontLigatures),
    theme: readString(source.theme, DEFAULT_TERMINAL_PROFILE.theme),
    scrollback: clampInteger(source.scrollback, DEFAULT_TERMINAL_PROFILE.scrollback, 100, 200000),
    cursorStyle: readEnum(
      source.cursorStyle,
      ["block", "underline", "bar"] as const,
      DEFAULT_TERMINAL_PROFILE.cursorStyle,
    ),
    cursorBlink: readBoolean(source.cursorBlink, DEFAULT_TERMINAL_PROFILE.cursorBlink),
    showScrollbar: readBoolean(source.showScrollbar, DEFAULT_TERMINAL_PROFILE.showScrollbar),
    webglRenderer: readBoolean(source.webglRenderer, DEFAULT_TERMINAL_PROFILE.webglRenderer),
    copyOnSelect: readBoolean(source.copyOnSelect, DEFAULT_TERMINAL_PROFILE.copyOnSelect),
    allowRemoteOsc52Clipboard: readBoolean(
      source.allowRemoteOsc52Clipboard,
      DEFAULT_TERMINAL_PROFILE.allowRemoteOsc52Clipboard,
    ),
    rightClickBehavior: readEnum(
      source.rightClickBehavior,
      ["menu", "paste", "copy-or-paste"] as const,
      DEFAULT_TERMINAL_PROFILE.rightClickBehavior,
    ),
    readOnly: readBoolean(source.readOnly, DEFAULT_TERMINAL_PROFILE.readOnly),
    bracketedPaste: readBoolean(source.bracketedPaste, DEFAULT_TERMINAL_PROFILE.bracketedPaste),
    multilinePasteConfirm: readBoolean(
      source.multilinePasteConfirm,
      DEFAULT_TERMINAL_PROFILE.multilinePasteConfirm,
    ),
    syntaxMode: readEnum(
      source.syntaxMode,
      ["default", "keywords", "shell", "cisco", "perl", "sql"] as const,
      DEFAULT_TERMINAL_PROFILE.syntaxMode,
    ),
    loggingEnabled: readBoolean(source.loggingEnabled, DEFAULT_TERMINAL_PROFILE.loggingEnabled),
    inlineSuggestions: readBoolean(source.inlineSuggestions, DEFAULT_TERMINAL_PROFILE.inlineSuggestions),
    inlineSuggestionsMax: clampInteger(
      source.inlineSuggestionsMax,
      DEFAULT_TERMINAL_PROFILE.inlineSuggestionsMax,
      100,
      50000,
    ),
    inlineSuggestionsSource: readEnum(
      source.inlineSuggestionsSource,
      ["history", "history+path", "history+path+ai"] as const,
      DEFAULT_TERMINAL_PROFILE.inlineSuggestionsSource,
    ),
    aiCommandRewriteEnabled: readBoolean(source.aiCommandRewriteEnabled, DEFAULT_TERMINAL_PROFILE.aiCommandRewriteEnabled),
    aiCommandRewriteShortcut: readString(source.aiCommandRewriteShortcut, DEFAULT_TERMINAL_PROFILE.aiCommandRewriteShortcut),
    aiInlineQqRender: readBoolean(source.aiInlineQqRender, DEFAULT_TERMINAL_PROFILE.aiInlineQqRender),
    commonCommands: readCommonCommands(source.commonCommands),
    commonCommandsShortcut: readString(
      source.commonCommandsShortcut,
      DEFAULT_TERMINAL_PROFILE.commonCommandsShortcut,
    ),
  };

  const logPath = readOptionalString(source.logPath);
  if (logPath) profile.logPath = logPath;
  return profile;
}

export function makeCustomTerminalTheme(background: string, foreground: string): string {
  return `custom:${background}:${foreground}`;
}

export function isCustomTerminalTheme(theme: string): boolean {
  return parseCustomTerminalTheme(theme) !== null;
}

export function terminalProfileThemeColors(profile: TerminalProfile): { background: string; foreground: string } {
  const theme = resolveTerminalTheme(profile.theme);
  return {
    background: theme.background ?? terminalThemes.classic.background ?? "#1d1f21",
    foreground: theme.foreground ?? terminalThemes.classic.foreground ?? "#eaeaea",
  };
}

export function resolveSystemTerminalThemeId(prefersDark: boolean): string {
  return prefersDark ? SYSTEM_DARK_TERMINAL_THEME : SYSTEM_LIGHT_TERMINAL_THEME;
}

export function resolveTerminalThemeWithSystem(theme: string, prefersDark: boolean): ITheme {
  return resolveTerminalTheme(theme === SYSTEM_TERMINAL_THEME ? resolveSystemTerminalThemeId(prefersDark) : theme);
}

export function resolveTerminalTheme(theme: string): ITheme {
  if (terminalThemes[theme]) return terminalThemes[theme];
  const custom = parseCustomTerminalTheme(theme);
  if (!custom) return terminalThemes.classic;

  return {
    ...terminalThemes.classic,
    background: custom.background,
    foreground: custom.foreground,
  };
}

function parseCustomTerminalTheme(theme: string): { background: string; foreground: string } | null {
  const match = /^custom:(#[0-9a-fA-F]{6}):(#[0-9a-fA-F]{6})$/.exec(theme);
  if (!match) return null;
  return { background: match[1], foreground: match[2] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function readCommonCommands(value: unknown): UserCommonCommand[] {
  if (!Array.isArray(value)) return [];
  const out: UserCommonCommand[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command) continue;
    const desc = typeof raw.description === "string" ? raw.description.trim() : "";
    out.push(desc ? { command, description: desc } : { command });
  }
  return out;
}
