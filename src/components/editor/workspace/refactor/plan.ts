import { normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";
import { workspaceEditOperations } from "../workspaceEditPreview";
import { useProjectFactsStore } from "../../../../stores/projectFactsStore";
import { sha256Hex } from "../projectAnalysisModel";
import { applyLspTextEditsToString } from "../lspTextEdits";
import {
  type SafeDeleteAttestationV1,
  type DestructiveRefactorAvailability,
  type RefactorPlanV4,
  type RefactorGateDecision,
  type RefactorConflictV3,
  type RefactorUriOwner,
  type BuildRefactorPlanInput,
  type RefactorDocumentPreconditionV4,
  type RefactorConflictSource,
  type RefactorFactV4,
} from "./types";

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

export function classifyUriOwner(uri: string, path: string | null, roots: readonly { path: string; }[]): RefactorUriOwner {
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

export function matchOpenFile(
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

  const affectedMap = new Map<string, { uri: string; path: string | null; owner: RefactorUriOwner; }>();
  const groupMap = new Map<string, { id: string; label: string; indexes: number[]; required: boolean; }>();
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
  const affectedUris: Array<{ uri: string; revision: number | null; owner: RefactorUriOwner; }> = [];

  const conflicts: Array<RefactorConflictV3 & { source: RefactorConflictSource; }> = [];

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
): { safe: boolean; reason: string | null; } {
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
