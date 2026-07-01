import type { CSSProperties } from "react";
import type { NotesTheme } from "../../stores/notesStore";

/**
 * Notes theme system (see tao-notes-feature-plan.md §9). A theme re-maps a
 * handful of `--taomni-*` CSS variables **locally** on the notes panel root, so
 * it restyles only the notes surface and cards without disturbing the global
 * app theme. "taomni" inherits the app theme unchanged; "system" follows the OS.
 * All palettes keep text readable against their background in both modes.
 */

type NotesPalette = Record<string, string>;

const LIGHT: NotesPalette = {
  "--taomni-bg": "#ffffff",
  "--taomni-sidebar-bg": "#f8fafc",
  "--taomni-panel-bg": "#f1f5f9",
  "--taomni-text": "#0f172a",
  "--taomni-text-muted": "#64748b",
  "--taomni-divider": "#e2e8f0",
  "--taomni-hover": "#f1f5f9",
  "--taomni-selected": "#e0e7ff",
  "--taomni-accent": "#4f46e5",
};

const DARK: NotesPalette = {
  "--taomni-bg": "#0f172a",
  "--taomni-sidebar-bg": "#111827",
  "--taomni-panel-bg": "#1e293b",
  "--taomni-text": "#f1f5f9",
  "--taomni-text-muted": "#94a3b8",
  "--taomni-divider": "#334155",
  "--taomni-hover": "#1e293b",
  "--taomni-selected": "#1e3a5f",
  "--taomni-accent": "#60a5fa",
};

const PAPER: NotesPalette = {
  "--taomni-bg": "#fdf6e3",
  "--taomni-sidebar-bg": "#f5ecd7",
  "--taomni-panel-bg": "#f0e6cc",
  "--taomni-text": "#4a3f2f",
  "--taomni-text-muted": "#8a7d63",
  "--taomni-divider": "#e0d4b0",
  "--taomni-hover": "#efe6cf",
  "--taomni-selected": "#efe0b8",
  "--taomni-accent": "#b45309",
};

export function resolveSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * CSS-variable overrides for a notes theme, applied as inline style on the notes
 * root. Returns an empty object for "taomni" and "compact" (they inherit the
 * app theme); "compact" additionally signals density via [data-density] below.
 */
export function notesThemeStyle(theme: NotesTheme): CSSProperties {
  switch (theme) {
    case "light":
      return LIGHT as CSSProperties;
    case "dark":
      return DARK as CSSProperties;
    case "paper":
      return PAPER as CSSProperties;
    case "system":
      return (resolveSystemTheme() === "dark" ? DARK : LIGHT) as CSSProperties;
    case "compact":
    case "taomni":
    default:
      return {};
  }
}

/** Density flag for the notes root — "compact" tightens spacing/typography. */
export function notesThemeDensity(theme: NotesTheme): "comfortable" | "compact" {
  return theme === "compact" ? "compact" : "comfortable";
}

export const NOTES_THEMES: NotesTheme[] = ["taomni", "system", "light", "dark", "paper", "compact"];
