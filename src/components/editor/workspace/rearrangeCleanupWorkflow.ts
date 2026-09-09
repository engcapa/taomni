/**
 * ED-STYLE-002 / C8-D: Rearrange Code & Code Cleanup independent workflows.
 *
 * Dedicated planner, execution gates, preview, and verification for
 * Rearrange Code and Code Cleanup workflows.
 * These actions FAIL CLOSED with honest, typed explanations when the language
 * server/provider does not advertise dedicated rearrange/cleanup capabilities.
 * They never disguise format or organize imports as rearrange/cleanup.
 */

import type {
  LspCapabilitySummary,
  LspDocumentStatus,
  LspFileTextEdits,
  LspTextEdit,
  LspWorkspaceEdit,
} from "../../../lib/editor/lsp";
import { fileUriToFsPath, fsPathEquals } from "./codeWorkspaceModel";
import { applyLspTextEditsToString } from "./lspTextEdits";
import { sha256Hex } from "./projectAnalysisModel";
import {
  buildWorkspaceEditPreview,
  type WorkspaceEditPreview,
} from "./workspaceEditPreview";

export interface RearrangeCapabilities {
  rearrangeSupported: boolean;
  providerId?: string;
  providerVersion?: string;
}

const REARRANGE_ACTION_KINDS = [
  "source.rearrange",
  "source.rearrangeCode",
  "rearrange",
] as const;

/** A provider action is rearrange-capable only when its kind is explicit. */
export function isRearrangeActionKind(kind: string | null | undefined): boolean {
  const normalized = kind?.trim() ?? "";
  return REARRANGE_ACTION_KINDS.some((base) => (
    normalized === base || normalized.startsWith(`${base}.`)
  ));
}

function sameTextEdit(left: LspTextEdit, right: LspTextEdit): boolean {
  return left.newText === right.newText
    && left.annotationId === right.annotationId
    && left.range.start.line === right.range.start.line
    && left.range.start.character === right.range.start.character
    && left.range.end.line === right.range.end.line
    && left.range.end.character === right.range.end.character;
}

function sameDocumentEdit(left: LspFileTextEdits, right: LspFileTextEdits): boolean {
  return left.uri === right.uri
    && left.path === right.path
    && (left.version ?? null) === (right.version ?? null)
    && JSON.stringify(left.annotationIds ?? []) === JSON.stringify(right.annotationIds ?? [])
    && left.edits.length === right.edits.length
    && left.edits.every((edit, index) => sameTextEdit(edit, right.edits[index]!));
}

export type RearrangeEditValidation =
  | { valid: true; document: LspFileTextEdits; edits: readonly LspTextEdit[] }
  | { valid: false; reason: string };

function sameActionDocument(
  document: LspFileTextEdits,
  targetPath: string,
  targetUri: string,
): boolean {
  if (document.uri.trim() !== targetUri.trim()) return false;
  const documentPath = document.path?.trim()
    || fileUriToFsPath(document.uri)
    || "";
  return documentPath.length > 0 && fsPathEquals(documentPath, targetPath);
}

/**
 * Rearrange is a file-local text transformation. Keep this gate next to the
 * planner so format/imports, command-only actions, resource operations, and
 * accidental cross-file edits cannot enter the transaction owner.
 */
export function validateRearrangeActionEdit(
  edit: LspWorkspaceEdit | null | undefined,
  targetPath: string,
  targetUri: string,
  currentText?: string,
): RearrangeEditValidation {
  if (!edit) return { valid: false, reason: "Provider returned no rearrange edit" };
  if (!Array.isArray(edit.documentEdits) || edit.documentEdits.length !== 1) {
    return { valid: false, reason: "Rearrange provider must return exactly one document edit" };
  }
  if (edit.operations !== undefined) {
    if (edit.operations.length !== 1 || edit.operations[0]?.kind !== "text") {
      return { valid: false, reason: "Rearrange provider must return one text operation and no resource operations" };
    }
    const operation = edit.operations[0];
    if (operation.kind !== "text" || !sameDocumentEdit(operation.document, edit.documentEdits[0])) {
      return { valid: false, reason: "Rearrange provider returned inconsistent document edit operations" };
    }
  }
  const document = edit.documentEdits[0];
  if (!sameActionDocument(document, targetPath, targetUri)) {
    return { valid: false, reason: "Rearrange provider returned an edit for a different file" };
  }
  if (document.edits.length === 0) {
    return { valid: false, reason: "Rearrange provider returned an empty edit" };
  }
  if (document.edits.some((item) => !item || typeof item.newText !== "string")) {
    return { valid: false, reason: "Rearrange provider returned a malformed text edit" };
  }
  if (currentText !== undefined) {
    try {
      const postText = applyLspTextEditsToString(currentText, document.edits);
      if (postText === currentText) {
        return { valid: false, reason: "Rearrange provider returned a no-op edit" };
      }
    } catch {
      return { valid: false, reason: "Rearrange provider returned an invalid text range" };
    }
  }
  return { valid: true, document, edits: document.edits };
}

export interface RearrangeInput {
  scope: "selection" | "file";
  targetPath: string | null;
  languageId: string | null;
  readOnly: boolean;
  hasSelection: boolean;
  capabilities: RearrangeCapabilities;
}

export type RearrangeDecision =
  | {
      kind: "execute";
      scope: "selection" | "file";
      stage: "rearrange";
      provider?: { id: string; version?: string };
    }
  | {
      kind: "unavailable";
      scope: "selection" | "file";
      reason: string;
    };

export function resolveRearrangeCapabilities(
  capabilities?: LspCapabilitySummary | null,
  status?: LspDocumentStatus | null,
): RearrangeCapabilities {
  if (!capabilities) {
    return {
      rearrangeSupported: false,
      providerId: status?.displayName ?? status?.presetId ?? undefined,
    };
  }

  const codeActionKinds = capabilities.codeActionKinds ?? [];
  const hasRearrangeCodeAction = codeActionKinds.some((kind) => isRearrangeActionKind(kind));
  const isExplicitlySupported =
    (capabilities as unknown as { rearrangeSupported?: boolean }).rearrangeSupported === true;

  const providerId =
    (capabilities as unknown as { rearrangeProvider?: { id: string; version?: string } })
      ?.rearrangeProvider?.id ??
    status?.displayName ??
    status?.presetId ??
    "lsp";
  const providerVersion =
    (capabilities as unknown as { rearrangeProvider?: { id: string; version?: string } })
      ?.rearrangeProvider?.version;

  return {
    rearrangeSupported: Boolean(hasRearrangeCodeAction || isExplicitlySupported),
    providerId,
    providerVersion,
  };
}

export function planRearrange(input: RearrangeInput): RearrangeDecision {
  const requestedScope: "selection" | "file" =
    input.scope === "selection" && input.hasSelection ? "selection" : "file";

  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: "No file is open to rearrange",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: `${input.targetPath} is read-only and cannot be rearranged`,
    };
  }

  if (!input.capabilities.rearrangeSupported) {
    const providerLabel = input.capabilities.providerId;
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: providerLabel
        ? `${providerLabel} does not support member-rearrangement for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`
        : `No member-rearrangement provider is available for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`,
    };
  }

  const decision: RearrangeDecision = {
    kind: "execute",
    scope: requestedScope,
    stage: "rearrange",
  };
  if (input.capabilities.providerId) {
    decision.provider = {
      id: input.capabilities.providerId,
      version: input.capabilities.providerVersion,
    };
  }
  return decision;
}

export interface CleanupCapabilities {
  cleanupSupported: boolean;
  providerId?: string;
  providerVersion?: string;
  supportedProfiles?: readonly string[];
}

export interface CleanupInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string | null;
  languageId: string | null;
  readOnly: boolean;
  profileId?: string;
  capabilities: CleanupCapabilities;
}

export type CleanupDecision =
  | {
      kind: "execute";
      scope: "file" | "directory" | "module" | "project";
      stage: "cleanup";
      profileId: string;
      provider?: { id: string; version?: string };
    }
  | {
      kind: "unavailable";
      scope: "file" | "directory" | "module" | "project";
      reason: string;
    };

export function resolveCleanupCapabilities(
  capabilities?: LspCapabilitySummary | null,
  status?: LspDocumentStatus | null,
): CleanupCapabilities {
  if (!capabilities) {
    return {
      cleanupSupported: false,
      providerId: status?.displayName ?? status?.presetId ?? undefined,
    };
  }

  const codeActionKinds = capabilities.codeActionKinds ?? [];
  const hasCleanupCodeAction =
    codeActionKinds.includes("source.cleanup") ||
    codeActionKinds.includes("source.fixAll") ||
    codeActionKinds.includes("cleanup");
  const isExplicitlySupported =
    (capabilities as unknown as { cleanupSupported?: boolean }).cleanupSupported === true;

  const providerId =
    (capabilities as unknown as { cleanupProvider?: { id: string; version?: string } })
      ?.cleanupProvider?.id ??
    status?.displayName ??
    status?.presetId ??
    "lsp";
  const providerVersion =
    (capabilities as unknown as { cleanupProvider?: { id: string; version?: string } })
      ?.cleanupProvider?.version;

  const supportedProfiles =
    (capabilities as unknown as { supportedProfiles?: readonly string[] }).supportedProfiles ??
    (capabilities as unknown as { cleanupProvider?: { supportedProfiles?: readonly string[] } })
      ?.cleanupProvider?.supportedProfiles ??
    ["default", "full-cleanup"];

  return {
    cleanupSupported: Boolean(hasCleanupCodeAction || isExplicitlySupported),
    providerId,
    providerVersion,
    supportedProfiles,
  };
}

export function planCleanup(input: CleanupInput): CleanupDecision {
  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: "No target is selected for code cleanup",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: `${input.targetPath} is read-only and cannot be cleaned up`,
    };
  }

  if (!input.capabilities.cleanupSupported) {
    const providerLabel = input.capabilities.providerId;
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: providerLabel
        ? `${providerLabel} does not support code cleanup for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`
        : `No code cleanup provider is available for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`,
    };
  }

  const decision: CleanupDecision = {
    kind: "execute",
    scope: input.scope,
    stage: "cleanup",
    profileId: input.profileId ?? "default",
  };
  if (input.capabilities.providerId) {
    decision.provider = {
      id: input.capabilities.providerId,
      version: input.capabilities.providerVersion,
    };
  }
  return decision;
}

export interface WorkflowPrecondition {
  uri: string;
  path: string;
  preTextSha256: string;
  documentRevision?: number;
  expectedPostHash: string;
}

export interface WorkflowConflict {
  uri: string;
  path: string;
  reason: "dirty-open-buffer" | "external-divergence" | "read-only" | "version-mismatch";
  message: string;
}

export interface WorkflowPlan {
  workflow: "rearrange" | "cleanup";
  scope: "selection" | "file" | "directory" | "module" | "project";
  profileId?: string;
  provider: { id: string; version?: string };
  preconditions: readonly WorkflowPrecondition[];
  edit: LspWorkspaceEdit;
  preview: WorkspaceEditPreview;
  conflicts: readonly WorkflowConflict[];
  expectedPostHashes: Record<string, string>;
}

export interface BuildRearrangePlanInput {
  scope: "selection" | "file";
  targetPath: string;
  targetUri: string;
  currentText: string;
  documentRevision?: number;
  /** Native LSP document version, distinct from the renderer revision. */
  documentVersion?: number | null;
  readOnly: boolean;
  provider: { id: string; version?: string };
  edits: readonly LspTextEdit[];
  isDirty?: boolean;
}

export function buildRearrangePlan(input: BuildRearrangePlanInput): WorkflowPlan {
  const conflicts: WorkflowConflict[] = [];
  if (input.readOnly) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "read-only",
      message: `${input.targetPath} is read-only and cannot be rearranged`,
    });
  }
  if (input.isDirty) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "dirty-open-buffer",
      message: `${input.targetPath} has uncommitted open changes`,
    });
  }

  const preTextSha256 = sha256Hex(input.currentText);
  const postText = applyLspTextEditsToString(input.currentText, input.edits);
  const expectedPostHash = sha256Hex(postText);

  const edit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: input.targetUri,
        path: input.targetPath,
        version: input.documentVersion ?? null,
        edits: [...input.edits],
      },
    ],
  };

  const preview = buildWorkspaceEditPreview(edit, { label: "Rearrange Code" });

  const precondition: WorkflowPrecondition = {
    uri: input.targetUri,
    path: input.targetPath,
    preTextSha256,
    documentRevision: input.documentRevision,
    expectedPostHash,
  };

  return {
    workflow: "rearrange",
    scope: input.scope,
    provider: input.provider,
    preconditions: [precondition],
    edit,
    preview,
    conflicts,
    expectedPostHashes: { [input.targetPath]: expectedPostHash },
  };
}

export interface BuildCleanupPlanInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string;
  targetUri: string;
  currentText: string;
  documentRevision?: number;
  /** Native LSP document version, distinct from the renderer revision. */
  documentVersion?: number | null;
  readOnly: boolean;
  profileId?: string;
  provider: { id: string; version?: string };
  edits: readonly LspTextEdit[];
  isDirty?: boolean;
}

export function buildCleanupPlan(input: BuildCleanupPlanInput): WorkflowPlan {
  const conflicts: WorkflowConflict[] = [];
  if (input.readOnly) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "read-only",
      message: `${input.targetPath} is read-only and cannot be cleaned up`,
    });
  }
  if (input.isDirty) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "dirty-open-buffer",
      message: `${input.targetPath} has uncommitted open changes`,
    });
  }

  const preTextSha256 = sha256Hex(input.currentText);
  const postText = applyLspTextEditsToString(input.currentText, input.edits);
  const expectedPostHash = sha256Hex(postText);

  const edit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: input.targetUri,
        path: input.targetPath,
        version: input.documentVersion ?? null,
        edits: [...input.edits],
      },
    ],
  };

  const preview = buildWorkspaceEditPreview(edit, { label: "Code Cleanup" });

  const precondition: WorkflowPrecondition = {
    uri: input.targetUri,
    path: input.targetPath,
    preTextSha256,
    documentRevision: input.documentRevision,
    expectedPostHash,
  };

  return {
    workflow: "cleanup",
    scope: input.scope,
    profileId: input.profileId ?? "default",
    provider: input.provider,
    preconditions: [precondition],
    edit,
    preview,
    conflicts,
    expectedPostHashes: { [input.targetPath]: expectedPostHash },
  };
}

export function verifyWorkflowPreconditions(
  plan: WorkflowPlan,
  liveDocuments: Record<string, { text: string; revision?: number; readOnly?: boolean }>,
): { ok: boolean; conflict?: WorkflowConflict } {
  for (const pc of plan.preconditions) {
    const live = liveDocuments[pc.path] ?? liveDocuments[pc.uri];
    if (!live) continue;
    if (live.readOnly) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "read-only",
          message: `${pc.path} is read-only`,
        },
      };
    }
    const currentSha = sha256Hex(live.text);
    if (currentSha !== pc.preTextSha256) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "external-divergence",
          message: `${pc.path} has changed since plan generation`,
        },
      };
    }
    if (
      pc.documentRevision !== undefined &&
      live.revision !== undefined &&
      live.revision !== pc.documentRevision
    ) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "version-mismatch",
          message: `${pc.path} revision ${live.revision} differs from planned ${pc.documentRevision}`,
        },
      };
    }
  }
  return { ok: true };
}

export function verifyWorkflowFreshness(
  frozenIdentity: { providerGeneration?: number; sessionId?: string },
  currentIdentity: { providerGeneration?: number; sessionId?: string },
): { ok: boolean; staleReason?: string } {
  if (
    frozenIdentity.providerGeneration !== undefined &&
    currentIdentity.providerGeneration !== undefined &&
    frozenIdentity.providerGeneration !== currentIdentity.providerGeneration
  ) {
    return {
      ok: false,
      staleReason: `Provider generation changed (${frozenIdentity.providerGeneration} -> ${currentIdentity.providerGeneration})`,
    };
  }
  if (
    frozenIdentity.sessionId !== undefined &&
    currentIdentity.sessionId !== undefined &&
    frozenIdentity.sessionId !== currentIdentity.sessionId
  ) {
    return {
      ok: false,
      staleReason: `Session identity changed (${frozenIdentity.sessionId} -> ${currentIdentity.sessionId})`,
    };
  }
  return { ok: true };
}

export function verifyWorkflowPostHashes(
  expectedPostHashes: Record<string, string>,
  appliedFiles: Record<string, string>,
): { ok: boolean; mismatchedFiles: string[] } {
  const mismatchedFiles: string[] = [];
  for (const [path, expectedHash] of Object.entries(expectedPostHashes)) {
    const actualText = appliedFiles[path];
    if (actualText === undefined) {
      mismatchedFiles.push(path);
      continue;
    }
    const actualHash = sha256Hex(actualText);
    if (actualHash !== expectedHash) {
      mismatchedFiles.push(path);
    }
  }
  return {
    ok: mismatchedFiles.length === 0,
    mismatchedFiles,
  };
}

export function cancelWorkflowPlan(_plan?: WorkflowPlan): {
  disposition: "cancelled";
  applied: boolean;
  effects: [];
} {
  return {
    disposition: "cancelled",
    applied: false,
    effects: [],
  };
}
