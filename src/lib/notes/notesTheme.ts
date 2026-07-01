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
  "--taomni-chrome-bg": "#f8fafc",
  "--taomni-sidebar-bg": "#f8fafc",
  "--taomni-panel-bg": "#f1f5f9",
  "--taomni-card-bg": "#ffffff",
  "--taomni-card-border": "#e2e8f0",
  "--taomni-text": "#0f172a",
  "--taomni-text-muted": "#64748b",
  "--taomni-divider": "#e2e8f0",
  "--taomni-hover": "#f1f5f9",
  "--taomni-selected": "#e0e7ff",
  "--taomni-selected-border": "#a5b4fc",
  "--taomni-accent": "#4f46e5",
  "--taomni-accent-soft": "#6366f1",
  "--taomni-control-hover": "rgba(15, 23, 42, 0.05)",
  "--taomni-input-bg": "#ffffff",
  "--taomni-input-border": "#cbd5e1",
  "--taomni-button-from": "#ffffff",
  "--taomni-button-to": "#f8fafc",
  "--taomni-button-hover-from": "#ffffff",
  "--taomni-button-hover-to": "#e2e8f0",
  "--taomni-button-disabled": "#f1f5f9",
  "--taomni-scrollbar-track": "#f8fafc",
  "--taomni-scrollbar-thumb": "#cbd5e1",
  "--taomni-scrollbar-thumb-hover": "#94a3b8",
  "--taomni-shadow-sm": "0 1px 2px rgba(15, 23, 42, 0.05)",
  "--taomni-shadow-md": "0 4px 16px -2px rgba(15, 23, 42, 0.06), 0 2px 4px -1px rgba(15, 23, 42, 0.02)",
  "--taomni-shadow-lg": "0 16px 24px -4px rgba(15, 23, 42, 0.08), 0 4px 8px -2px rgba(15, 23, 42, 0.04)",
};

const DARK: NotesPalette = {
  "--taomni-bg": "#0f172a",
  "--taomni-chrome-bg": "#111827",
  "--taomni-sidebar-bg": "#111827",
  "--taomni-panel-bg": "#1e293b",
  "--taomni-card-bg": "#172033",
  "--taomni-card-border": "#334155",
  "--taomni-text": "#f1f5f9",
  "--taomni-text-muted": "#94a3b8",
  "--taomni-divider": "#334155",
  "--taomni-hover": "#1e293b",
  "--taomni-selected": "#1e3a5f",
  "--taomni-selected-border": "#3b82f6",
  "--taomni-accent": "#60a5fa",
  "--taomni-accent-soft": "#93c5fd",
  "--taomni-control-hover": "rgba(255, 255, 255, 0.06)",
  "--taomni-input-bg": "#0f172a",
  "--taomni-input-border": "#334155",
  "--taomni-button-from": "#243044",
  "--taomni-button-to": "#172033",
  "--taomni-button-hover-from": "#334155",
  "--taomni-button-hover-to": "#243044",
  "--taomni-button-disabled": "#111827",
  "--taomni-scrollbar-track": "#111827",
  "--taomni-scrollbar-thumb": "#334155",
  "--taomni-scrollbar-thumb-hover": "#475569",
  "--taomni-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.24)",
  "--taomni-shadow-md": "0 4px 16px -2px rgba(0, 0, 0, 0.36), 0 2px 4px -1px rgba(0, 0, 0, 0.18)",
  "--taomni-shadow-lg": "0 16px 24px -4px rgba(0, 0, 0, 0.46), 0 4px 8px -2px rgba(0, 0, 0, 0.24)",
};

const PAPER: NotesPalette = {
  "--taomni-bg": "#fdf6e3",
  "--taomni-chrome-bg": "#f8efd9",
  "--taomni-sidebar-bg": "#f5ecd7",
  "--taomni-panel-bg": "#f0e6cc",
  "--taomni-card-bg": "#fff8e8",
  "--taomni-card-border": "#e0d4b0",
  "--taomni-text": "#4a3f2f",
  "--taomni-text-muted": "#8a7d63",
  "--taomni-divider": "#e0d4b0",
  "--taomni-hover": "#efe6cf",
  "--taomni-selected": "#efe0b8",
  "--taomni-selected-border": "#d6b36b",
  "--taomni-accent": "#b45309",
  "--taomni-accent-soft": "#d97706",
  "--taomni-control-hover": "rgba(74, 63, 47, 0.06)",
  "--taomni-input-bg": "#fff8e8",
  "--taomni-input-border": "#d8c99f",
  "--taomni-button-from": "#fff8e8",
  "--taomni-button-to": "#f5ecd7",
  "--taomni-button-hover-from": "#fffaf0",
  "--taomni-button-hover-to": "#efe0b8",
  "--taomni-button-disabled": "#efe6cf",
  "--taomni-scrollbar-track": "#f5ecd7",
  "--taomni-scrollbar-thumb": "#d8c99f",
  "--taomni-scrollbar-thumb-hover": "#bba46f",
  "--taomni-shadow-sm": "0 1px 2px rgba(74, 63, 47, 0.08)",
  "--taomni-shadow-md": "0 4px 16px -2px rgba(74, 63, 47, 0.12), 0 2px 4px -1px rgba(74, 63, 47, 0.06)",
  "--taomni-shadow-lg": "0 16px 24px -4px rgba(74, 63, 47, 0.16), 0 4px 8px -2px rgba(74, 63, 47, 0.08)",
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
