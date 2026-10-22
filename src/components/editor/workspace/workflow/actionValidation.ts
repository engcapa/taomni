import type { LspTextEdit } from "../../../../lib/editor/lsp";
import { fsPathEquals } from "../codeWorkspaceModel";
import { type WorkflowActionDisabledFact, type WorkflowActionSelection, type WorkflowActionValidationInput, type WorkflowActionValidation } from "./types";

export function readWorkflowActionDisabled(raw: unknown): WorkflowActionDisabledFact {
  if (typeof raw !== "object" || raw === null) return { disabled: false, reason: null };
  const value = (raw as { disabled?: unknown; }).disabled;
  if (value === true) return { disabled: true, reason: null };
  if (typeof value === "object" && value !== null) {
    const reasonValue = (value as { reason?: unknown; }).reason;
    const reason = typeof reasonValue === "string" && reasonValue.trim().length > 0
      ? reasonValue.trim()
      : null;
    return { disabled: true, reason };
  }
  return { disabled: false, reason: null };
}

export function workflowActionIsDisabled(raw: unknown): boolean {
  return readWorkflowActionDisabled(raw).disabled;
}

export function formatWorkflowDisabledReason(reason: string | null): string {
  return reason ? `: ${reason}` : " (the provider did not supply a reason)";
}

/**
 * Keep the existing first-matching-kind selection strategy but skip a disabled
 * candidate when a same-kind enabled candidate exists. Request-stage callers
 * use this to refuse before any resolve/preview/commit.
 */
export function selectEnabledWorkflowAction<T extends { kind: string | null; raw: unknown; title: string; }>(
  actions: readonly T[],
  isSupportedKind: (kind: string | null) => boolean,
): WorkflowActionSelection<T> {
  let disabled: { action: T; reason: string | null; } | null = null;
  for (const candidate of actions) {
    if (!isSupportedKind(candidate.kind)) continue;
    const fact = readWorkflowActionDisabled(candidate.raw);
    if (fact.disabled) {
      if (!disabled) disabled = { action: candidate, reason: fact.reason };
      continue;
    }
    return { action: candidate, disabled: null };
  }
  return { action: null, disabled };
}

export function workflowEditRangeIsValid(edit: LspTextEdit): boolean {
  const { start, end } = edit.range;
  const positionIsWellFormed = (line: number, character: number): boolean => (
    Number.isInteger(line)
    && Number.isInteger(character)
    && line >= 0
    && character >= 0
  );
  if (!positionIsWellFormed(start.line, start.character)
    || !positionIsWellFormed(end.line, end.character)) {
    return false;
  }
  if (start.line > end.line) return false;
  return start.line < end.line || start.character <= end.character;
}

export function validateWorkflowProviderAction(
  input: WorkflowActionValidationInput,
): WorkflowActionValidation {
  const { action, targetUri, targetPath, capabilityLabel } = input;
  if (!action) {
    return {
      ok: false,
      state: "failed",
      reason: `${capabilityLabel} resolve returned no action; nothing applied`,
    };
  }
  if (workflowActionIsDisabled(action.raw)) {
    const { reason } = readWorkflowActionDisabled(action.raw);
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' is disabled by the provider${formatWorkflowDisabledReason(reason)}; nothing applied`,
    };
  }
  if (!input.isSupportedKind(action.kind)) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} resolve returned kind '${action.kind ?? "(no kind)"}' instead of a dedicated action kind; nothing applied`,
    };
  }
  if (!action.edit) {
    return {
      ok: false,
      state: "unsupported",
      reason: action.command
        ? `${capabilityLabel} action '${action.title}' is command-only (${action.command}); command side effects are not supported; nothing applied`
        : `${capabilityLabel} action '${action.title}' carried no edit; nothing applied`,
    };
  }
  if (action.command) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' carries both an edit and the command '${action.command}'; mixed payloads are not supported; nothing applied`,
    };
  }
  const operations = action.edit.operations ?? [];
  const resourceOperations = operations.filter((operation) => operation.kind !== "text");
  if (resourceOperations.length > 0) {
    const kinds = resourceOperations
      .map((operation) => operation.kind)
      .filter((kind, index, all) => all.indexOf(kind) === index)
      .join(", ");
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' carries resource operations (${kinds}); only current-file text edits are supported; nothing applied`,
    };
  }
  // LSP `documentChanges` entries arrive as ordered operations while `changes`
  // entries appear in both `documentEdits` and `operations`; operations are
  // authoritative when present, exactly like the canonical applier.
  const documentEntries = operations.length > 0
    ? operations.flatMap((operation) => operation.kind === "text" ? [operation.document] : [])
    : (action.edit.documentEdits ?? []);
  if (documentEntries.length === 0) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' carried no document edits; nothing applied`,
    };
  }
  const edits: LspTextEdit[] = [];
  let provenDocumentVersion: number | null = null;
  for (const entry of documentEntries) {
    const uriMatches = !!entry.uri && entry.uri === targetUri;
    const pathMatches = entry.path != null && fsPathEquals(entry.path, targetPath);
    if (entry.uri && entry.path) {
      if (!uriMatches || !pathMatches) {
        return {
          ok: false,
          state: "unsupported",
          reason: `${capabilityLabel} action '${action.title}' addresses a different or contradictory document (uri ${entry.uri}, path ${entry.path}) instead of ${targetPath}; nothing applied`,
        };
      }
    } else if (entry.uri) {
      if (!uriMatches) {
        return {
          ok: false,
          state: "unsupported",
          reason: `${capabilityLabel} action '${action.title}' edits a different document (${entry.uri}) instead of ${targetUri}; nothing applied`,
        };
      }
    } else if (entry.path) {
      if (!pathMatches) {
        return {
          ok: false,
          state: "unsupported",
          reason: `${capabilityLabel} action '${action.title}' edits a different document (${entry.path}) instead of ${targetPath}; nothing applied`,
        };
      }
    } else {
      return {
        ok: false,
        state: "failed",
        reason: `${capabilityLabel} action '${action.title}' carried a malformed document entry without uri or path; nothing applied`,
      };
    }
    if (entry.version != null) {
      // ED-MAIN-003: compare the action's LSP version only with the actual
      // provider-synchronized document version, never the editor revision. An
      // unversioned payload skips this and relies on the hash/generation gates.
      if (input.documentVersion == null) {
        return {
          ok: false,
          state: "stale",
          reason: `${capabilityLabel} action '${action.title}' targets document version ${entry.version} but the provider-synchronized document version is unknown (unsynchronized buffer); nothing applied`,
        };
      }
      if (entry.version !== input.documentVersion) {
        return {
          ok: false,
          state: "stale",
          reason: `${capabilityLabel} action '${action.title}' targets document version ${entry.version} but the provider document is at ${input.documentVersion}; nothing applied`,
        };
      }
      provenDocumentVersion = entry.version;
    }
    edits.push(...entry.edits);
  }
  if (edits.length === 0) {
    return {
      ok: false,
      state: "unsupported",
      reason: `${capabilityLabel} action '${action.title}' carried no usable edits; nothing applied`,
    };
  }
  const lines = input.documentText.split("\n");
  for (const edit of edits) {
    // A real JDT LS sortMembers edit can address positions past the last
    // document line; the canonical applier clamps those exactly like
    // offsetFromLspPositionInString, and the postcondition hash still decides.
    // Only structurally malformed (negative/non-integer) or reversed ranges
    // are rejected here.
    if (!workflowEditRangeIsValid(edit)) {
      const { start, end } = edit.range;
      return {
        ok: false,
        state: "failed",
        reason: `${capabilityLabel} action '${action.title}' carried a malformed or reversed edit range`
          + ` (${start.line}:${start.character} -> ${end.line}:${end.character}, document has ${lines.length} lines); nothing applied`,
      };
    }
  }
  return { ok: true, edits, documentVersion: provenDocumentVersion };
}
