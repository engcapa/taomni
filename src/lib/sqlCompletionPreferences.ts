export interface SqlCompletionPreferences {
  activateOnTyping: boolean;
  triggerShortcut: string;
  acceptWithTab: boolean;
  acceptWithEnter: boolean;
}

export type SqlShortcutValidationError = "required" | "invalid" | "reserved";

export const DEFAULT_SQL_COMPLETION_PREFERENCES: SqlCompletionPreferences = {
  activateOnTyping: true,
  triggerShortcut: "Ctrl-Space",
  acceptWithTab: true,
  acceptWithEnter: true,
};

export const SQL_COMPLETION_PREFERENCES_STORAGE_KEY = "taomni.sqlCompletionPreferences.v1";
export const SQL_COMPLETION_PREFERENCES_EVENT = "taomni:sql-completion-preferences-changed";

const MODIFIER_ALIASES: Record<string, "Mod" | "Ctrl" | "Meta" | "Alt" | "Shift"> = {
  mod: "Mod",
  ctrl: "Ctrl",
  control: "Ctrl",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};
const MODIFIER_ORDER = ["Mod", "Ctrl", "Meta", "Alt", "Shift"] as const;
const NAMED_KEYS = new Map<string, string>([
  ["space", "Space"],
  ["enter", "Enter"],
  ["return", "Enter"],
  ["tab", "Tab"],
  ["escape", "Escape"],
  ["esc", "Escape"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["insert", "Insert"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["arrowup", "ArrowUp"],
  ["arrowdown", "ArrowDown"],
  ["arrowleft", "ArrowLeft"],
  ["arrowright", "ArrowRight"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const named = NAMED_KEYS.get(trimmed.toLocaleLowerCase());
  if (named) return named;
  if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^[A-Za-z0-9]$/.test(trimmed)) return trimmed.toLocaleLowerCase();
  if (/^[`=/,.;'\\\[\]]$/.test(trimmed)) return trimmed;
  return null;
}

/** Normalize user-facing `Ctrl+Space` and CodeMirror `Ctrl-Space` forms. */
export function normalizeSqlShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const rawParts = value.trim().replace(/\s*\+\s*/g, "-").split("-");
  if (rawParts.length === 0 || rawParts.some((part) => !part.trim())) return null;
  const modifiers = new Set<(typeof MODIFIER_ORDER)[number]>();
  let key: string | null = null;
  for (const rawPart of rawParts) {
    const part = rawPart.trim();
    const modifier = MODIFIER_ALIASES[part.toLocaleLowerCase()];
    if (modifier) {
      if (key) return null;
      modifiers.add(modifier);
      continue;
    }
    if (key) return null;
    key = normalizeKey(part);
    if (!key) return null;
  }
  if (!key) return null;
  const isFunctionKey = /^F(?:[1-9]|1[0-2])$/.test(key);
  if (modifiers.size === 0 && !isFunctionKey) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("-");
}

function platformShortcut(shortcut: string, isMac: boolean): string {
  return shortcut
    .split("-")
    .map((part) => part === "Mod" ? (isMac ? "Meta" : "Ctrl") : part)
    .join("-");
}

export function sqlShortcutValidationError(
  value: unknown,
  isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform),
): SqlShortcutValidationError | null {
  if (typeof value !== "string" || !value.trim()) return "required";
  const shortcut = normalizeSqlShortcut(value);
  if (!shortcut) return "invalid";
  const platformValue = platformShortcut(shortcut, isMac);
  const reserved = new Set([
    "F5",
    isMac ? "Meta-Enter" : "Ctrl-Enter",
    "Shift-Alt-ArrowUp",
    "Shift-Alt-ArrowDown",
  ].map((candidate) => platformShortcut(normalizeSqlShortcut(candidate) ?? candidate, isMac)));
  return reserved.has(platformValue) ? "reserved" : null;
}

function eventKey(event: KeyboardEvent): string | null {
  if (["Control", "Meta", "Alt", "Shift", "AltGraph"].includes(event.key)) return null;
  if (event.code === "Space" || event.key === " ") return "Space";
  return normalizeKey(event.key);
}

/** Convert a captured keydown to the CodeMirror key-binding syntax. */
export function sqlShortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  const key = eventKey(event);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.metaKey) modifiers.push("Meta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  const isFunctionKey = /^F(?:[1-9]|1[0-2])$/.test(key);
  if (modifiers.length === 0 && !isFunctionKey) return null;
  return normalizeSqlShortcut([...modifiers, key].join("-"));
}

export function displaySqlShortcut(
  value: string,
  isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform),
): string {
  const shortcut = normalizeSqlShortcut(value) ?? value;
  return shortcut
    .split("-")
    .map((part) => {
      if (part === "Mod") return isMac ? "Cmd" : "Ctrl";
      if (part === "Meta") return isMac ? "Cmd" : "Meta";
      if (part === "Alt") return isMac ? "Option" : "Alt";
      return part.length === 1 ? part.toLocaleUpperCase() : part;
    })
    .join("+");
}

export function normalizeSqlCompletionPreferences(input: unknown): SqlCompletionPreferences {
  const source = isRecord(input) ? input : {};
  const triggerShortcut = normalizeSqlShortcut(source.triggerShortcut);
  let acceptWithTab = readBoolean(
    source.acceptWithTab,
    DEFAULT_SQL_COMPLETION_PREFERENCES.acceptWithTab,
  );
  let acceptWithEnter = readBoolean(
    source.acceptWithEnter,
    DEFAULT_SQL_COMPLETION_PREFERENCES.acceptWithEnter,
  );
  if (!acceptWithTab && !acceptWithEnter) acceptWithEnter = true;
  return {
    activateOnTyping: readBoolean(
      source.activateOnTyping,
      DEFAULT_SQL_COMPLETION_PREFERENCES.activateOnTyping,
    ),
    triggerShortcut: triggerShortcut
      && !sqlShortcutValidationError(triggerShortcut)
      ? triggerShortcut
      : DEFAULT_SQL_COMPLETION_PREFERENCES.triggerShortcut,
    acceptWithTab,
    acceptWithEnter,
  };
}

export function loadSqlCompletionPreferences(): SqlCompletionPreferences {
  if (typeof window === "undefined") return DEFAULT_SQL_COMPLETION_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(SQL_COMPLETION_PREFERENCES_STORAGE_KEY);
    return normalizeSqlCompletionPreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return DEFAULT_SQL_COMPLETION_PREFERENCES;
  }
}

export function saveSqlCompletionPreferences(preferences: SqlCompletionPreferences): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeSqlCompletionPreferences(preferences);
  try {
    window.localStorage.setItem(
      SQL_COMPLETION_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
  try {
    window.dispatchEvent(new CustomEvent(SQL_COMPLETION_PREFERENCES_EVENT, { detail: normalized }));
  } catch {
    // CustomEvent can be unavailable in exotic environments.
  }
}

export function subscribeSqlCompletionPreferences(
  listener: (preferences: SqlCompletionPreferences) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    listener(normalizeSqlCompletionPreferences(
      (event as CustomEvent<SqlCompletionPreferences>).detail,
    ));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SQL_COMPLETION_PREFERENCES_STORAGE_KEY) return;
    listener(loadSqlCompletionPreferences());
  };
  window.addEventListener(SQL_COMPLETION_PREFERENCES_EVENT, onCustom as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SQL_COMPLETION_PREFERENCES_EVENT, onCustom as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}
