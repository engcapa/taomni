import type { LspFileState } from "./codeWorkspaceModel";

export type LanguageServiceReadinessKind =
  | "ready"
  | "indexing"
  | "starting"
  | "not-installed"
  | "failed"
  | "inactive"
  | "idle";

export interface LanguageServiceReadiness {
  kind: LanguageServiceReadinessKind;
  /** Server display name ("Java", "LSP" when unknown). */
  name: string;
  /** User-facing reason; the same text feeds the status pill and Problems. */
  message: string;
  /** Recovery entry: open Language Server settings, or restart the servers. */
  action: "configure" | "retry" | null;
}

/**
 * ED-PARITY-015 DEC-015-01: one readiness model for the LSP status pill and
 * the Problems tool window, so "service unavailable" is never shown as
 * "no problems".
 */
export function languageServiceReadiness(state: LspFileState | null): LanguageServiceReadiness {
  const status = state?.status ?? null;
  if (!status) {
    return { kind: "idle", name: "LSP", message: "LSP idle", action: null };
  }
  const name = status.displayName ?? "LSP";
  const runtimeError = status.error ?? state?.error ?? null;
  if (status.active) {
    // Older/browser status producers omit semanticReady and stay ready-compatible.
    return status.semanticReady === false
      ? { kind: "indexing", name, message: `${name} indexing…`, action: null }
      : { kind: "ready", name, message: name, action: null };
  }
  if (runtimeError) {
    return { kind: "failed", name, message: runtimeError, action: status.available ? "retry" : "configure" };
  }
  // No language server is defined for this file type (plain text, …): there
  // is nothing to configure and "no problems" is the truthful answer.
  if (!status.available && !status.presetId && !status.installHint) {
    return { kind: "idle", name, message: "No LSP", action: null };
  }
  if (!status.available) {
    return {
      kind: "not-installed",
      name,
      message: status.installHint ? `Install: ${status.installHint}` : "No LSP",
      action: "configure",
    };
  }
  if (state?.syncing) {
    return { kind: "starting", name, message: `${name} starting…`, action: null };
  }
  return { kind: "inactive", name, message: `${name} inactive`, action: "retry" };
}
