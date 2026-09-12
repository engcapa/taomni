import type {
  LspLocation,
  LspWorkspaceEdit,
  LspWorkspaceEditOperation,
} from "../../../lib/editor/lsp";
import { normalizeFsPath, relativePathWithinRoot } from "./codeWorkspaceModel";
import type { CapabilityEvidenceV3 } from "./capabilityEvidence";
import { workspaceEditOperations } from "./workspaceEditPreview";
import { useProjectFactsStore } from "../../../stores/projectFactsStore";
import { sha256Hex } from "./projectAnalysisModel";
import { applyLspTextEditsToString } from "./lspTextEdits";
import { normalizeLineEndings } from "./saveNormalizationPipeline";

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
  | "replace"
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

/**
 * ED-IMPROVE-002: the subset of a refactor plan the shared apply boundary
 * needs to prepare a crash-recovery journal and verify post-hashes. Workflow
 * execute owners build this directly from their own frozen plan instead of
 * creating a second competing recovery/history system.
 */
export interface WorkspaceEditRecoveryPlan {
  actionId: string;
  kind: RefactorKind;
  documents: readonly RefactorDocumentPreconditionV4[];
}

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
    const sourceText = matched?.text
      ?? input.currentTexts?.[info.uri]
      ?? (info.path ? input.currentTexts?.[info.path] : undefined)
      ?? null;

    let preTextSha256: string | null = null;
    let expectedPostHash: string | null = null;

    if (sourceText !== null) {
      preTextSha256 = sha256Hex(sourceText);
      const docEdits = operations.flatMap((op) => {
        if (op.kind === "text") {
          const opUri = op.document.uri || "";
          const opPath = op.document.path || "";
          if (opUri === info.uri || (info.path && opPath === info.path)) {
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
  plan: Pick<RefactorPlanV4, "documents">,
  actualPostTexts: Record<string, string>,
): {
  allMatched: boolean;
  mismatches: Array<{ uri: string; expectedPostHash: string; actualPostHash: string }>;
  verifiedDocuments: number;
} {
  const mismatches: Array<{ uri: string; expectedPostHash: string; actualPostHash: string }> = [];
  let verifiedDocuments = 0;

  for (const doc of plan.documents) {
    if (!doc.expectedPostHash) continue;
    const actualText = actualPostTexts[doc.uri] ?? (doc.canonicalPath ? actualPostTexts[doc.canonicalPath] : undefined);
    if (actualText === undefined) continue;
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
    allMatched: mismatches.length === 0,
    mismatches,
    verifiedDocuments,
  };
}

/**
 * ED-REF-001-A4: Recovery journal entry holding before/after preimages and
 * hashes so that restart recovery can replay or restore consistently.
 */
export interface RefactorRecoveryDocumentSnapshot {
  uri: string;
  canonicalPath: string | null;
  preText: string;
  preHash: string;
  postText: string;
  postHash: string;
}

export interface RefactorRecoveryJournalEntry {
  recoveryId: string;
  actionId: string;
  kind: RefactorKind;
  workspaceRoot: string;
  createdAt: number;
  status: "prepared" | "committed" | "rolled-back";
  documents: readonly RefactorRecoveryDocumentSnapshot[];
}

export function buildRefactorRecoveryJournalEntry(
  plan: RefactorPlanV4,
  preTexts: Record<string, string>,
  workspaceRoot: string,
): RefactorRecoveryJournalEntry | null {
  const documents: RefactorRecoveryDocumentSnapshot[] = [];
  for (const doc of plan.documents) {
    const text = preTexts[doc.uri] ?? (doc.canonicalPath ? preTexts[doc.canonicalPath] : undefined);
    if (text === undefined) return null;
    const preHash = sha256Hex(text);
    const docEdits = plan.operations.flatMap((op) => {
      if (op.kind === "text") {
        const opUri = op.document.uri || "";
        const opPath = op.document.path || "";
        if (opUri === doc.uri || (doc.canonicalPath && opPath === doc.canonicalPath)) {
          return op.document.edits;
        }
      }
      return [];
    });
    const postText = docEdits.length > 0 ? applyLspTextEditsToString(text, docEdits) : text;
    const postHash = sha256Hex(postText);
    documents.push({
      uri: doc.uri,
      canonicalPath: doc.canonicalPath,
      preText: text,
      preHash,
      postText,
      postHash,
    });
  }
  return {
    recoveryId: `ref-rec-${sha256Hex(`${plan.actionId}:${Date.now()}`).slice(0, 16)}`,
    actionId: plan.actionId,
    kind: plan.kind,
    workspaceRoot,
    createdAt: Date.now(),
    status: "prepared",
    documents: Object.freeze(documents),
  };
}

const RECOVERY_STORAGE_PREFIX = "taomni.refactor.recovery.v1:";

export function recordRefactorRecoveryJournal(
  entry: RefactorRecoveryJournalEntry,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): void {
  try {
    storage.setItem?.(`${RECOVERY_STORAGE_PREFIX}${entry.recoveryId}`, JSON.stringify(entry));
  } catch {
    // Non-blocking quota failure
  }
}

export function getRefactorRecoveryJournal(
  recoveryId: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): RefactorRecoveryJournalEntry | null {
  try {
    const raw = storage.getItem?.(`${RECOVERY_STORAGE_PREFIX}${recoveryId}`);
    return raw ? (JSON.parse(raw) as RefactorRecoveryJournalEntry) : null;
  } catch {
    return null;
  }
}

export function listRefactorRecoveryJournals(
  workspaceRoot?: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): RefactorRecoveryJournalEntry[] {
  const entries: RefactorRecoveryJournalEntry[] = [];
  try {
    const len = storage.length ?? 0;
    for (let i = 0; i < len; i += 1) {
      const key = storage.key?.(i);
      if (key?.startsWith(RECOVERY_STORAGE_PREFIX)) {
        const raw = storage.getItem?.(key);
        if (raw) {
          const parsed = JSON.parse(raw) as RefactorRecoveryJournalEntry;
          if (!workspaceRoot || parsed.workspaceRoot === workspaceRoot) {
            entries.push(parsed);
          }
        }
      }
    }
  } catch {
    // Return available entries
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

export function clearRefactorRecoveryJournal(
  recoveryId: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): void {
  try {
    storage.removeItem?.(`${RECOVERY_STORAGE_PREFIX}${recoveryId}`);
  } catch {
    // Ignore storage deletion errors
  }
}

/**
 * ED-AUDIT-014 v2 recovery journal.
 *
 * Unlike v1, a v2 entry is persisted BEFORE the first mutation with a typed
 * success/failure result, carries the actually-applied edit's postimages,
 * per-resource encoding/BOM/EOL, the applied operation index, and an explicit
 * verification record. v1 entries stay readable but are never parsed as v2 or
 * auto-replayed.
 */

export interface RefactorRecoveryDocumentSnapshotV2 {
  uri: string;
  canonicalPath: string | null;
  preText: string;
  preHash: string;
  postText: string;
  postHash: string;
  encoding: string;
  bom: boolean;
  eol: "lf" | "crlf" | "cr" | null;
}

export type RefactorRecoveryStatusV2 =
  | "prepared" // persisted before the first mutation; may or may not have mutated
  | "recovery-required" // postcondition mismatch or read failure; never a success
  | "committed" // every postcondition verified; normal history/undo registered
  | "rolled-back"; // recovery confirmed every preHash via independent read-back

export interface RefactorRecoveryJournalEntryV2 {
  schemaVersion: 2;
  recoveryId: string;
  transactionId: string;
  actionId: string;
  kind: RefactorKind;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  status: RefactorRecoveryStatusV2;
  /** Index of the last settled operation before the run stopped; null when the full edit applied. */
  appliedOperationIndex: number | null;
  documents: readonly RefactorRecoveryDocumentSnapshotV2[];
  /**
   * ED-FOLLOW-001: server-side file moves journalled alongside the text
   * documents. A rename's content usually also rides a text op (whose
   * snapshot carries the pre/post images); the move record pins the
   * old->new path pair so crash recovery can reverse the relocation itself.
   * Empty for text-only transactions and for entries written before moves
   * were journalled.
   */
  resourceMoves: readonly RefactorRecoveryResourceMoveV1[];
  verification: {
    mismatchedUris: readonly string[];
    checkedAt: number | null;
    /**
     * ED-FOLLOW-001: new-paths the recovery run moved back to their old
     * paths. Read by QA to prove the reversal happened; never inferred.
     */
    reversedMoves?: readonly string[];
    /** ED-REPAIR-004: real applied effects and failed outcomes recorded in the persistent journal. */
    appliedEffects?: readonly string[];
    failedEffects?: readonly {
      path: string;
      status: string;
      reason?: string | null;
      diskEffect?: string;
    }[];
    lastRecoveryError?: string | null;
    restoredUris?: readonly string[];
  };
}

/**
 * ED-FOLLOW-001: one journalled server-side file relocation.
 * `contentHash` is the hash of the moved bytes at prepare time, taken from
 * the matching text-op preimage when the moved file also carries text edits;
 * null when the move has no text op (reversal then moves bytes without a
 * content proof and reports the move as content-unverified).
 */
export interface RefactorRecoveryResourceMoveV1 {
  oldUri: string;
  newUri: string;
  oldPath: string | null;
  newPath: string | null;
  contentHash: string | null;
}

export type RefactorJournalWriteResult =
  | { ok: true }
  | { ok: false; reason: string };

const RECOVERY_STORAGE_PREFIX_V2 = "taomni.refactor.recovery.v2:";

function defaultRecoveryStorage(): Storage {
  return typeof window !== "undefined" ? window.localStorage : ({} as Storage);
}

export function isRefactorRecoveryJournalEntryV2(
  value: unknown,
): value is RefactorRecoveryJournalEntryV2 {
  if (!value || typeof value !== "object") return false;
  const entry = value as RefactorRecoveryJournalEntryV2;
  if (entry.schemaVersion !== 2) return false;
  if (typeof entry.recoveryId !== "string" || !entry.recoveryId) return false;
  if (typeof entry.transactionId !== "string" || !entry.transactionId) return false;
  if (typeof entry.actionId !== "string" || !entry.actionId) return false;
  if (typeof entry.kind !== "string") return false;
  if (typeof entry.workspaceRoot !== "string") return false;
  if (typeof entry.createdAt !== "number" || typeof entry.updatedAt !== "number") return false;
  if (
    entry.status !== "prepared" && entry.status !== "recovery-required"
    && entry.status !== "committed" && entry.status !== "rolled-back"
  ) {
    return false;
  }
  if (entry.appliedOperationIndex !== null && typeof entry.appliedOperationIndex !== "number") return false;
  if (!Array.isArray(entry.documents)) return false;
  for (const doc of entry.documents) {
    if (!doc || typeof doc !== "object") return false;
    const snapshot = doc as RefactorRecoveryDocumentSnapshotV2;
    if (typeof snapshot.uri !== "string" || !snapshot.uri) return false;
    if (typeof snapshot.preText !== "string" || typeof snapshot.preHash !== "string") return false;
    if (typeof snapshot.postText !== "string" || typeof snapshot.postHash !== "string") return false;
    if (typeof snapshot.encoding !== "string" || typeof snapshot.bom !== "boolean") return false;
  }
  // ED-FOLLOW-001: resourceMoves is optional so pre-move entries stay
  // readable; when present every move must carry its path pair.
  if (entry.resourceMoves !== undefined) {
    if (!Array.isArray(entry.resourceMoves)) return false;
    for (const move of entry.resourceMoves) {
      if (!move || typeof move !== "object") return false;
      const candidate = move as RefactorRecoveryResourceMoveV1;
      if (typeof candidate.oldUri !== "string" || typeof candidate.newUri !== "string") return false;
      if (
        candidate.oldPath !== null && typeof candidate.oldPath !== "string"
        || candidate.newPath !== null && typeof candidate.newPath !== "string"
        || candidate.contentHash !== null && typeof candidate.contentHash !== "string"
      ) return false;
    }
  }
  if (!entry.verification || typeof entry.verification !== "object") return false;
  if (!Array.isArray(entry.verification.mismatchedUris)) return false;
  return true;
}

/** Typed, non-swallowing journal write: quota and serialization errors surface. */
export function recordRefactorRecoveryJournalV2(
  entry: RefactorRecoveryJournalEntryV2,
  storage: Storage = defaultRecoveryStorage(),
): RefactorJournalWriteResult {
  try {
    storage.setItem?.(`${RECOVERY_STORAGE_PREFIX_V2}${entry.recoveryId}`, JSON.stringify(entry));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getRefactorRecoveryJournalV2(
  recoveryId: string,
  storage: Storage = defaultRecoveryStorage(),
): RefactorRecoveryJournalEntryV2 | null {
  try {
    const raw = storage.getItem?.(`${RECOVERY_STORAGE_PREFIX_V2}${recoveryId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRefactorRecoveryJournalEntryV2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface RefactorRecoveryJournalListingV2 {
  /** Validated v2 entries, newest first. */
  entries: RefactorRecoveryJournalEntryV2[];
  /** v1 keys found; counted but never parsed as v2 or replayed. */
  legacyCount: number;
  /** Unparseable or schema-invalid records under the v2 prefix. */
  invalidCount: number;
}

export function listRefactorRecoveryJournalsV2(
  workspaceRoot?: string,
  storage: Storage = defaultRecoveryStorage(),
): RefactorRecoveryJournalListingV2 {
  const entries: RefactorRecoveryJournalEntryV2[] = [];
  let legacyCount = 0;
  let invalidCount = 0;
  try {
    const len = storage.length ?? 0;
    for (let i = 0; i < len; i += 1) {
      const key = storage.key?.(i);
      if (key?.startsWith(RECOVERY_STORAGE_PREFIX_V2)) {
        const raw = storage.getItem?.(key);
        if (!raw) continue;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          invalidCount += 1;
          continue;
        }
        if (!isRefactorRecoveryJournalEntryV2(parsed)) {
          invalidCount += 1;
          continue;
        }
        if (!workspaceRoot || parsed.workspaceRoot === workspaceRoot) {
          entries.push(parsed);
        }
      } else if (key?.startsWith(RECOVERY_STORAGE_PREFIX)) {
        legacyCount += 1;
      }
    }
  } catch {
    // Storage itself unavailable; return whatever was collected so far.
  }
  return {
    entries: entries.sort((a, b) => b.createdAt - a.createdAt),
    legacyCount,
    invalidCount,
  };
}

/** Applies a status/field patch and persists it with a typed result. */
export function updateRefactorRecoveryJournalV2(
  recoveryId: string,
  patch: (entry: RefactorRecoveryJournalEntryV2) => RefactorRecoveryJournalEntryV2,
  storage: Storage = defaultRecoveryStorage(),
): RefactorJournalWriteResult {
  const current = getRefactorRecoveryJournalV2(recoveryId, storage);
  if (!current) return { ok: false, reason: `recovery journal ${recoveryId} is missing or invalid` };
  return recordRefactorRecoveryJournalV2(
    { ...patch(current), updatedAt: Date.now() },
    storage,
  );
}

export function clearRefactorRecoveryJournalV2(
  recoveryId: string,
  storage: Storage = defaultRecoveryStorage(),
): RefactorJournalWriteResult {
  try {
    storage.removeItem?.(`${RECOVERY_STORAGE_PREFIX_V2}${recoveryId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface RefactorRecoveryPreImageV2 {
  uri: string;
  canonicalPath: string | null;
  preText: string;
  encoding?: string;
  bom?: boolean;
  eol?: "lf" | "crlf" | "cr" | null;
}

/**
 * ED-AUDIT-014: compares a real post-state text against the journal's
 * expected post-image. The raw edit application is the primary expectation;
 * the EOL-normalized form is accepted as well because the shared committer
 * legitimately normalizes line endings when writing closed files with a
 * recorded EOL. Any other content is a real postcondition mismatch.
 */
export function refactorJournalPostImageMatches(
  doc: RefactorRecoveryDocumentSnapshotV2,
  actualText: string,
): boolean {
  if (sha256Hex(actualText) === doc.postHash) return true;
  if (doc.eol) {
    return sha256Hex(normalizeLineEndings(doc.postText, doc.eol)) === sha256Hex(actualText);
  }
  return false;
}

/**
 * ED-REPAIR-004: compares a real text against the journal's recorded pre-image,
 * accepting either exact or EOL-normalized match.
 */
export function refactorJournalPreImageMatches(
  doc: RefactorRecoveryDocumentSnapshotV2,
  actualText: string,
): boolean {
  if (sha256Hex(actualText) === doc.preHash) return true;
  if (doc.eol) {
    return sha256Hex(normalizeLineEndings(doc.preText, doc.eol)) === sha256Hex(actualText);
  }
  return false;
}

/**
 * Typed journal preparation for a plan-gated edit. `unsupported` marks the
 * explicit recovery boundary for create/delete resource operations: the
 * transaction proceeds without a journal instead of faking coverage.
 * `incomplete` means a text target has no preimage — the caller must abort
 * before any mutation because a complete journal cannot be built.
 *
 * ED-FOLLOW-001: rename (file-move) operations ARE journalled — the move
 * pair plus the moved bytes' content hash ride the entry so crash recovery
 * can reverse the relocation. Only create/delete stay unsupported.
 */
export type RefactorRecoveryJournalPreparation =
  | { state: "prepared"; entry: RefactorRecoveryJournalEntryV2 }
  | { state: "unsupported"; reason: string }
  | { state: "incomplete"; reason: string };

function recoveryMovePath(uri: string, path: string | null): string | null {
  if (path) return path;
  if (/^file:/i.test(uri)) {
    try {
      return decodeURIComponent(uri.replace(/^file:\/\//i, ""));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * ED-FOLLOW-001: resolves the live read target of a journal document through
 * journalled file moves. A text op addressed to the pre-move path reads at
 * the new path once the old path is gone (and back at the old path after a
 * reversal moved it home). `oldExists` is the live existence of the move's
 * old path; without a matching move the recorded target is used unchanged.
 */
export function resolveRecoveryDocTarget(
  doc: { uri: string; canonicalPath: string | null },
  moves: readonly RefactorRecoveryResourceMoveV1[],
  oldExists: (oldPath: string) => boolean,
): string {
  const recorded = doc.canonicalPath || doc.uri;
  for (const move of moves) {
    if (!move.oldPath || !move.newPath) continue;
    const recordedNorm = normalizeFsPath(recorded);
    if (
      normalizeFsPath(move.oldPath) === recordedNorm
      || normalizeFsPath(move.oldUri) === recordedNorm
    ) {
      return oldExists(move.oldPath) ? recorded : move.newPath;
    }
    if (
      normalizeFsPath(move.newPath) === recordedNorm
      || normalizeFsPath(move.newUri) === recordedNorm
    ) {
      return recorded;
    }
  }
  return recorded;
}

export function prepareRefactorRecoveryJournalV2(input: {
  plan: WorkspaceEditRecoveryPlan;
  edit: LspWorkspaceEdit;
  preImages: readonly RefactorRecoveryPreImageV2[];
  workspaceRoot: string;
  transactionId: string;
}): RefactorRecoveryJournalPreparation {
  const { plan, edit, preImages, workspaceRoot, transactionId } = input;
  const operations = workspaceEditOperations(edit);
  const textOperations = operations.filter((operation) => operation.kind === "text");
  const renameOperations = operations.filter((operation) => operation.kind === "rename");
  const unsupportedOperations = operations.filter((operation) => (
    operation.kind !== "text" && operation.kind !== "rename"
  ));
  if (unsupportedOperations.length > 0) {
    return {
      state: "unsupported",
      reason: "Recovery journal covers text edits and file moves; create/delete resource operations have no crash recovery",
    };
  }
  if (textOperations.length === 0 && renameOperations.length === 0) {
    return {
      state: "unsupported",
      reason: "Edit contains no text operations or file moves to journal",
    };
  }
  const resourceMoves: RefactorRecoveryResourceMoveV1[] = [];
  for (const operation of renameOperations) {
    if (operation.kind !== "rename") continue;
    const oldPath = recoveryMovePath(operation.oldUri, operation.oldPath);
    const newPath = recoveryMovePath(operation.newUri, operation.newPath);
    if (!oldPath || !newPath) {
      return {
        state: "incomplete",
        reason: `File move has no resolvable path pair (${operation.oldUri} -> ${operation.newUri}); refusing to mutate without a recovery journal`,
      };
    }
    // The moved bytes' content proof comes from the matching text-op
    // preimage when the moved file also carries text edits; null otherwise
    // (reversal then moves bytes without a content proof).
    const matchingPreImage = preImages.find((candidate) => (
      (candidate.canonicalPath !== null && normalizeFsPath(candidate.canonicalPath) === normalizeFsPath(oldPath))
      || candidate.uri === operation.oldUri
    ));
    resourceMoves.push({
      oldUri: operation.oldUri,
      newUri: operation.newUri,
      oldPath,
      newPath,
      contentHash: matchingPreImage ? sha256Hex(matchingPreImage.preText) : null,
    });
  }
  const documents: RefactorRecoveryDocumentSnapshotV2[] = [];
  for (const operation of textOperations) {
    const document = operation.document;
    const preImage = preImages.find((candidate) => (
      candidate.uri === document.uri
      || (document.path !== null && candidate.canonicalPath !== null
        && normalizeFsPath(candidate.canonicalPath) === normalizeFsPath(document.path))
    ));
    if (!preImage) {
      return {
        state: "incomplete",
        reason: `No preimage captured for ${document.path ?? document.uri}; refusing to mutate without a recovery journal`,
      };
    }
    const postText = document.edits.length > 0
      ? applyLspTextEditsToString(preImage.preText, document.edits)
      : preImage.preText;
    documents.push({
      uri: document.uri,
      canonicalPath: preImage.canonicalPath,
      preText: preImage.preText,
      preHash: sha256Hex(preImage.preText),
      postText,
      postHash: sha256Hex(postText),
      encoding: preImage.encoding ?? "UTF-8",
      bom: preImage.bom ?? false,
      eol: preImage.eol ?? null,
    });
  }
  const now = Date.now();
  return {
    state: "prepared",
    entry: {
      schemaVersion: 2,
      recoveryId: `ref-rec2-${sha256Hex(`${plan.actionId}:${transactionId}:${now}`).slice(0, 16)}`,
      transactionId,
      actionId: plan.actionId,
      kind: plan.kind,
      workspaceRoot,
      createdAt: now,
      updatedAt: now,
      status: "prepared",
      appliedOperationIndex: null,
      documents: Object.freeze(documents),
      resourceMoves: Object.freeze(resourceMoves),
      verification: { mismatchedUris: Object.freeze([]), checkedAt: null },
    },
  };
}

/**
 * ED-REPAIR-004: build an internal recovery plan description for general
 * text WorkspaceEdits (e.g. multi-file Replace) so that crashes, write
 * failures, or interrupted transactions have a discoverable recovery journal
 * without faking a provider refactoring action.
 */
export function buildTextWorkspaceEditRecoveryPlan(input: {
  actionId?: string;
  kind?: RefactorKind;
  label?: string | null;
  transactionId?: string;
}): WorkspaceEditRecoveryPlan {
  const kind: RefactorKind = input.kind
    ?? (input.label?.toLowerCase().includes("replace") ? "replace" : "other");
  const actionId = input.actionId
    ?? (input.label ? `workspace-edit:${input.label}` : `workspace-edit:${input.transactionId ?? Date.now()}`);
  return {
    actionId,
    kind,
    documents: [],
  };
}
