/**
 * ED-PARITY-016 DEC-016-01: IDEA's Structural Search template pane — the
 * user's recent templates plus a small set of existing Java templates.
 * Recent templates are a per-user convenience in localStorage; the session
 * list keeps working when storage is unavailable.
 */

export interface StructuralTemplateEntry {
  id: string;
  label: string;
  pattern: string;
}

export const EXISTING_JAVA_TEMPLATES: readonly StructuralTemplateEntry[] = [
  { id: "println", label: "System.out.println calls", pattern: "System.out.println($arg$);" },
  { id: "stderr", label: "System.err.println calls", pattern: "System.err.println($arg$);" },
  { id: "equals", label: "equals() calls", pattern: "$a$.equals($b$)" },
  { id: "new-instance", label: "new expressions", pattern: "new $Type$($args$)" },
];

export const RECENT_TEMPLATE_LIMIT = 8;
const RECENT_KEY = "taomni.structuralSearch.recentTemplates.v1";
let recentMemory: string[] | null = null;

function loadRecent(): string[] {
  if (recentMemory) return recentMemory;
  let loaded: string[] = [];
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? "null") as unknown;
    if (Array.isArray(parsed)) {
      loaded = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, RECENT_TEMPLATE_LIMIT);
    }
  } catch {
    // Unreadable storage: start with an empty session list.
  }
  recentMemory = loaded;
  return recentMemory;
}

export function readRecentStructuralTemplates(): readonly string[] {
  return loadRecent();
}

export function recordRecentStructuralTemplate(pattern: string): void {
  const trimmed = pattern.trim();
  if (!trimmed) return;
  recentMemory = [trimmed, ...loadRecent().filter((item) => item !== trimmed)].slice(0, RECENT_TEMPLATE_LIMIT);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(recentMemory));
  } catch {
    // The session list still works without storage.
  }
}

/** Test hook: drop the in-memory list so storage is read again. */
export function resetRecentStructuralTemplatesForTests(): void {
  recentMemory = null;
}

/**
 * IDEA's per-variable filters. Only Text is evaluated by the syntax backend;
 * the others are listed so users see what exists, typed unavailable.
 */
export const STRUCTURAL_FILTER_KINDS = [
  { id: "text", label: "Text", supported: true },
  { id: "count", label: "Count", supported: false },
  { id: "type", label: "Type", supported: false },
  { id: "reference", label: "Reference", supported: false },
  { id: "script", label: "Script", supported: false },
] as const;

export const UNSUPPORTED_FILTER_REASON = "Not supported by the syntax-only backend (needs a Java language server)";
