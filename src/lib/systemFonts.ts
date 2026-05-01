import { useEffect, useMemo, useState } from "react";
import { listSystemFonts } from "./ipc";

export const SOURCE_CODE_PRO = "Source Code Pro";

const GENERIC_FONTS = new Set(["monospace", "serif", "sans-serif", "cursive", "fantasy", "system-ui"]);

export const SAFE_TERMINAL_FONT_FALLBACKS = [
  SOURCE_CODE_PRO,
  "JetBrains Mono",
  "Cascadia Code",
  "Fira Code",
  "Consolas",
  "Menlo",
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

    listSystemFonts()
      .then((fonts) => {
        if (cancelled) return;
        const normalized = normalizeFontFamilies(fonts);
        if (normalized.length === 0) {
          setState({
            fonts: SAFE_TERMINAL_FONT_FALLBACKS,
            loading: false,
            source: "fallback",
            error: "No system fonts were returned.",
          });
          return;
        }
        setState({ fonts: normalized, loading: false, source: "system", error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          fonts: SAFE_TERMINAL_FONT_FALLBACKS,
          loading: false,
          source: "fallback",
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function useTerminalFontOptions(fonts: string[]): string[] {
  return useMemo(() => normalizeFontFamilies(fonts), [fonts]);
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

export function getPrimaryFontName(fontFamily: string): string {
  const [first] = splitFontFamily(fontFamily);
  return first || SOURCE_CODE_PRO;
}

export function resolveSelectedFontName(fontFamily: string, availableFonts: readonly string[]): string {
  const primary = getPrimaryFontName(fontFamily);
  const availablePrimary = findFontName(availableFonts, primary);
  if (availablePrimary) return availablePrimary;

  const preferred = getPreferredDefaultFontName(availableFonts);
  return preferred ?? primary;
}

export function getPreferredDefaultFontName(availableFonts: readonly string[]): string | null {
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
