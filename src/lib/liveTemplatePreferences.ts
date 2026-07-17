/**
 * User preferences for Code Workspace IDEA-style live / postfix templates.
 * Global (all workspaces), persisted in localStorage.
 */

export type LiveTemplateLanguage =
  | "java"
  | "kotlin"
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "csharp"
  | "php"
  | "generic";

export interface CustomLiveTemplate {
  id: string;
  abbreviation: string;
  body: string;
  description: string;
  languages: LiveTemplateLanguage[];
  postfix: boolean;
  enabled: boolean;
}

export interface LiveTemplatePreferences {
  /** Master switch for live + postfix templates. */
  enabled: boolean;
  /** When false, postfix forms (expr.sout) are disabled; plain abbreviations remain. */
  postfixEnabled: boolean;
  /**
   * Built-in templates the user turned off.
   * Keys from `builtinTemplateKey()` in liveTemplates.ts.
   */
  disabledBuiltinKeys: string[];
  /** User-defined templates merged into the catalog at runtime. */
  customTemplates: CustomLiveTemplate[];
}

export const DEFAULT_LIVE_TEMPLATE_PREFERENCES: LiveTemplatePreferences = {
  enabled: true,
  postfixEnabled: true,
  disabledBuiltinKeys: [],
  customTemplates: [],
};

export const LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY = "taomni.liveTemplatePreferences.v1";
export const LIVE_TEMPLATE_PREFERENCES_EVENT = "taomni:live-template-preferences-changed";

export const LIVE_TEMPLATE_LANGUAGE_OPTIONS: readonly LiveTemplateLanguage[] = [
  "java",
  "kotlin",
  "javascript",
  "typescript",
  "python",
  "rust",
  "go",
  "csharp",
  "php",
  "generic",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isLiveTemplateLanguage(value: unknown): value is LiveTemplateLanguage {
  return typeof value === "string"
    && (LIVE_TEMPLATE_LANGUAGE_OPTIONS as readonly string[]).includes(value);
}

function normalizeLanguages(value: unknown): LiveTemplateLanguage[] {
  if (!Array.isArray(value)) return ["java"];
  const langs = value.filter(isLiveTemplateLanguage);
  return langs.length > 0 ? [...new Set(langs)] : ["java"];
}

function normalizeAbbreviation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Allow IDEA-style short tokens; reject whitespace / path noise.
  if (!/^[A-Za-z_$@][\w$]*$/.test(trimmed)) return null;
  if (trimmed.length > 40) return null;
  return trimmed;
}

function normalizeBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Empty body is useless; allow multi-line snippets up to a sane limit.
  if (!value.trim() || value.length > 8000) return null;
  return value;
}

export function createCustomLiveTemplateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeCustomLiveTemplate(value: unknown): CustomLiveTemplate | null {
  if (!isRecord(value)) return null;
  const abbreviation = normalizeAbbreviation(value.abbreviation);
  const body = normalizeBody(value.body);
  if (!abbreviation || !body) return null;
  const id = typeof value.id === "string" && value.id.trim()
    ? value.id.trim().slice(0, 80)
    : createCustomLiveTemplateId();
  const description = typeof value.description === "string"
    ? value.description.trim().slice(0, 200)
    : "";
  return {
    id,
    abbreviation,
    body,
    description,
    languages: normalizeLanguages(value.languages),
    postfix: value.postfix === true,
    enabled: value.enabled !== false,
  };
}

export function normalizeLiveTemplatePreferences(raw: unknown): LiveTemplatePreferences {
  if (!isRecord(raw)) return { ...DEFAULT_LIVE_TEMPLATE_PREFERENCES, customTemplates: [] };

  const disabled = Array.isArray(raw.disabledBuiltinKeys)
    ? [...new Set(
      raw.disabledBuiltinKeys
        .filter((key): key is string => typeof key === "string" && key.length > 0 && key.length < 200),
    )].sort()
    : [];

  const customTemplates = Array.isArray(raw.customTemplates)
    ? raw.customTemplates
      .map(normalizeCustomLiveTemplate)
      .filter((item): item is CustomLiveTemplate => item != null)
      .slice(0, 200)
    : [];

  // Deduplicate custom ids (keep first).
  const seenIds = new Set<string>();
  const uniqueCustom: CustomLiveTemplate[] = [];
  for (const item of customTemplates) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    uniqueCustom.push(item);
  }

  return {
    enabled: readBoolean(raw.enabled, DEFAULT_LIVE_TEMPLATE_PREFERENCES.enabled),
    postfixEnabled: readBoolean(raw.postfixEnabled, DEFAULT_LIVE_TEMPLATE_PREFERENCES.postfixEnabled),
    disabledBuiltinKeys: disabled,
    customTemplates: uniqueCustom,
  };
}

export function loadLiveTemplatePreferences(): LiveTemplatePreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_LIVE_TEMPLATE_PREFERENCES, customTemplates: [] };
  }
  try {
    const raw = window.localStorage.getItem(LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY);
    return normalizeLiveTemplatePreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_LIVE_TEMPLATE_PREFERENCES, customTemplates: [] };
  }
}

export function saveLiveTemplatePreferences(preferences: LiveTemplatePreferences): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeLiveTemplatePreferences(preferences);
  try {
    window.localStorage.setItem(
      LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
  try {
    window.dispatchEvent(
      new CustomEvent(LIVE_TEMPLATE_PREFERENCES_EVENT, { detail: normalized }),
    );
  } catch {
    // CustomEvent can be unavailable in exotic environments.
  }
}

export function subscribeLiveTemplatePreferences(
  listener: (preferences: LiveTemplatePreferences) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    listener(normalizeLiveTemplatePreferences(
      (event as CustomEvent<LiveTemplatePreferences>).detail,
    ));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY) return;
    listener(loadLiveTemplatePreferences());
  };
  window.addEventListener(LIVE_TEMPLATE_PREFERENCES_EVENT, onCustom as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LIVE_TEMPLATE_PREFERENCES_EVENT, onCustom as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}

export function isBuiltinTemplateEnabled(
  preferences: LiveTemplatePreferences,
  key: string,
): boolean {
  return !preferences.disabledBuiltinKeys.includes(key);
}

export function setBuiltinTemplateEnabled(
  preferences: LiveTemplatePreferences,
  key: string,
  enabled: boolean,
): LiveTemplatePreferences {
  const set = new Set(preferences.disabledBuiltinKeys);
  if (enabled) set.delete(key);
  else set.add(key);
  return {
    ...preferences,
    disabledBuiltinKeys: [...set].sort(),
  };
}
