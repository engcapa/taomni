import { fsPathComparisonKey, relativePathWithinRoot } from "../codeWorkspaceModel";
import type { FindInFilesScopePlan } from "../findInFilesScopeModel";
import { type CollectReplacePreimagesParams, type ReplaceFilePreimage, type ReplacePreviewSnapshot, type ReplaceScopeIdentity } from "./model";

/**
 * ED-REPAIR-005: Collect replace preimages while enforcing workspace instance,
 * roots, and open buffer revision/dirty integrity across all async reads.
 * Any mid-read mutation or abort cancels/refuses the prepare cleanly with zero writes.
 */
export async function collectReplacePreimages(
  params: CollectReplacePreimagesParams,
): Promise<readonly ReplaceFilePreimage[]> {
  const {
    paths,
    options,
    initialWorkspaceInstanceId,
    getCurrentWorkspaceInstanceId,
    getCurrentRoots,
    getOpenFileState,
    readFile,
    isLocked,
  } = params;

  if (options?.signal?.aborted) {
    throw new Error("Replace preview cancelled");
  }
  if (options?.workspaceInstanceId && options.workspaceInstanceId !== initialWorkspaceInstanceId) {
    throw new Error("Replace preview refused: workspace instance mismatch");
  }

  const initialRoots = getCurrentRoots();
  const initialOpenMap = new Map<string, { revision: number | null; dirty: boolean; }>();
  for (const absolute of paths) {
    const open = getOpenFileState(absolute);
    initialOpenMap.set(absolute, {
      revision: open?.documentRevision ?? null,
      dirty: open?.dirty ?? false,
    });
  }

  const preimages: ReplaceFilePreimage[] = [];
  for (const absolute of paths) {
    if (options?.signal?.aborted) {
      throw new Error("Replace preview cancelled");
    }
    if (getCurrentWorkspaceInstanceId() !== initialWorkspaceInstanceId) {
      throw new Error("Replace preview cancelled: workspace changed during prepare");
    }
    const currentRoots = getCurrentRoots();
    const containing = currentRoots.find(
      (root) => relativePathWithinRoot(root.path, absolute) !== null,
    );
    if (!containing) {
      throw new Error(`Replace preview refused: ${absolute} is outside the workspace`);
    }
    const relative = relativePathWithinRoot(containing.path, absolute) ?? "";
    const disk = await readFile(containing.path, relative);
    if (options?.signal?.aborted) {
      throw new Error("Replace preview cancelled");
    }
    if (getCurrentWorkspaceInstanceId() !== initialWorkspaceInstanceId) {
      throw new Error("Replace preview cancelled: workspace changed during prepare");
    }
    const openAfter = getOpenFileState(absolute);
    const initialOpen = initialOpenMap.get(absolute);
    const afterRevision = openAfter?.documentRevision ?? null;
    const afterDirty = openAfter?.dirty ?? false;
    if (initialOpen && (afterRevision !== initialOpen.revision || afterDirty !== initialOpen.dirty)) {
      throw new Error(`Replace preview refused: ${absolute} was modified during prepare; please retry`);
    }
    const eol = disk.text.includes("\r\n")
      ? ("crlf" as const)
      : disk.text.includes("\r") && !disk.text.includes("\n")
        ? ("cr" as const)
        : ("lf" as const);
    preimages.push({
      path: absolute,
      uri: `file://${absolute}`,
      textHash: disk.hash,
      encoding: disk.encoding ?? "UTF-8",
      bom: disk.bom ?? false,
      eol,
      bufferRevision: afterRevision,
      dirty: afterDirty,
      readOnly: !!openAfter?.readOnly || !!isLocked?.(),
      workspaceInstanceId: initialWorkspaceInstanceId,
    });
  }

  // After all awaits complete, re-verify workspace instance, roots, and buffer states
  if (getCurrentWorkspaceInstanceId() !== initialWorkspaceInstanceId || getCurrentRoots() !== initialRoots) {
    throw new Error("Replace preview cancelled: workspace state changed during prepare");
  }
  for (const [absolute, initialOpen] of initialOpenMap.entries()) {
    const openAfter = getOpenFileState(absolute);
    const afterRevision = openAfter?.documentRevision ?? null;
    const afterDirty = openAfter?.dirty ?? false;
    if (afterRevision !== initialOpen.revision || afterDirty !== initialOpen.dirty) {
      throw new Error(`Replace preview refused: ${absolute} was modified during prepare; please retry`);
    }
  }

  return preimages;
}

/**
 * ED-REPAIR-006: canonical path comparison key that preserves case on POSIX,
 * normalizes Windows drive/separator and UNC syntax, and handles file:// URIs.
 */
export function replacePreimagePathKey(path: string): string {
  return fsPathComparisonKey(path);
}

export function findReplacePreimage(
  snapshot: Pick<ReplacePreviewSnapshot, "preimages">,
  path: string,
): ReplaceFilePreimage | null {
  const key = replacePreimagePathKey(path);
  return snapshot.preimages?.find((preimage) => replacePreimagePathKey(preimage.path) === key) ?? null;
}

/**
 * ED-MAIN-005: per-file precondition map consumed by the applier. Only files
 * with a captured preimage get an expected hash; legacy snapshots stay on the
 * existing freshness gate.
 * ED-REPAIR-006: canonical path keys preserve case on POSIX and normalize on
 * Windows/UNC. Conflicting preimages for the same canonical path throw an explicit conflict.
 */
export function replacePreimageExpectedHashes(
  snapshot: Pick<ReplacePreviewSnapshot, "preimages">,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const preimage of snapshot.preimages ?? []) {
    const key = replacePreimagePathKey(preimage.path);
    const existing = map.get(key);
    if (existing !== undefined && existing !== preimage.textHash) {
      throw new Error(
        `Conflicting replace preimages for canonical path "${key}": expected hash "${existing}" contradicts "${preimage.textHash}"`,
      );
    }
    map.set(key, preimage.textHash);
  }
  return map;
}

export function replaceScopeIdentityFromPlan(
  plan: FindInFilesScopePlan,
): ReplaceScopeIdentity {
  return {
    kind: plan.kind,
    roots: plan.status === "ready" ? [...plan.roots] : [],
    explicitFiles: plan.status === "ready" ? [...(plan.explicitFiles ?? [])] : [],
    fileMask: plan.fileMask ?? null,
    generation: plan.generation ?? null,
  };
}
