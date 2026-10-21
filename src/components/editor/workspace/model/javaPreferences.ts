import type { LspJavaSettings, LspJavaBundleConfig } from "../../../../lib/editor/lsp";
import { emitLspPrefsChanged } from "./lspPreferences";
import { LSP_JAVA_HOME_KEY, LSP_JAVA_VMARGS_KEY, LSP_JAVA_HEAP_MB_KEY, LSP_JAVA_SETTINGS_KEY, LSP_JAVA_BUNDLES_KEY } from "./lspPreferenceKeys";

export const DEFAULT_LSP_JAVA_VMARGS = "-Xms1024m -Xmx1024m";

/** Configured JDK home / java binary for jdtls (empty string means auto-detect). */
export function readLspJavaHome(): string {
  try {
    return window.localStorage.getItem(LSP_JAVA_HOME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeLspJavaHome(javaHome: string): void {
  try {
    const trimmed = javaHome.trim();
    if (trimmed) window.localStorage.setItem(LSP_JAVA_HOME_KEY, trimmed);
    else window.localStorage.removeItem(LSP_JAVA_HOME_KEY);
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
}

/** Normalize free-form jdtls JVM args; empty → null (use default). */
export function normalizeLspJavaVmargs(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

/**
 * Effective jdtls JVM args string.
 * Migrates the legacy heap-MB setting once into vmargs if present.
 */
export function readLspJavaVmargs(): string {
  try {
    const stored = normalizeLspJavaVmargs(window.localStorage.getItem(LSP_JAVA_VMARGS_KEY));
    if (stored) return stored;

    // One-shot migration from the short-lived heap-only preference.
    const legacyHeap = window.localStorage.getItem(LSP_JAVA_HEAP_MB_KEY);
    if (legacyHeap) {
      const mb = Number(legacyHeap.trim());
      if (Number.isFinite(mb) && mb > 0) {
        const clamped = Math.min(32768, Math.max(256, Math.round(mb)));
        const migrated = `-Xms${clamped}m -Xmx${clamped}m`;
        try {
          window.localStorage.setItem(LSP_JAVA_VMARGS_KEY, migrated);
          window.localStorage.removeItem(LSP_JAVA_HEAP_MB_KEY);
        } catch {
          // Ignore storage failures; still return migrated value for this session.
        }
        return migrated;
      }
    }
    return DEFAULT_LSP_JAVA_VMARGS;
  } catch {
    return DEFAULT_LSP_JAVA_VMARGS;
  }
}

/**
 * Persist jdtls JVM args. Empty/null clears to the default 1G heap pair.
 * Returns the effective string after normalize.
 */
export function writeLspJavaVmargs(vmargs: string | null | undefined): string {
  const normalized = normalizeLspJavaVmargs(vmargs);
  try {
    if (normalized === null) {
      window.localStorage.removeItem(LSP_JAVA_VMARGS_KEY);
    } else {
      window.localStorage.setItem(LSP_JAVA_VMARGS_KEY, normalized);
    }
    // Drop legacy key once the user manages vmargs explicitly.
    window.localStorage.removeItem(LSP_JAVA_HEAP_MB_KEY);
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
  return normalized ?? DEFAULT_LSP_JAVA_VMARGS;
}

/** Defaults mirror the Rust `JavaLanguageSettings::default` (autobuild on, Lombok off). */
export const DEFAULT_LSP_JAVA_SETTINGS: LspJavaSettings = {
  autobuildEnabled: true,
  lombokEnabled: false,
  lombokJarPath: "",
  saveActionsOrganizeImports: false,
  formatSettingsUrl: "",
  formatSettingsProfile: "",
  guessMethodArguments: true,
  completionImportOrder: [],
  organizeImportsStarThreshold: 99,
  organizeImportsStaticStarThreshold: 99,
  mavenImportEnabled: true,
  gradleImportEnabled: true,
};

export function clampThreshold(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(999, Math.max(1, Math.round(num)));
}

/** Coerce an arbitrary parsed value into a complete, defaulted `LspJavaSettings`. */
export function normalizeLspJavaSettings(raw: unknown): LspJavaSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bool = (key: keyof LspJavaSettings): boolean =>
    typeof source[key] === "boolean"
      ? (source[key] as boolean)
      : (DEFAULT_LSP_JAVA_SETTINGS[key] as boolean);
  const str = (key: keyof LspJavaSettings): string =>
    typeof source[key] === "string" ? (source[key] as string) : (DEFAULT_LSP_JAVA_SETTINGS[key] as string);
  return {
    autobuildEnabled: bool("autobuildEnabled"),
    lombokEnabled: bool("lombokEnabled"),
    lombokJarPath: str("lombokJarPath"),
    saveActionsOrganizeImports: bool("saveActionsOrganizeImports"),
    formatSettingsUrl: str("formatSettingsUrl"),
    formatSettingsProfile: str("formatSettingsProfile"),
    guessMethodArguments: bool("guessMethodArguments"),
    completionImportOrder: Array.isArray(source.completionImportOrder)
      ? source.completionImportOrder.filter((entry): entry is string => typeof entry === "string")
      : [...DEFAULT_LSP_JAVA_SETTINGS.completionImportOrder],
    organizeImportsStarThreshold: clampThreshold(
      source.organizeImportsStarThreshold,
      DEFAULT_LSP_JAVA_SETTINGS.organizeImportsStarThreshold,
    ),
    organizeImportsStaticStarThreshold: clampThreshold(
      source.organizeImportsStaticStarThreshold,
      DEFAULT_LSP_JAVA_SETTINGS.organizeImportsStaticStarThreshold,
    ),
    mavenImportEnabled: bool("mavenImportEnabled"),
    gradleImportEnabled: bool("gradleImportEnabled"),
  };
}

/** Read the persisted jdtls `java.*` settings (defaults when unset/corrupt). */
export function readLspJavaSettings(): LspJavaSettings {
  try {
    const stored = window.localStorage.getItem(LSP_JAVA_SETTINGS_KEY);
    if (!stored) return { ...DEFAULT_LSP_JAVA_SETTINGS };
    return normalizeLspJavaSettings(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_LSP_JAVA_SETTINGS };
  }
}

/** Persist the jdtls `java.*` settings and notify listeners. */
export function writeLspJavaSettings(settings: LspJavaSettings): LspJavaSettings {
  const normalized = normalizeLspJavaSettings(settings);
  try {
    window.localStorage.setItem(LSP_JAVA_SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
  return normalized;
}

/** Defaults for jdtls extension bundle paths (unset → debug/test unavailable). */
export const DEFAULT_LSP_JAVA_BUNDLES: LspJavaBundleConfig = {
  javaDebugPath: "",
  javaTestPath: "",
};

/** Coerce arbitrary parsed data into a complete `LspJavaBundleConfig`. */
export function normalizeLspJavaBundles(raw: unknown): LspJavaBundleConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (key: keyof LspJavaBundleConfig): string =>
    typeof source[key] === "string" ? (source[key] as string) : "";
  return {
    javaDebugPath: str("javaDebugPath"),
    javaTestPath: str("javaTestPath"),
  };
}

/** Read persisted jdtls extension bundle paths (defaults when unset/corrupt). */
export function readLspJavaBundles(): LspJavaBundleConfig {
  try {
    const stored = window.localStorage.getItem(LSP_JAVA_BUNDLES_KEY);
    if (!stored) return { ...DEFAULT_LSP_JAVA_BUNDLES };
    return normalizeLspJavaBundles(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_LSP_JAVA_BUNDLES };
  }
}

/** Persist jdtls extension bundle paths and notify listeners. */
export function writeLspJavaBundles(config: LspJavaBundleConfig): LspJavaBundleConfig {
  const normalized = normalizeLspJavaBundles(config);
  try {
    window.localStorage.setItem(LSP_JAVA_BUNDLES_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage failures.
  }
  emitLspPrefsChanged();
  return normalized;
}

export { LSP_JAVA_HOME_KEY, LSP_JAVA_VMARGS_KEY, LSP_JAVA_HEAP_MB_KEY, LSP_JAVA_SETTINGS_KEY, LSP_JAVA_BUNDLES_KEY } from "./lspPreferenceKeys";
