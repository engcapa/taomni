import { useEffect, useMemo, useState } from "react";
import { listSystemFonts } from "./ipc";
import { getAppPlatform } from "./runtime";

export const SOURCE_CODE_PRO = "Source Code Pro";
export const CASCADIA_MONO = "Cascadia Mono";
export const MENLO = "Menlo";
export const SYSTEM_MONOSPACE_FONT = "monospace";

const GENERIC_FONTS = new Set(["monospace", "serif", "sans-serif", "cursive", "fantasy", "system-ui"]);

export const SAFE_TERMINAL_FONT_FALLBACKS = [
  CASCADIA_MONO,
  SOURCE_CODE_PRO,
  "JetBrains Mono",
  "Cascadia Code",
  "Fira Code",
  "Consolas",
  MENLO,
  "DejaVu Sans Mono",
  "monospace",
];

export interface SystemFontState {
  fonts: string[];
  loading: boolean;
  source: "system" | "fallback";
  error: string | null;
}

export function useSystemFonts(): SystemFontState {
  const [state, setState] = useState<SystemFontState>({
    fonts: [],
    loading: true,
    source: "system",
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    console.log("[useSystemFonts] Hook mounted, calling listSystemFonts()");
    listSystemFonts()
      .then((fonts) => {
        if (cancelled) return;
        console.log("[useSystemFonts] listSystemFonts() resolved with:", fonts);
        const normalized = normalizeFontFamilies(fonts);
        if (normalized.length === 0) {
          console.log("[useSystemFonts] normalized length is 0, using fallback");
          setState({
            fonts: SAFE_TERMINAL_FONT_FALLBACKS,
            loading: false,
            source: "fallback",
            error: "No system fonts were returned.",
          });
          return;
        }
        console.log("[useSystemFonts] normalized fonts:", normalized);
        setState({ fonts: normalized, loading: false, source: "system", error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[useSystemFonts] listSystemFonts() rejected with error:", msg);
        setState({
          fonts: SAFE_TERMINAL_FONT_FALLBACKS,
          loading: false,
          source: "fallback",
          error: msg,
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function useTerminalFontOptions(fonts: string[]): string[] {
  return useMemo(() => normalizeFontFamilies([...fonts, SYSTEM_MONOSPACE_FONT]), [fonts]);
}

export function normalizeFontFamilies(fonts: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const font of fonts) {
    const name = font.trim();
    if (!name) continue;
    unique.set(name.toLowerCase(), name);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}

export function makeTerminalFontFamily(primaryFont: string): string {
  const stack = [primaryFont, ...SAFE_TERMINAL_FONT_FALLBACKS.filter((font) => !sameFont(font, primaryFont))];
  return stack.map(formatFontFamilyToken).join(", ");
}

export function getDefaultTerminalFontName(): string {
  return getAppPlatform() === "macos" ? MENLO : CASCADIA_MONO;
}

export function getDefaultTerminalFontFamily(): string {
  return makeTerminalFontFamily(getDefaultTerminalFontName());
}

export function getPrimaryFontName(fontFamily: string): string {
  const [first] = splitFontFamily(fontFamily);
  return first || getDefaultTerminalFontName();
}

export function resolveSelectedFontName(fontFamily: string, availableFonts: readonly string[]): string {
  const primary = getPrimaryFontName(fontFamily);
  const availablePrimary = findFontName(availableFonts, primary);
  if (availablePrimary) return availablePrimary;

  const preferred = getPreferredDefaultFontName(availableFonts);
  return preferred ?? primary;
}

export function getPreferredDefaultFontName(availableFonts: readonly string[]): string | null {
  const platformDefault = findFontName(availableFonts, getDefaultTerminalFontName());
  if (platformDefault) return platformDefault;

  const sourceCodePro = findFontName(availableFonts, SOURCE_CODE_PRO);
  if (sourceCodePro) return sourceCodePro;

  for (const fallback of SAFE_TERMINAL_FONT_FALLBACKS) {
    const available = findFontName(availableFonts, fallback);
    if (available) return available;
  }

  return availableFonts[0] ?? null;
}

export function findFontName(fonts: readonly string[], target: string): string | null {
  const normalizedTarget = target.trim().toLowerCase();
  return fonts.find((font) => font.trim().toLowerCase() === normalizedTarget) ?? null;
}

function splitFontFamily(fontFamily: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;

  for (const char of fontFamily) {
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }

    if (char === "," && !quote) {
      if (token.trim()) result.push(token.trim());
      token = "";
      continue;
    }

    token += char;
  }

  if (token.trim()) result.push(token.trim());
  return result;
}

function formatFontFamilyToken(font: string): string {
  const trimmed = font.trim();
  if (GENERIC_FONTS.has(trimmed.toLowerCase())) return trimmed;
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function sameFont(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

let canvas: HTMLCanvasElement | null = null;
export function isMonospaceFont(fontName: string): boolean {
  if (typeof document === "undefined") return true;
  try {
    if (!canvas) {
      canvas = document.createElement("canvas");
    }
    const context = canvas.getContext("2d");
    if (!context) return true;
    const testChars = ["i", "w", "m", "I", "W", "M", "1", " ", "l"];
    // CRITICAL FIX: Use "sans-serif" as the fallback font during measurement instead of "monospace".
    // If the browser fails to load/recognize the font, it will fall back to "sans-serif" (which is proportional),
    // causing the character widths to differ and correctly returning false (not monospace / not loaded yet).
    // If it fell back to "monospace", it would always return true even if the font is not installed or proportional.
    context.font = `20px ${formatFontFamilyToken(fontName)}, sans-serif`;
    const firstWidth = context.measureText(testChars[0]).width;
    for (let i = 1; i < testChars.length; i++) {
      const width = context.measureText(testChars[i]).width;
      if (Math.abs(width - firstWidth) > 0.05) {
        return false;
      }
    }
    return true;
  } catch (e) {
    console.error("[isMonospaceFont] Failed to measure font:", e);
    return true;
  }
}
