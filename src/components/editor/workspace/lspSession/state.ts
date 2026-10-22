import { type LspCapabilitySummary, type LspDiagnostic, type LspDocumentStatus } from "../../../../lib/editor/lsp";
import { type LspFileState } from "../codeWorkspaceModel";

export const LSP_DIAGNOSTICS_IDLE_DELAY_MS = 750;

export const LSP_DIAGNOSTICS_REFRESH_EVENT = "lsp://diagnostics-refresh";

/**
 * LSP feature responses all carry a document status.  Most responses for an
 * already-open document repeat that exact status, and publishing a new store
 * map for each one makes the whole workspace chrome render again.  Keep the
 * comparison local and cheap (the capability summary is small) so feature
 * requests that do not change observable state are true no-ops.
 */
export function mergeDocumentCapabilities(
  incoming: LspCapabilitySummary | null | undefined,
  existing: LspCapabilitySummary | null | undefined,
): LspCapabilitySummary | null {
  if (!incoming) return existing ?? null;
  if (!existing) return incoming;
  const hasIncoming = Object.values(incoming).some((v) => v === true || (Array.isArray(v) && v.length > 0));
  if (hasIncoming) return incoming;
  const hasExisting = Object.values(existing).some((v) => v === true || (Array.isArray(v) && v.length > 0));
  return hasExisting ? existing : incoming;
}

export function sameDocumentStatus(left: LspDocumentStatus, right: LspDocumentStatus): boolean {
  return left === right || (
    left.path === right.path
    && left.uri === right.uri
    && left.presetId === right.presetId
    && left.languageId === right.languageId
    && left.displayName === right.displayName
    && left.available === right.available
    && left.active === right.active
    && (left.semanticReady ?? true) === (right.semanticReady ?? true)
    && left.selectedCommandId === right.selectedCommandId
    && left.selectedCommand === right.selectedCommand
    && left.installHint === right.installHint
    && left.error === right.error
    && JSON.stringify(left.capabilities ?? null) === JSON.stringify(right.capabilities ?? null)
  );
}

export function sameDiagnostics(left: LspDiagnostic[], right: LspDiagnostic[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    if (
      a.message !== b.message
      || a.severity !== b.severity
      || a.code !== b.code
      || a.source !== b.source
      || a.codeDescription !== b.codeDescription
      || a.range.start.line !== b.range.start.line
      || a.range.start.character !== b.range.start.character
      || a.range.end.line !== b.range.end.line
      || a.range.end.character !== b.range.end.character
      || JSON.stringify(a.tags ?? []) !== JSON.stringify(b.tags ?? [])
      || JSON.stringify(a.relatedInformation ?? []) !== JSON.stringify(b.relatedInformation ?? [])
      || JSON.stringify(a.data ?? null) !== JSON.stringify(b.data ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export function nextErrorGeneration(
  existing: LspFileState,
  nextStatusError: string | null | undefined,
  nextStateError: string | null | undefined,
): number {
  const previousError = existing.status?.error ?? existing.error;
  const nextError = nextStatusError ?? nextStateError ?? null;
  const generation = existing.errorGeneration ?? 0;
  return nextError && nextError !== previousError ? generation + 1 : generation;
}
