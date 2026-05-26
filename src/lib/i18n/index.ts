import { useCallback, useSyncExternalStore } from "react";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type LocaleCode = "en" | "zh-CN";

export interface LocaleDescriptor {
  code: LocaleCode;
  nativeLabel: string;
  englishLabel: string;
}

// Order in this list controls the order shown in the language switcher.
export const LOCALES: LocaleDescriptor[] = [
  { code: "en", nativeLabel: "English", englishLabel: "English" },
  { code: "zh-CN", nativeLabel: "简体中文", englishLabel: "Simplified Chinese" },
];

// Translation dictionary type. Adding a new key here flags any locale that
// hasn't been updated thanks to the satisfies-style export in each locale
// file. Nested groups exist purely for readability — at runtime keys are flat
// strings like "menu.terminal.title".
export type TranslationDict = typeof en;

const LOCALE_STORAGE_KEY = "newmob.locale.v1";
const FALLBACK_LOCALE: LocaleCode = "en";
const dictionaries: Record<LocaleCode, TranslationDict> = {
  "en": en,
  "zh-CN": zhCN as TranslationDict,
};

const listeners = new Set<() => void>();
let currentLocale: LocaleCode = loadInitialLocale();

export function getLocale(): LocaleCode {
  return currentLocale;
}

export function setLocale(locale: LocaleCode): void {
  const next = normalizeLocale(locale);
  if (next === currentLocale) return;
  currentLocale = next;
  saveLocale(next);
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
  }
  listeners.forEach((listener) => listener());
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLocaleDescriptor(locale: LocaleCode = currentLocale): LocaleDescriptor {
  return LOCALES.find((entry) => entry.code === locale) ?? LOCALES[0];
}

// Walks a "dot.path" against the active dictionary, falling back to English
// when a key is missing. Returns the key itself if neither dictionary defines
// it so missing translations show up in the UI instead of crashing.
function resolveKey(locale: LocaleCode, key: string): string {
  const value = lookup(dictionaries[locale], key);
  if (typeof value === "string") return value;
  if (locale !== FALLBACK_LOCALE) {
    const fallback = lookup(dictionaries[FALLBACK_LOCALE], key);
    if (typeof fallback === "string") return fallback;
  }
  return key;
}

function lookup(dict: unknown, key: string): unknown {
  let cursor: unknown = dict;
  for (const segment of key.split(".")) {
    if (cursor && typeof cursor === "object" && segment in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      const value = params[name];
      return value === undefined ? match : String(value);
    }
    return match;
  });
}

// Imperative translator suitable for non-React modules (e.g. zustand stores
// that need to ship localized status strings). Always reads the current
// locale at call time.
export function t(key: string, params?: Record<string, string | number>): string {
  return format(resolveKey(currentLocale, key), params);
}

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// React hook. The component re-renders whenever the locale changes.
export function useT(): TranslateFn {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return useCallback(
    (key: string, params?: Record<string, string | number>) => format(resolveKey(locale, key), params),
    [locale],
  );
}

export function useLocale(): {
  locale: LocaleCode;
  setLocale: (locale: LocaleCode) => void;
  locales: LocaleDescriptor[];
} {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return { locale, setLocale, locales: LOCALES };
}

function normalizeLocale(value: unknown): LocaleCode {
  if (typeof value !== "string") return FALLBACK_LOCALE;
  if (value in dictionaries) return value as LocaleCode;
  // Accept loose variants like "zh", "zh-Hans" and map to zh-CN.
  if (value.toLowerCase().startsWith("zh")) return "zh-CN";
  if (value.toLowerCase().startsWith("en")) return "en";
  return FALLBACK_LOCALE;
}

function loadInitialLocale(): LocaleCode {
  if (typeof window === "undefined") return FALLBACK_LOCALE;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored) return normalizeLocale(stored);
  } catch {
    // localStorage may be unavailable in restricted webviews.
  }
  // Default to English until the user explicitly switches via the language
  // picker; persisted choice is honored above.
  return FALLBACK_LOCALE;
}

function saveLocale(locale: LocaleCode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // localStorage may be unavailable in restricted webviews.
  }
}

if (typeof document !== "undefined") {
  document.documentElement.lang = currentLocale;
}

if (typeof window !== "undefined") {
  // Mirror locale across same-origin windows (e.g. detached SFTP popup) so
  // they stay in sync with the main window.
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== LOCALE_STORAGE_KEY) return;
    const next = normalizeLocale(event.newValue);
    if (next === currentLocale) return;
    currentLocale = next;
    if (typeof document !== "undefined") document.documentElement.lang = next;
    listeners.forEach((listener) => listener());
  });
}
