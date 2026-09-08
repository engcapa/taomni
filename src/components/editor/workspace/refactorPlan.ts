import type {
  LspLocation,
  LspWorkspaceEdit,
  LspWorkspaceEditOperation,
} from "../../../lib/editor/lsp";
import { fsPathEquals, normalizeFsPath, relativePathWithinRoot } from "./codeWorkspaceModel";
import type { CapabilityEvidenceV3 } from "./capabilityEvidence";
import { workspaceEditOperations } from "./workspaceEditPreview";
import { useProjectFactsStore } from "../../../stores/projectFactsStore";
import { sha256Hex } from "./projectAnalysisModel";
import { applyLspTextEditsToString } from "./lspTextEdits";

/**
 * §8.20.6 W5 / §8.21.2 V1: Unified refactoring plan & verification gate.
 *
 * All effectful code modifications from Rename, Safe Delete, `refactor.*`
 * Code Actions, and Generate actions pass through `refactorApplyGate`.
 */

export type RefactorKind =
  | "rename"
  | "safe-delete"
  | "extract"
  | "inline"
  | "change-signature"
  | "move"
  | "other";

export interface SafeDeleteAttestationV1 {
  providerId: string;
  providerVersion: string;
  projectFingerprint: string;
  capability: "safe-delete";
  coverage: "provider-complete";
  supportedSymbolKinds: readonly string[];
  proof: { kind: "provider-command" | "code-action-data"; id: string };
}

export type DestructiveRefactorAvailability =
  | { state: "enabled"; attestation: SafeDeleteAttestationV1 }
  | { state: "disabled"; reasonCode: "provider-no-safe-delete-attestation"; message: string };

export function evaluateDestructiveRefactorAvailability(
  attestation?: SafeDeleteAttestationV1 | null,
): DestructiveRefactorAvailability {
  if (
    attestation &&
    attestation.capability === "safe-delete" &&
    attestation.coverage === "provider-complete" &&
    attestation.proof &&
    Boolean(attestation.proof.id)
  ) {
    return { state: "enabled", attestation };
  }
  return {
    state: "disabled",
    reasonCode: "provider-no-safe-delete-attestation",
    message: "Language provider does not attest complete Safe Delete coverage",
  };
}

export type RefactorCompleteness =
  | "provider-complete"
  | "provider-partial"
  | "unknown";

export type RefactorUriOwner = "workspace" | "library" | "external";

export interface RefactorConflictV3 {
  severity: "warning" | "error";
  message: string;
  location: LspLocation | null;
}

export type RefactorConflictSource =
  | "reported"
  | "provider-asserted"
  | "protocol-bounded"
  | "client-observed-bounded"
  | "local-policy"
  | "unknown";

export interface RefactorFactV4<T> {
  value: T;
  source: "provider-asserted" | "protocol-bounded" | "client-observed-bounded" | "local-policy" | "unknown";
  proof: string | null;
}

export interface RefactorDocumentPreconditionV4 {
  uri: string;
  canonicalPath: string | null;
  expectedDocumentRevision: number | null;
  expectedDiskHash: string | null;
  owner: RefactorUriOwner;
  preTextSha256?: string | null;
  expectedPostHash?: string | null;
}

export interface RefactorPlanV4 {
  actionId: string;
  kind: RefactorKind;
  evidence: CapabilityEvidenceV3;
  completeness: RefactorFactV4<"complete" | "partial" | "unknown">;
  conflicts: readonly (RefactorConflictV3 & { source: RefactorConflictSource })[];
  operations: readonly LspWorkspaceEditOperation[];
  documents: readonly RefactorDocumentPreconditionV4[];
  requiredOperationIndexes: readonly number[];
  excludableGroups: readonly {
    id: string;
    label: string;
    operationIndexes: readonly number[];
    required: boolean;
  }[];
  /** Backwards-compatible affected URIs */
  affectedUris: readonly {
    uri: string;
    revision: number | null;
    owner: RefactorUriOwner;
  }[];
  /**
   * ED-PROJECT-005: the ready project-facts snapshot this plan was built
   * against. Null when no same-workspace ready snapshot existed: the plan
   * carries no scope facts instead of a foreign generation. The apply gate
   * blocks plans whose generation no longer matches live facts.
   */
  projectFacts?: {
    workspaceRoot: string;
    generation: number;
    fingerprint: string | null;
  } | null;
}

export type RefactorPlanV3 = RefactorPlanV4;

export interface RefactorGateDecision {
  allowed: boolean;
  requiresConfirm: boolean;
  requiresPreview: boolean;
  reason: string | null;
  blockingConflicts: readonly RefactorConflictV3[];
  warningConflicts: readonly RefactorConflictV3[];
}

/**
 * §8.21.2 V1 gate contract:
 * 1. Library or external resource modification is a hard block.
 * 2. Error-severity conflicts are a hard block.
 * 3. Safe Delete without provider-asserted complete proof is a hard block.
 * 4. Warning conflicts require explicit user confirmation.
 * 5. Partial/unknown completeness requires preview before execution.
 */
export function refactorApplyGate(plan: RefactorPlanV4): RefactorGateDecision {
  // Rule 1: Read-only library / external file writes are hard blocked.
  const nonWorkspace = (plan.documents || []).find((u) => u.owner !== "workspace")
    || (plan.affectedUris || []).find((u) => u.owner !== "workspace");
  if (nonWorkspace) {
    const conflict: RefactorConflictV3 = {
      severity: "error",
      message: `Cannot modify read-only ${nonWorkspace.owner} resource: ${nonWorkspace.uri}`,
      location: null,
    };
    return {
      allowed: false,
      requiresConfirm: false,
      requiresPreview: false,
      reason: conflict.message,
      blockingConflicts: [conflict, ...plan.conflicts.filter((c) => c.severity === "error")],
      warningConflicts: plan.conflicts.filter((c) => c.severity === "warning"),
    };
  }

  // Rule 2: Error-severity conflicts hard block.
  const errorConflicts = plan.conflicts.filter((c) => c.severity === "error");
  if (errorConflicts.length > 0) {
    return {
      allowed: false,
      requiresConfirm: false,
      requiresPreview: false,
      reason: errorConflicts.map((c) => c.message).join("; "),
      blockingConflicts: errorConflicts,
      warningConflicts: plan.conflicts.filter((c) => c.severity === "warning"),
    };
  }

  // Rule 2b (ED-PROJECT-005): a plan pinned to a facts snapshot must not
  // apply after that snapshot went stale. Unpinned plans (no ready snapshot
  // at preview time) are unaffected.
  if (plan.projectFacts) {
    const live = useProjectFactsStore.getState().getWorkspaceFacts(plan.projectFacts.workspaceRoot);
    if (live.generation !== plan.projectFacts.generation) {
      const reason = `Project facts changed since plan preview (G${plan.projectFacts.generation} -> G${live.generation}); re-preview the refactoring`;
      const conflict: RefactorConflictV3 = { severity: "error", message: reason, location: null };
      return {
        allowed: false,
        requiresConfirm: false,
        requiresPreview: false,
        reason,
        blockingConflicts: [conflict, ...plan.conflicts.filter((c) => c.severity === "error")],
        warningConflicts: plan.conflicts.filter((c) => c.severity === "warning"),
      };
    }
  }

  // Rule 3: Safe Delete without provider-asserted complete proof hard blocks (§8.21.2).
  if (plan.kind === "safe-delete") {
    const completenessObj = plan.completeness;
    const isProviderAsserted =
      typeof completenessObj === "object" &&
      completenessObj !== null &&
      completenessObj.value === "complete" &&
      completenessObj.source === "provider-asserted" &&
      Boolean(completenessObj.proof);

    if (!isProviderAsserted) {
      const reason = "Language provider does not attest complete Safe Delete coverage";
      return {
        allowed: false,
        requiresConfirm: false,
        requiresPreview: false,
        reason,
        blockingConflicts: [{ severity: "error", message: reason, location: null }],
        warningConflicts: plan.conflicts.filter((c) => c.severity === "warning"),
      };
    }
  }

  // Rule 4: Warning conflicts require explicit confirmation.
  const warningConflicts = plan.conflicts.filter((c) => c.severity === "warning");
  const requiresConfirm = warningConflicts.length > 0;

  // Rule 5: Partial or unknown completeness requires preview.
  const completenessVal: string = typeof plan.completeness === "object" && plan.completeness !== null
    ? (plan.completeness as any).value
    : String(plan.completeness);
  const requiresPreview = completenessVal !== "complete" && completenessVal !== "provider-complete";

  return {
    allowed: true,
    requiresConfirm,
    requiresPreview,
    reason: warningConflicts.length > 0 ? warningConflicts.map((c) => c.message).join("; ") : null,
    blockingConflicts: [],
    warningConflicts,
  };
}

export interface BuildRefactorPlanInput {
  actionId: string;
  kind: RefactorKind;
  evidence: CapabilityEvidenceV3;
  edit: LspWorkspaceEdit;
  roots: readonly { path: string }[];
  openFiles?: Record<string, {
    documentRevision?: number;
    revision?: number;
    diskHash?: string;
    expectedDiskHash?: string;
    canonicalPath?: string;
    text?: string;
    dirty?: boolean;
    readOnly?: boolean;
    library?: unknown;
  }>;
  currentTexts?: Record<string, string>;
  conflicts?: readonly (RefactorConflictV3 & { source?: RefactorConflictSource })[];
  completeness?: RefactorCompleteness | RefactorFactV4<"complete" | "partial" | "unknown">;
  requiredOperationIndexes?: readonly number[];
  /**
   * ED-PROJECT-005: explicit facts snapshot for the plan. When omitted, the
   * builder records the live ready snapshot for the first root (or null).
   * Tests pass this explicitly to stay hermetic.
   */
  projectFacts?: {
    workspaceRoot: string;
    generation: number;
    fingerprint: string | null;
  } | null;
}

function classifyUriOwner(uri: string, path: string | null, roots: readonly { path: string }[]): RefactorUriOwner {
  if (!/^file:/i.test(uri) && !path) return "library";
  const filePath = path ?? decodeURIComponent(uri.replace(/^file:\/\//i, ""));
  const normalized = normalizeFsPath(filePath);
  const inRoot = roots.some((root) => relativePathWithinRoot(root.path, normalized) !== null);
  if (inRoot) return "workspace";
  if (/(jar|jrt|zip):/i.test(uri) || /[/\\]\.m2[/\\]|[/\\]\.gradle[/\\]/i.test(normalized)) {
    return "library";
  }
  return "external";
}

function matchOpenFile(
  uri: string,
  path: string | null,
  openFiles: Record<string, {
    documentRevision?: number;
    revision?: number;
    diskHash?: string;
    expectedDiskHash?: string;
    canonicalPath?: string;
    text?: string;
    dirty?: boolean;
    readOnly?: boolean;
    library?: unknown;
  }>,
) {
  if (uri && openFiles[uri]) return openFiles[uri];
  if (path && openFiles[path]) return openFiles[path];
  if (path) {
    const norm = normalizeFsPath(path);
    if (openFiles[norm]) return openFiles[norm];
    for (const [k, v] of Object.entries(openFiles)) {
      if (normalizeFsPath(k) === norm) return v;
    }
  }
  return undefined;
}

/**
 * Build a typed RefactorPlanV4 from an LspWorkspaceEdit and current workspace state.
 * Accurately maps revisions, disk hashes, and expected post-hashes per document precondition.
 */
export function buildRefactorPlan(input: BuildRefactorPlanInput): RefactorPlanV4 {
  const operations = workspaceEditOperations(input.edit);
  const roots = input.roots;
  const openFiles = input.openFiles ?? {};
  const rawConflicts = input.conflicts ?? [];

  const affectedMap = new Map<string, { uri: string; path: string | null; owner: RefactorUriOwner }>();
  const groupMap = new Map<string, { id: string; label: string; indexes: number[]; required: boolean }>();
  const requiredSet = new Set(input.requiredOperationIndexes ?? []);

  operations.forEach((op, index) => {
    let uri = "";
    let path: string | null = null;

    if (op.kind === "text") {
      uri = op.document.uri || "";
      path = op.document.path || null;
    } else if (op.kind === "create" || op.kind === "delete") {
      uri = op.uri || "";
      path = op.path || null;
    } else if (op.kind === "rename") {
      uri = op.newUri || "";
      path = op.newPath || null;
    }

    const key = uri || path || `unknown-${index}`;
    if (!affectedMap.has(key)) {
      const owner = classifyUriOwner(uri, path, roots);
      affectedMap.set(key, { uri, path, owner });
    }

    const groupKey = path || uri || "default";
    const existingGroup = groupMap.get(groupKey);
    const isRequired = requiredSet.has(index);
    if (existingGroup) {
      existingGroup.indexes.push(index);
      if (isRequired) existingGroup.required = true;
    } else {
      groupMap.set(groupKey, {
        id: `group:${groupKey}`,
        label: groupKey,
        indexes: [index],
        required: isRequired,
      });
    }
  });

  const documents: RefactorDocumentPreconditionV4[] = [];
  const affectedUris: Array<{ uri: string; revision: number | null; owner: RefactorUriOwner }> = [];

  const conflicts: Array<RefactorConflictV3 & { source: RefactorConflictSource }> = [];

  for (const c of rawConflicts) {
    conflicts.push({
      ...c,
      source: (c as any).source ?? "reported",
    });
  }

  for (const [_, info] of affectedMap.entries()) {
    const matched = matchOpenFile(info.uri, info.path, openFiles);
    const rev = matched?.documentRevision ?? matched?.revision ?? null;
    const diskHash = matched?.diskHash ?? matched?.expectedDiskHash ?? null;
    const canonical = info.path ?? (info.uri?.startsWith("file:") ? decodeURIComponent(info.uri.replace(/^file:\/\//i, "")) : null);

    // ED-REF-001-A2: read-only library / external conflict
    if (info.owner !== "workspace") {
      const targetStr = info.path || info.uri;
      const alreadyHas = conflicts.some((c) =>
        (c.message.includes(info.path || "") || (info.uri && c.message.includes(info.uri))) &&
        c.message.includes(info.owner)
      );
      if (!alreadyHas) {
        conflicts.push({
          severity: "error",
          message: `Cannot modify read-only ${info.owner} resource: ${targetStr}`,
          location: null,
          source: "client-observed-bounded",
        });
      }
    }

    // ED-REF-001-A2: dirty open buffer conflict
    if (
      matched?.dirty === true ||
      (matched?.documentRevision != null && matched?.revision != null && matched.documentRevision !== matched.revision)
    ) {
      const alreadyHas = conflicts.some((c) =>
        (c.message.includes(info.path || "") || (info.uri && c.message.includes(info.uri))) &&
        c.message.includes("unsaved")
      );
      if (!alreadyHas) {
        conflicts.push({
          severity: "error",
          message: `File '${info.path || info.uri}' has unsaved buffer edits; save before refactoring`,
          location: null,
          source: "client-observed-bounded",
        });
      }
    }

    // ED-REF-001-A2: read-only file conflict
    if (matched?.readOnly) {
      const alreadyHas = conflicts.some((c) =>
        (c.message.includes(info.path || "") || (info.uri && c.message.includes(info.uri))) &&
        c.message.includes("read-only")
      );
      if (!alreadyHas) {
        conflicts.push({
          severity: "error",
          message: `Cannot modify read-only file: ${info.path || info.uri}`,
          location: null,
          source: "local-policy",
        });
      }
    }

    // ED-REF-001-A3: calculate expectedPostHash and preTextSha256
    const sourceText = input.currentTexts?.[info.uri]
      ?? (info.path ? input.currentTexts?.[info.path] : undefined)
      ?? matched?.text
      ?? null;

    let preTextSha256: string | null = null;
    let expectedPostHash: string | null = null;

    if (sourceText !== null) {
      preTextSha256 = sha256Hex(sourceText);
      const docEdits = operations.flatMap((op) => {
        if (op.kind === "text") {
          if (matchesRefactorTextOperation(op, info.uri, info.path)) {
            return op.document.edits;
          }
        }
        return [];
      });
      if (docEdits.length > 0) {
        try {
          const postText = applyLspTextEditsToString(sourceText, docEdits);
          expectedPostHash = sha256Hex(postText);
        } catch {
          // Keep null if edits could not be applied
        }
      } else {
        expectedPostHash = preTextSha256;
      }
    }

    documents.push({
      uri: info.uri,
      canonicalPath: canonical,
      expectedDocumentRevision: rev,
      expectedDiskHash: diskHash,
      owner: info.owner,
      preTextSha256,
      expectedPostHash,
    });

    affectedUris.push({
      uri: info.uri,
      revision: rev,
      owner: info.owner,
    });
  }

  const excludableGroups = Array.from(groupMap.values()).map((g) => ({
    id: g.id,
    label: g.label,
    operationIndexes: Object.freeze(g.indexes),
    required: g.required,
  }));

  // Resolve completeness fact
  let completeness: RefactorFactV4<"complete" | "partial" | "unknown">;
  if (input.completeness && typeof input.completeness === "object" && "value" in input.completeness) {
    completeness = input.completeness;
  } else {
    const rawVal = input.completeness ?? (input.evidence.coverage.complete ? "provider-complete" : "provider-partial");
    const val: "complete" | "partial" | "unknown" =
      rawVal === "provider-complete" ? "complete" : rawVal === "provider-partial" ? "partial" : "unknown";
    completeness = {
      value: val,
      source: input.kind === "safe-delete"
        ? "client-observed-bounded" // Safe delete from local references enumeration is strictly client-observed
        : input.evidence.coverage.complete ? "provider-asserted" : "protocol-bounded",
      proof: input.evidence.coverage.reason ?? null,
    };
  }

  // ED-PROJECT-005: record the ready facts snapshot this plan was built
  // against. Explicit input wins (hermetic tests); otherwise resolve the
  // live ready snapshot for the first root, or null when no same-workspace
  // ready snapshot exists.
  let planProjectFacts: RefactorPlanV4["projectFacts"];
  if (input.projectFacts !== undefined) {
    planProjectFacts = input.projectFacts;
  } else {
    const planRoot = roots[0]?.path ?? "";
    const liveEntry = planRoot
      ? useProjectFactsStore.getState().getWorkspaceFacts(planRoot)
      : null;
    planProjectFacts = liveEntry && liveEntry.status === "ready" && liveEntry.structure
      ? {
        workspaceRoot: liveEntry.workspaceRoot,
        generation: liveEntry.generation,
        fingerprint: liveEntry.fingerprint,
      }
      : null;
  }

  return {
    actionId: input.actionId,
    kind: input.kind,
    evidence: input.evidence,
    completeness,
    conflicts: Object.freeze(conflicts),
    operations: Object.freeze(operations),
    documents: Object.freeze(documents),
    requiredOperationIndexes: Object.freeze(Array.from(requiredSet)),
    affectedUris: Object.freeze(affectedUris),
    excludableGroups: Object.freeze(excludableGroups),
    projectFacts: planProjectFacts,
  };
}

/**
 * Validates that deselecting specific operation indexes does not violate
 * required refactoring dependencies.
 */
export function verifyExclusionSafety(
  plan: RefactorPlanV4,
  excludedOperationIndexes: ReadonlySet<number>,
): { safe: boolean; reason: string | null } {
  for (const group of plan.excludableGroups) {
    if (group.required) {
      const hasExcluded = group.operationIndexes.some((idx) => excludedOperationIndexes.has(idx));
      if (hasExcluded) {
        return {
          safe: false,
          reason: `Group "${group.label}" contains changes required for this refactoring and cannot be excluded`,
        };
      }
    }
  }
  return { safe: true, reason: null };
}

/**
 * ED-REF-001-A3: Verifies that post-refactor document contents match the
 * expected post-hashes computed during plan construction.
 */
export function verifyRefactorPostHashes(
  plan: RefactorPlanV4,
  actualPostTexts: Record<string, string>,
): {
  allMatched: boolean;
  mismatches: Array<{ uri: string; expectedPostHash: string; actualPostHash: string }>;
  missingUris: string[];
  verifiedDocuments: number;
} {
  const mismatches: Array<{ uri: string; expectedPostHash: string; actualPostHash: string }> = [];
  const missingUris: string[] = [];
  let verifiedDocuments = 0;

  for (const doc of plan.documents) {
    if (!doc.expectedPostHash) continue;
    const actualText = actualPostTexts[doc.uri] ?? (doc.canonicalPath ? actualPostTexts[doc.canonicalPath] : undefined);
    if (actualText === undefined) {
      missingUris.push(doc.uri || doc.canonicalPath || "unknown");
      continue;
    }
    verifiedDocuments += 1;
    const actualHash = sha256Hex(actualText);
    if (actualHash !== doc.expectedPostHash) {
      mismatches.push({
        uri: doc.uri,
        expectedPostHash: doc.expectedPostHash,
        actualPostHash: actualHash,
      });
    }
  }

  return {
    allMatched: mismatches.length === 0 && missingUris.length === 0,
    mismatches,
    missingUris,
    verifiedDocuments,
  };
}

/**
 * ED-AUDIT-014: v2 recovery journal entry holding before/after preimages and
 * hashes so restart recovery can verify every file before and after writing.
 */
export type RefactorRecoveryJournalStatus =
  | "prepared"
  | "applying"
  | "recovery-required"
  | "committed"
  | "rolled-back";

export interface RefactorRecoveryDocumentMetadata {
  encoding?: string;
  bom?: boolean;
  eol?: "lf" | "crlf" | "cr";
}

export interface RefactorRecoveryDocumentSnapshot {
  uri: string;
  canonicalPath: string | null;
  preText: string;
  preHash: string;
  postText: string;
  postHash: string;
  encoding: string;
  bom: boolean;
  eol: "lf" | "crlf" | "cr";
  preDocumentRevision: number | null;
}

export interface RefactorRecoveryJournalEntry {
  schemaVersion: 2;
  workspaceId: string;
  recoveryId: string;
  transactionId: string;
  actionId: string;
  kind: RefactorKind;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  status: RefactorRecoveryJournalStatus;
  /** Highest operation index known to have settled in the applying run. */
  appliedOperationIndex: number;
  operationCount: number;
  documents: readonly RefactorRecoveryDocumentSnapshot[];
}

/** Legacy v1 rows remain readable for user inspection, never automatic replay. */
export interface RefactorRecoveryJournalEntryV1 {
  schemaVersion: 1;
  verified: false;
  recoveryId: string;
  actionId: string;
  kind: RefactorKind;
  workspaceRoot: string;
  createdAt: number;
  status: "prepared" | "committed" | "rolled-back";
  documents: ReadonlyArray<{
    uri: string;
    canonicalPath: string | null;
    preText: string;
    preHash: string;
    postText: string;
    postHash: string;
  }>;
}

export type RefactorRecoveryJournalRecord =
  | RefactorRecoveryJournalEntry
  | RefactorRecoveryJournalEntryV1;

export interface BuildRefactorRecoveryJournalOptions {
  workspaceId?: string;
  transactionId?: string;
  edit?: LspWorkspaceEdit;
  documentMetadata?: Record<string, RefactorRecoveryDocumentMetadata>;
}

function metadataForDocument(
  options: BuildRefactorRecoveryJournalOptions,
  doc: RefactorDocumentPreconditionV4,
): RefactorRecoveryDocumentMetadata {
  return options.documentMetadata?.[doc.uri]
    ?? (doc.canonicalPath ? options.documentMetadata?.[doc.canonicalPath] : undefined)
    ?? {};
}

function matchesRefactorTextOperation(
  operation: Extract<LspWorkspaceEditOperation, { kind: "text" }>,
  uri: string,
  canonicalPath: string | null,
): boolean {
  const operationUri = operation.document.uri?.trim() ?? "";
  const operationPath = operation.document.path?.trim() ?? "";
  return (operationUri.length > 0 && uri.length > 0 && operationUri === uri)
    || (operationPath.length > 0 && canonicalPath !== null && fsPathEquals(operationPath, canonicalPath));
}

export function buildRefactorRecoveryJournalEntry(
  plan: RefactorPlanV4,
  preTexts: Record<string, string>,
  workspaceRoot: string,
  options: BuildRefactorRecoveryJournalOptions = {},
): RefactorRecoveryJournalEntry | null {
  const activeOperations = options.edit ? workspaceEditOperations(options.edit) : plan.operations;
  if (activeOperations.length === 0 || activeOperations.some((operation) => operation.kind !== "text")) {
    return null;
  }
  const activeDocuments = plan.documents.filter((doc) => activeOperations.some((operation) => (
    operation.kind === "text"
      && matchesRefactorTextOperation(operation, doc.uri, doc.canonicalPath)
  )));
  if (activeDocuments.length === 0) return null;

  const createdAt = Date.now();
  const transactionId = options.transactionId ?? `refactor:${plan.actionId}:${createdAt}`;
  const workspaceId = options.workspaceId ?? workspaceRoot;
  const documents: RefactorRecoveryDocumentSnapshot[] = [];
  for (const doc of activeDocuments) {
    const text = preTexts[doc.uri] ?? (doc.canonicalPath ? preTexts[doc.canonicalPath] : undefined);
    if (text === undefined) return null;
    const preHash = sha256Hex(text);
    const docEdits = activeOperations.flatMap((op) => {
      if (op.kind === "text") {
        if (matchesRefactorTextOperation(op, doc.uri, doc.canonicalPath)) {
          return op.document.edits;
        }
      }
      return [];
    });
    let postText: string;
    try {
      postText = docEdits.length > 0 ? applyLspTextEditsToString(text, docEdits) : text;
    } catch {
      return null;
    }
    const postHash = sha256Hex(postText);
    const metadata = metadataForDocument(options, doc);
    documents.push({
      uri: doc.uri,
      canonicalPath: doc.canonicalPath,
      preText: text,
      preHash,
      postText,
      postHash,
      encoding: metadata.encoding ?? "UTF-8",
      bom: metadata.bom ?? false,
      eol: metadata.eol ?? "lf",
      preDocumentRevision: doc.expectedDocumentRevision,
    });
  }
  return {
    schemaVersion: 2,
    workspaceId,
    recoveryId: `ref-rec-${sha256Hex(`${workspaceId}:${transactionId}:${plan.actionId}`).slice(0, 16)}`,
    transactionId,
    actionId: plan.actionId,
    kind: plan.kind,
    workspaceRoot,
    createdAt,
    updatedAt: createdAt,
    status: "prepared",
    appliedOperationIndex: -1,
    operationCount: activeOperations.length,
    documents: Object.freeze(documents),
  };
}

const RECOVERY_STORAGE_PREFIX_V1 = "taomni.refactor.recovery.v1:";
const RECOVERY_STORAGE_PREFIX_V2 = "taomni.refactor.recovery.v2:";

function recoveryStorageKey(prefix: string, recoveryId: string): string {
  return `${prefix}${recoveryId}`;
}

function parseRefactorRecoveryRecord(value: unknown): RefactorRecoveryJournalRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.schemaVersion === 2) {
    if (
      typeof source.workspaceId !== "string"
      || typeof source.recoveryId !== "string"
      || typeof source.transactionId !== "string"
      || typeof source.actionId !== "string"
      || typeof source.workspaceRoot !== "string"
      || typeof source.createdAt !== "number"
      || typeof source.updatedAt !== "number"
      || typeof source.appliedOperationIndex !== "number"
      || typeof source.operationCount !== "number"
      || !["prepared", "applying", "recovery-required", "committed", "rolled-back"].includes(String(source.status))
      || !Array.isArray(source.documents)
    ) return null;
    const documents = source.documents.map((document) => {
      if (!document || typeof document !== "object") return null;
      const item = document as Record<string, unknown>;
      if (
        typeof item.uri !== "string"
        || (item.canonicalPath !== null && typeof item.canonicalPath !== "string")
        || typeof item.preText !== "string"
        || typeof item.preHash !== "string"
        || typeof item.postText !== "string"
        || typeof item.postHash !== "string"
        || typeof item.encoding !== "string"
        || typeof item.bom !== "boolean"
        || !["lf", "crlf", "cr"].includes(String(item.eol))
        || (item.preDocumentRevision !== null && typeof item.preDocumentRevision !== "number")
      ) return null;
      return {
        uri: item.uri,
        canonicalPath: item.canonicalPath as string | null,
        preText: item.preText,
        preHash: item.preHash,
        postText: item.postText,
        postHash: item.postHash,
        encoding: item.encoding,
        bom: item.bom,
        eol: item.eol as "lf" | "crlf" | "cr",
        preDocumentRevision: item.preDocumentRevision as number | null,
      } satisfies RefactorRecoveryDocumentSnapshot;
    });
    if (documents.some((document) => document === null)) return null;
    return {
      schemaVersion: 2,
      workspaceId: source.workspaceId,
      recoveryId: source.recoveryId,
      transactionId: source.transactionId,
      actionId: source.actionId,
      kind: source.kind as RefactorKind,
      workspaceRoot: source.workspaceRoot,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      status: source.status as RefactorRecoveryJournalStatus,
      appliedOperationIndex: source.appliedOperationIndex,
      operationCount: source.operationCount,
      documents: Object.freeze(documents as RefactorRecoveryDocumentSnapshot[]),
    };
  }

  // Rows written by the old implementation had no schema marker. They are
  // intentionally exposed as unverified inspection records only.
  const schemaVersion = source.schemaVersion === undefined ? 1 : source.schemaVersion;
  if (
    schemaVersion !== 1
    || typeof source.recoveryId !== "string"
    || typeof source.actionId !== "string"
    || typeof source.workspaceRoot !== "string"
    || typeof source.createdAt !== "number"
    || !Array.isArray(source.documents)
  ) return null;
  const documents = source.documents.map((document) => {
    if (!document || typeof document !== "object") return null;
    const item = document as Record<string, unknown>;
    if (
      typeof item.uri !== "string"
      || (item.canonicalPath !== null && typeof item.canonicalPath !== "string")
      || typeof item.preText !== "string"
      || typeof item.preHash !== "string"
      || typeof item.postText !== "string"
      || typeof item.postHash !== "string"
    ) return null;
    return {
      uri: item.uri,
      canonicalPath: item.canonicalPath as string | null,
      preText: item.preText,
      preHash: item.preHash,
      postText: item.postText,
      postHash: item.postHash,
    };
  });
  if (documents.some((document) => document === null)) return null;
  return {
    schemaVersion: 1,
    verified: false,
    recoveryId: source.recoveryId,
    actionId: source.actionId,
    kind: source.kind as RefactorKind,
    workspaceRoot: source.workspaceRoot,
    createdAt: source.createdAt,
    status: source.status === "committed" || source.status === "rolled-back" ? source.status : "prepared",
    documents: documents as RefactorRecoveryJournalEntryV1["documents"],
  };
}

function validRecoveryRecordForWorkspace(
  value: RefactorRecoveryJournalRecord,
  workspaceRoot?: string,
): boolean {
  return !workspaceRoot || fsPathEquals(value.workspaceRoot, workspaceRoot);
}

export function recordRefactorRecoveryJournal(
  entry: RefactorRecoveryJournalEntry,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): { ok: true; entry: RefactorRecoveryJournalEntry } | { ok: false; entry: RefactorRecoveryJournalEntry; reason: string } {
  try {
    if (typeof storage.setItem !== "function") {
      return { ok: false, entry, reason: "Refactor recovery storage is unavailable" };
    }
    const next = { ...entry, updatedAt: Date.now() };
    storage.setItem(recoveryStorageKey(RECOVERY_STORAGE_PREFIX_V2, entry.recoveryId), JSON.stringify(next));
    Object.assign(entry, next);
    return { ok: true, entry };
  } catch (error) {
    return {
      ok: false,
      entry,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getRefactorRecoveryJournal(
  recoveryId: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): RefactorRecoveryJournalRecord | null {
  try {
    const v2 = storage.getItem?.(recoveryStorageKey(RECOVERY_STORAGE_PREFIX_V2, recoveryId));
    if (v2) return parseRefactorRecoveryRecord(JSON.parse(v2));
    const v1 = storage.getItem?.(recoveryStorageKey(RECOVERY_STORAGE_PREFIX_V1, recoveryId));
    return v1 ? parseRefactorRecoveryRecord(JSON.parse(v1)) : null;
  } catch {
    return null;
  }
}

export function listRefactorRecoveryJournals(
  workspaceRoot?: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): RefactorRecoveryJournalRecord[] {
  const entries: RefactorRecoveryJournalRecord[] = [];
  try {
    const len = storage.length ?? 0;
    for (let i = 0; i < len; i += 1) {
      const key = storage.key?.(i);
      if (!key || (!key.startsWith(RECOVERY_STORAGE_PREFIX_V1) && !key.startsWith(RECOVERY_STORAGE_PREFIX_V2))) continue;
      try {
        const raw = storage.getItem?.(key);
        const parsed = raw ? parseRefactorRecoveryRecord(JSON.parse(raw)) : null;
        if (parsed && validRecoveryRecordForWorkspace(parsed, workspaceRoot)) entries.push(parsed);
      } catch {
        // One corrupt row must not hide other workspace recovery entries.
      }
    }
  } catch {
    return entries;
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

export function listPendingRefactorRecoveryJournals(
  workspaceRoot?: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): RefactorRecoveryJournalRecord[] {
  return listRefactorRecoveryJournals(workspaceRoot, storage).filter((entry) => (
    entry.schemaVersion === 1
      ? entry.status === "prepared"
      : entry.status !== "committed" && entry.status !== "rolled-back"
  ));
}

export function clearRefactorRecoveryJournal(
  recoveryId: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): void {
  try {
    storage.removeItem?.(recoveryStorageKey(RECOVERY_STORAGE_PREFIX_V2, recoveryId));
    storage.removeItem?.(recoveryStorageKey(RECOVERY_STORAGE_PREFIX_V1, recoveryId));
  } catch {
    // Ignore storage deletion errors
  }
}

export interface RefactorRecoveryReplayDocument {
  text: string;
  hash?: string;
  dirty?: boolean;
  /** Present for open buffers so recovery can detect a concurrent edit. */
  documentRevision?: number | null;
}

export interface RefactorRecoveryReplayHandlers {
  readText: (
    pathOrUri: string,
    document: RefactorRecoveryDocumentSnapshot,
  ) => Promise<RefactorRecoveryReplayDocument | null>;
  applyText: (
    pathOrUri: string,
    text: string,
    document: RefactorRecoveryDocumentSnapshot,
    expectedDocumentRevision?: number | null,
  ) => Promise<void> | void;
  /** Durable progress callback after one recovery write has settled. */
  onDocumentApplied?: (
    pathOrUri: string,
    document: RefactorRecoveryDocumentSnapshot,
  ) => Promise<void> | void;
}

export type RefactorRecoveryReplayResult =
  | {
    status: "rolled-back";
    restoredUris: string[];
    preHashesRestored: true;
    conflicts: string[];
  }
  | {
    status: "pending" | "unverified";
    restoredUris: string[];
    preHashesRestored: false;
    conflicts: string[];
    reason: string;
  };

export async function replayRefactorRecoveryJournal(
  entry: RefactorRecoveryJournalRecord,
  handlers: RefactorRecoveryReplayHandlers,
): Promise<RefactorRecoveryReplayResult> {
  if (entry.schemaVersion !== 2) {
    return {
      status: "unverified",
      restoredUris: [],
      preHashesRestored: false,
      conflicts: [],
      reason: "Legacy refactor recovery journal v1 is inspection-only and cannot be replayed automatically",
    };
  }

  const current: Array<{ document: RefactorRecoveryDocumentSnapshot; path: string; value: RefactorRecoveryReplayDocument }> = [];
  const conflicts: string[] = [];
  try {
    for (const doc of entry.documents) {
      const path = doc.canonicalPath || doc.uri;
      const value = await handlers.readText(path, doc);
      if (!value) {
        conflicts.push(`${path}: current content could not be read`);
        continue;
      }
      if (value.dirty) {
        conflicts.push(`${path}: open buffer has unsaved changes`);
        continue;
      }
      current.push({ document: doc, path, value });
      const currentHash = value.hash ?? sha256Hex(value.text);
      if (currentHash !== doc.preHash && currentHash !== doc.postHash) {
        conflicts.push(`${path}: current content differs from both known recovery images`);
      }
    }
  } catch (error) {
    return {
      status: "pending",
      restoredUris: [],
      preHashesRestored: false,
      conflicts,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (conflicts.length > 0 || current.length !== entry.documents.length) {
    return {
      status: "pending",
      restoredUris: [],
      preHashesRestored: false,
      conflicts,
      reason: conflicts.join("; ") || "Recovery precondition could not be verified",
    };
  }

  const restoredUris: string[] = [];
  try {
    for (const { document, path, value: initial } of current) {
      // The initial all-files preflight prevents known conflicts before the
      // first write. Re-read immediately before each write as well so a
      // third-party change between files cannot be overwritten by recovery.
      const latest = await handlers.readText(path, document);
      if (!latest) {
        return {
          status: "pending",
          restoredUris,
          preHashesRestored: false,
          conflicts: [`${path}: current content could not be read before restore`],
          reason: `${path}: current content could not be read before restore`,
        };
      }
      if (latest.dirty) {
        return {
          status: "pending",
          restoredUris,
          preHashesRestored: false,
          conflicts: [`${path}: open buffer has unsaved changes`],
          reason: `${path}: open buffer has unsaved changes`,
        };
      }
      const initialRevision = initial.documentRevision ?? null;
      const latestRevision = latest.documentRevision ?? null;
      if (initialRevision !== latestRevision) {
        const reason = `${path}: open buffer document revision changed during recovery`;
        return {
          status: "pending",
          restoredUris,
          preHashesRestored: false,
          conflicts: [reason],
          reason,
        };
      }
      const currentHash = latest.hash ?? sha256Hex(latest.text);
      if (currentHash !== document.preHash && currentHash !== document.postHash) {
        const reason = `${path}: current content differs from both known recovery images`;
        return {
          status: "pending",
          restoredUris,
          preHashesRestored: false,
          conflicts: [reason],
          reason,
        };
      }
      if (currentHash === document.preHash) continue;
      await handlers.applyText(path, document.preText, document, latest.documentRevision);
      restoredUris.push(document.uri);
      await handlers.onDocumentApplied?.(path, document);
    }
  } catch (error) {
    return {
      status: "pending",
      restoredUris,
      preHashesRestored: false,
      conflicts,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const postWriteConflicts: string[] = [];
  try {
    for (const { document, path } of current) {
      const value = await handlers.readText(path, document);
      const actualHash = value?.hash ?? (value ? sha256Hex(value.text) : null);
      if (!value || value.dirty || actualHash !== document.preHash) {
        postWriteConflicts.push(`${path}: restored content failed independent preimage verification`);
      }
    }
  } catch (error) {
    postWriteConflicts.push(error instanceof Error ? error.message : String(error));
  }
  if (postWriteConflicts.length > 0) {
    return {
      status: "pending",
      restoredUris,
      preHashesRestored: false,
      conflicts: postWriteConflicts,
      reason: postWriteConflicts.join("; "),
    };
  }
  return {
    status: "rolled-back",
    restoredUris,
    preHashesRestored: true,
    conflicts: [],
  };
}

