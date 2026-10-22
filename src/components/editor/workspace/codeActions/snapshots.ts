import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { sha256Hex } from "../projectAnalysisModel";
import {
  type CodeActionAffectedResource,
  type ImmutableCodeActionPlan,
  type CodeActionApplyHooks,
  type CodeActionTransactionSnapshot,
  type CodeActionResourceSnapshot,
  type CodeActionPlanPreview,
} from "./types";

export function extractAffectedResourcesFromWorkspaceEdit(
  edit: LspWorkspaceEdit | null | undefined,
): CodeActionAffectedResource[] {
  if (!edit) return [];
  const resources: CodeActionAffectedResource[] = [];
  const seen = new Set<string>();
  const add = (uri: string, path: string | null) => {
    const key = path || uri;
    if (!key || seen.has(key)) return;
    seen.add(key);
    resources.push({ uri, path });
  };
  if (edit.documentEdits) {
    for (const doc of edit.documentEdits) {
      add(doc.uri, doc.path);
    }
  }
  if (edit.operations) {
    for (const op of edit.operations) {
      if (op.kind === "text" && op.document?.uri) {
        add(op.document.uri, op.document.path);
      } else if (op.kind === "rename") {
        add(op.oldUri, op.oldPath);
        add(op.newUri, op.newPath);
      } else if ((op.kind === "create" || op.kind === "delete") && op.uri) {
        add(op.uri, op.path);
      }
    }
  }
  return resources;
}

export function extractAffectedUrisFromWorkspaceEdit(edit: LspWorkspaceEdit | null | undefined): string[] {
  return extractAffectedResourcesFromWorkspaceEdit(edit).map((resource) => resource.uri);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function verifyCodeActionApplyIdentity(
  plan: ImmutableCodeActionPlan,
  hooks: CodeActionApplyHooks,
): { valid: true; } | { valid: false; status: "stale" | "conflict"; reason: string; } {
  const liveDocRevision = hooks.getLiveDocumentRevision(plan.document.uri);
  if (liveDocRevision !== null && liveDocRevision !== plan.document.revision) {
    return {
      valid: false,
      status: "stale",
      reason: `Live document revision changed from ${plan.document.revision} to ${liveDocRevision}`,
    };
  }
  return hooks.verifyIdentity?.() ?? { valid: true };
}

export function freezeCodeActionSnapshot(
  snapshot: CodeActionTransactionSnapshot | null,
): CodeActionTransactionSnapshot | null {
  if (!snapshot) return null;
  return Object.freeze({
    resources: Object.freeze(snapshot.resources.map((resource) => Object.freeze({ ...resource }))),
  });
}

export async function captureCodeActionSnapshot(
  hooks: CodeActionApplyHooks,
  edit: LspWorkspaceEdit,
): Promise<CodeActionTransactionSnapshot | null> {
  if (!hooks.captureSnapshot) return null;
  try {
    return freezeCodeActionSnapshot(await hooks.captureSnapshot(edit));
  } catch {
    return null;
  }
}

export function codeActionSnapshotKey(resource: CodeActionResourceSnapshot): string {
  return resource.path || resource.uri;
}

export function codeActionSnapshotMismatch(
  expected: CodeActionTransactionSnapshot,
  current: CodeActionTransactionSnapshot,
): string | null {
  const currentByKey = new Map(current.resources.map((resource) => [codeActionSnapshotKey(resource), resource]));
  for (const resource of expected.resources) {
    const live = currentByKey.get(codeActionSnapshotKey(resource));
    if (!live) return `${resource.uri} is no longer readable`;
    if (
      live.exists !== resource.exists
      || live.text !== resource.text
      || live.encoding !== resource.encoding
      || live.bom !== resource.bom
      || live.eol !== resource.eol
    ) {
      return `${resource.uri} no longer matches the previewed preimage`;
    }
  }
  return null;
}

export function codeActionSnapshotHash(resource: CodeActionResourceSnapshot | undefined): string {
  if (!resource || !resource.exists || resource.text === null) {
    return sha256Hex("CODE_ACTION_RESOURCE_MISSING");
  }
  return sha256Hex(resource.text);
}

export function previewFromSnapshot(
  plan: ImmutableCodeActionPlan,
  snapshot: CodeActionTransactionSnapshot,
): CodeActionPlanPreview {
  const affectedUris = extractAffectedUrisFromWorkspaceEdit(plan.edit);
  if (affectedUris.length === 0) affectedUris.push(plan.document.uri);
  const preHashes = Object.fromEntries(affectedUris.map((uri) => [
    uri,
    codeActionSnapshotHash(snapshot.resources.find((resource) => resource.uri === uri)),
  ]));
  return {
    plan,
    affectedUris: Object.freeze(affectedUris),
    requiresConfirmation: affectedUris.length > 1,
    preHashes: Object.freeze(preHashes),
  };
}

export async function restoreAndVerifyCodeActionSnapshot(
  edit: LspWorkspaceEdit,
  expectedCurrent: CodeActionTransactionSnapshot,
  target: CodeActionTransactionSnapshot,
  hooks: CodeActionApplyHooks,
): Promise<void> {
  if (!hooks.captureSnapshot || !hooks.restoreSnapshot) {
    throw new Error("Code-action snapshot replay is unavailable");
  }
  const current = await captureCodeActionSnapshot(hooks, edit);
  if (!current) throw new Error("Cannot read resources before code-action replay");
  if (codeActionSnapshotMismatch(target, current) === null) return;
  const conflict = codeActionSnapshotMismatch(expectedCurrent, current);
  if (conflict) throw new Error(`Code-action replay conflict: ${conflict}`);
  await hooks.restoreSnapshot(target);
  const restored = await captureCodeActionSnapshot(hooks, edit);
  if (!restored) throw new Error("Cannot verify resources after code-action replay");
  const mismatch = codeActionSnapshotMismatch(target, restored);
  if (mismatch) throw new Error(`Code-action replay postcondition failed: ${mismatch}`);
}
