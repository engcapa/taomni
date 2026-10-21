import { workspaceReadFile } from "../../../../lib/editor/workspace";
import type { WorkspaceSearchMatch } from "../../../../lib/editor/workspaceSearch";
import { type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type WorkspaceEditApplyOutcome, type WorkspaceEditApplyTransactionSummary } from "../workspaceEditApply";
import { buildReplaceWorkspaceEdit, workspaceSearchMatchKey } from "../buildReplaceEdits";
import { replaceMatchAbsolutePath, replacePreimageExpectedHashes, replacePreimagePathKey, searchMatchesToReplaceInputs, summarizeReplaceCommitReport, validateReplacePreflight, validateReplacePreviewSelection, verifyReplaceMatchFreshness, type ReplacePreviewSnapshot, type ReplacePreflightFileInput } from "../replaceInFilesModel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, fsPathEquals, relativePathWithinRoot } from "../codeWorkspaceModel";
import { type WorkspaceEditApplyOptions } from "./mutationTypes";


export interface ReplaceMatchesContext {
  setStatusMessage: (message: string) => void;
  workspaceInstanceId: string;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  workspaceResourceOperationLockedRef: import("react").RefObject<boolean>;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: WorkspaceEditApplyOptions) => Promise<WorkspaceEditApplyOutcome[]>;
}


export function createReplaceMatches(controllerContext: ReplaceMatchesContext): (matches: WorkspaceSearchMatch[], replacement: string, edit: LspWorkspaceEdit, snapshot: ReplacePreviewSnapshot) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }> {
  return async (matches, replacement, edit, snapshot) => {
    void replacement;
    if (!snapshot) {
      const message = "Replace refused: replace preview snapshot missing";
      controllerContext.setStatusMessage(message);
      return { ok: false, message };
    }
    if (snapshot.requestIdentity && snapshot.requestIdentity.workspaceInstanceId !== controllerContext.workspaceInstanceId) {
      const message = "Replace refused: workspace instance mismatch";
      controllerContext.setStatusMessage(message);
      return { ok: false, message };
    }
    // ED-FIND-004 A2/A3 / ED-REPAIR-002: pre-commit atomic whole-set preflight
    // before the shared WorkspaceEdit path applies anything.
    const byFile = new Map<string, WorkspaceSearchMatch[]>();
    for (const match of matches) {
      const absolute = replaceMatchAbsolutePath(match);
      const list = byFile.get(absolute);
      if (list) list.push(match);
      else byFile.set(absolute, [match]);
    }
    if (byFile.size === 0) {
      return { ok: false, message: "Nothing to replace" };
    }

    // ED-REPAIR-002: Validate selected matches and edits against the frozen snapshot
    const selectedMatchKeys = new Set(matches.map(workspaceSearchMatchKey));
    const expectedEdit = buildReplaceWorkspaceEdit(matches, snapshot.replacement);
    const selectionValidation = validateReplacePreviewSelection(
      snapshot,
      selectedMatchKeys,
      edit,
      expectedEdit,
    );
    if (!selectionValidation.ok) {
      const message = selectionValidation.reason ?? "Selection validation failed";
      controllerContext.setStatusMessage(message);
      return { ok: false, message };
    }

    // ED-REPAIR-002: Whole-set atomic preflight across ALL files before any mutation
    const preflightInputs: ReplacePreflightFileInput[] = [];
    const diskTexts = new Map<string, string>();
    for (const absolute of byFile.keys()) {
      const containing = controllerContext.rootsRef.current.find(
        (root) => relativePathWithinRoot(root.path, absolute) !== null,
      );
      if (!containing) {
        const message = `Replace refused: ${absolute} is outside the workspace`;
        controllerContext.setStatusMessage(message);
        return { ok: false, message };
      }
      const open = Object.values(controllerContext.openFilesRef.current).find((file) => {
        const currentPath = controllerContext.absolutePathForOpenFile(file);
        return currentPath !== null && fsPathEquals(currentPath, absolute);
      });
      let exists = false;
      let diskHash: string | null = null;
      let diskText: string | null = null;
      let encoding: string | undefined;
      let bom: boolean | undefined;
      let eol: ("lf" | "crlf" | "cr") | undefined;
      try {
        const relative = relativePathWithinRoot(containing.path, absolute) ?? "";
        const disk = await workspaceReadFile(containing.path, relative);
        exists = true;
        diskHash = disk.hash;
        diskText = disk.text;
        encoding = disk.encoding;
        bom = disk.bom;
        eol = disk.text.includes("\r\n") ? "crlf" : disk.text.includes("\r") && !disk.text.includes("\n") ? "cr" : "lf";
      } catch {
        exists = false;
      }
      if (diskText !== null) {
        diskTexts.set(absolute, diskText);
      }
      preflightInputs.push({
        path: absolute,
        exists,
        diskHash,
        diskText,
        encoding,
        bom,
        eol,
        isOpen: Boolean(open),
        openBufferRevision: open?.documentRevision ?? null,
        openBufferDirty: open?.dirty ?? false,
        openBufferReadOnly: Boolean(open?.library) || controllerContext.workspaceResourceOperationLockedRef.current,
      });
    }

    const preflight = validateReplacePreflight(
      snapshot,
      controllerContext.workspaceInstanceId,
      preflightInputs,
    );

    let modelMatches: ReturnType<typeof searchMatchesToReplaceInputs>;
    try {
      modelMatches = searchMatchesToReplaceInputs(matches);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controllerContext.setStatusMessage(message);
      return { ok: false, message };
    }
    const freshness = verifyReplaceMatchFreshness(diskTexts, modelMatches);
    const conflicts = [
      ...preflight.conflicts,
      ...freshness.map((conflict) => ({
        path: conflict.path,
        reason: conflict.reason,
      })),
    ];
    if (conflicts.length > 0) {
      const message = `Replace blocked: ${conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`).join("; ")}`;
      controllerContext.setStatusMessage(message);
      return { ok: false, message };
    }

    // ED-AUDIT-003: the applier's per-operation ledger is the
    // only truth for what actually changed. A failed or skipped
    // document (readonly file, disk write failure, declined
    // retry) must surface the real applied set — never a
    // planned-count "all complete" report.
    // ED-MAIN-005: hand the frozen preview hashes to the applier
    // so the closed-file write precondition is the preview
    // preimage, not the second read.
    // ED-REPAIR-002: pass expectedPreimages to enforce open buffer revision and dirty
    // integrity throughout mutation.
    const selectedPaths = new Set(Array.from(byFile.keys(), replacePreimagePathKey));
    const selectedSnapshot = {
      ...snapshot,
      preimages: snapshot.preimages?.filter((preimage) => selectedPaths.has(replacePreimagePathKey(preimage.path))),
    };
    const expectedDiskHashes = replacePreimageExpectedHashes(selectedSnapshot);
    const summaryHolder: { current: WorkspaceEditApplyTransactionSummary | null } = { current: null };
    const outcomes = await controllerContext.applyLspWorkspaceEdit(edit, {
      label: "Replace in files",
      kind: "replace",
      expectedDiskHashes: expectedDiskHashes.size > 0 ? expectedDiskHashes : null,
      expectedPreimages: selectedSnapshot.preimages ?? null,
      onTransactionSummary: (summary) => {
        summaryHolder.current = summary;
      },
    });
    const report = summarizeReplaceCommitReport(outcomes, modelMatches);
    const recoveryId = summaryHolder.current?.recoveryId ?? null;
    const statusMsg = recoveryId && !report.ok && report.appliedCount > 0
      ? `${report.message}; recovery required (entry: ${recoveryId})`
      : report.message;
    controllerContext.setStatusMessage(statusMsg);
    return {
      ok: report.ok,
      appliedCount: report.appliedCount,
      fileCount: report.fileCount,
      ...(report.ok ? {} : { message: statusMsg }),
    };
          };
}
