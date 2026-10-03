import {
  displaySqlShortcut,
  normalizeSqlShortcut,
  sqlShortcutFromKeyboardEvent,
  type SqlShortcutValidationError,
} from "./sqlCompletionPreferences";

/**
 * Preferences for SQL execution shortcuts (Run All / Run Selection / Run Current).
 * Stored separately from completion preferences to keep the semantics clean.
 */
export interface SqlExecutionPreferences {
  runAll: string;
  runSelection: string;
  runCurrent: string;
}

export type SqlExecutionShortcutField = keyof SqlExecutionPreferences;
export type SqlExecutionValidationError = SqlShortcutValidationError | "conflict";

export const DEFAULT_SQL_EXECUTION_PREFERENCES: SqlExecutionPreferences = {
  runAll: "F5",
  runSelection: "Mod-Enter",
  runCurrent: "Mod-Shift-Enter",
};

export const SQL_EXECUTION_PREFERENCES_STORAGE_KEY = "taomni.sqlExecutionPreferences.v1";
export const SQL_EXECUTION_PREFERENCES_EVENT = "taomni:sql-execution-preferences-changed";

// Only multi-cursor bindings stay hard-reserved; F5 / Mod-Enter are now
// configurable execution shortcuts so they must NOT be hard-blocked here.
const HARD_RESERVED_EXECUTION = new Set(
  [
    "Shift-Alt-ArrowUp",
    "Shift-Alt-ArrowDown",
  ]
    .map((candidate) => normalizeSqlShortcut(candidate) ?? candidate),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function platformShortcut(shortcut: string, isMac: boolean): string {
  return shortcut
    .split("-")
    .map((part) => (part === "Mod" ? (isMac ? "Meta" : "Ctrl") : part))
    .join("-");
}

export function sqlExecutionShortcutValidationError(
  value: unknown,
  isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform),
): SqlShortcutValidationError | null {
  if (typeof value !== "string" || !value.trim()) return "required";
  const shortcut = normalizeSqlShortcut(value);
  if (!shortcut) return "invalid";
  const platformValue = platformShortcut(shortcut, isMac);
  for (const reservedRaw of HARD_RESERVED_EXECUTION) {
    if (platformShortcut(reservedRaw, isMac) === platformValue) return "reserved";
  }
  return null;
}

export function sqlExecutionConflictField(
  preferences: SqlExecutionPreferences,
  field: SqlExecutionShortcutField,
  candidateRaw: string,
  isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform),
): SqlExecutionShortcutField | null {
  const candidate = normalizeSqlShortcut(candidateRaw);
  if (!candidate) return null;
  const candidatePlatform = platformShortcut(candidate, isMac);
  const fields: SqlExecutionShortcutField[] = ["runAll", "runSelection", "runCurrent"];
  for (const other of fields) {
    if (other === field) continue;
    const otherRaw = preferences[other];
    const otherNorm = normalizeSqlShortcut(otherRaw);
    if (!otherNorm) continue;
    if (platformShortcut(otherNorm, isMac) === candidatePlatform) return other;
  }
  return null;
}

export { displaySqlShortcut, sqlShortcutFromKeyboardEvent };

export function normalizeSqlExecutionPreferences(input: unknown): SqlExecutionPreferences {
  const source = isRecord(input) ? input : {};
  const runAllRaw = typeof source.runAll === "string" ? source.runAll : undefined;
  const runSelectionRaw = typeof source.runSelection === "string" ? source.runSelection : undefined;
  const runCurrentRaw = typeof source.runCurrent === "string" ? source.runCurrent : undefined;

  const runAllNorm = runAllRaw ? normalizeSqlShortcut(runAllRaw) : null;
  const runSelectionNorm = runSelectionRaw ? normalizeSqlShortcut(runSelectionRaw) : null;
  const runCurrentNorm = runCurrentRaw ? normalizeSqlShortcut(runCurrentRaw) : null;

  return {
    runAll: runAllNorm && !sqlExecutionShortcutValidationError(runAllNorm)
      ? runAllNorm
      : DEFAULT_SQL_EXECUTION_PREFERENCES.runAll,
    runSelection: runSelectionNorm && !sqlExecutionShortcutValidationError(runSelectionNorm)
      ? runSelectionNorm
      : DEFAULT_SQL_EXECUTION_PREFERENCES.runSelection,
    runCurrent: runCurrentNorm && !sqlExecutionShortcutValidationError(runCurrentNorm)
      ? runCurrentNorm
      : DEFAULT_SQL_EXECUTION_PREFERENCES.runCurrent,
  };
}

export function loadSqlExecutionPreferences(): SqlExecutionPreferences {
  if (typeof window === "undefined") return DEFAULT_SQL_EXECUTION_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(SQL_EXECUTION_PREFERENCES_STORAGE_KEY);
    return normalizeSqlExecutionPreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return DEFAULT_SQL_EXECUTION_PREFERENCES;
  }
}

export function saveSqlExecutionPreferences(preferences: SqlExecutionPreferences): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeSqlExecutionPreferences(preferences);
  try {
    window.localStorage.setItem(
      SQL_EXECUTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // localStorage unavailable
  }
  try {
    window.dispatchEvent(new CustomEvent(SQL_EXECUTION_PREFERENCES_EVENT, { detail: normalized }));
  } catch {
    // CustomEvent unavailable
  }
}

export function subscribeSqlExecutionPreferences(
  listener: (preferences: SqlExecutionPreferences) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    listener(normalizeSqlExecutionPreferences(
      (event as CustomEvent<SqlExecutionPreferences>).detail,
    ));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SQL_EXECUTION_PREFERENCES_STORAGE_KEY) return;
    listener(loadSqlExecutionPreferences());
  };
  window.addEventListener(SQL_EXECUTION_PREFERENCES_EVENT, onCustom as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SQL_EXECUTION_PREFERENCES_EVENT, onCustom as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Dynamic completion ↔ execution conflict helpers (localStorage read without
 * importing the opposite module to avoid circular deps).
 */
function readCompletionShortcutFromStorage(): string | null {
  try {
    const raw = window.localStorage.getItem("taomni.sqlCompletionPreferences.v1");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { triggerShortcut?: unknown };
    if (typeof parsed.triggerShortcut !== "string") return null;
    return normalizeSqlShortcut(parsed.triggerShortcut);
  } catch {
    return null;
  }
}

function readExecutionShortcutsFromStorage(): string[] {
  try {
    const raw = window.localStorage.getItem(SQL_EXECUTION_PREFERENCES_STORAGE_KEY);
    if (!raw) return Object.values(DEFAULT_SQL_EXECUTION_PREFERENCES);
    const parsed = JSON.parse(raw) as Partial<SqlExecutionPreferences>;
    const values: string[] = [];
    for (const key of ["runAll", "runSelection", "runCurrent"] as const) {
      const value = parsed[key];
      if (typeof value === "string") {
        const norm = normalizeSqlShortcut(value);
        if (norm) values.push(norm);
      }
    }
    return values.length > 0 ? values : Object.values(DEFAULT_SQL_EXECUTION_PREFERENCES);
  } catch {
    return Object.values(DEFAULT_SQL_EXECUTION_PREFERENCES);
  }
}

export function executionShortcutsConflictingWithCompletionCandidate(
  candidateRaw: string,
  isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform),
): boolean {
  if (typeof window === "undefined") return false;
  const candidate = normalizeSqlShortcut(candidateRaw);
  if (!candidate) return false;
  const candidatePlatform = platformShortcut(candidate, isMac);
  const execution = readExecutionShortcutsFromStorage();
  return execution.some((raw) => {
    const norm = normalizeSqlShortcut(raw);
    return norm ? platformShortcut(norm, isMac) === candidatePlatform : false;
  });
}

export function completionShortcutConflictingWithExecutionCandidate(
  candidateRaw: string,
  isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform),
): boolean {
  if (typeof window === "undefined") return false;
  const candidate = normalizeSqlShortcut(candidateRaw);
  if (!candidate) return false;
  const candidatePlatform = platformShortcut(candidate, isMac);
  const completion = readCompletionShortcutFromStorage() ?? "Ctrl-Space";
  const completionNorm = normalizeSqlShortcut(completion);
  if (!completionNorm) return false;
  return platformShortcut(completionNorm, isMac) === candidatePlatform;
}
