import type { LspFileTextEdits, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import { applyLspTextEditsToString } from "./lspTextEdits";

export type WorkspaceEditApplyOutcome =
  | { path: string; status: "applied-open"; dirty: boolean }
  | { path: string; status: "applied-disk" }
  | { path: string; status: "skipped"; reason: string }
  | { path: string; status: "failed"; reason: string };

export interface WorkspaceEditApplyHooks {
  /** Resolve absolute path from a file URI / server path. */
  resolvePath: (file: LspFileTextEdits) => string | null;
  /** Return open buffer text + dirty flag, or null if not open. */
  getOpenBuffer: (absolutePath: string) => { text: string; dirty: boolean; key: string } | null;
  /**
   * Apply text to an open buffer.
   * For dirty buffers this leaves the buffer dirty; for clean buffers the
   * applier will call `saveOpenBuffer` immediately afterwards (§5.2.9).
   */
  applyToOpenBuffer: (key: string, nextText: string) => void;
  /**
   * Persist an open clean buffer after applying edits.
   * Must write `nextText` to disk and leave the open buffer clean (dirty=false).
   */
  saveOpenBuffer: (key: string, nextText: string) => Promise<void>;
  /** Read disk contents for a closed file. */
  readDisk: (absolutePath: string) => Promise<{ text: string; hash: string } | null>;
  /** Write disk contents for a closed file (with hash precheck when available). */
  writeDisk: (absolutePath: string, text: string, expectedHash: string | null) => Promise<void>;
}

/**
 * Apply a WorkspaceEdit following §5.2.9 rules:
 * - open clean → apply to buffer and save (result dirty=false)
 * - open dirty → apply to buffer, keep dirty (result dirty=true)
 * - unopened → write disk with hash precheck when provided
 * Failures do not roll back already-applied files.
 */
export async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  hooks: WorkspaceEditApplyHooks,
): Promise<WorkspaceEditApplyOutcome[]> {
  const outcomes: WorkspaceEditApplyOutcome[] = [];
  for (const file of edit.documentEdits) {
    const path = hooks.resolvePath(file);
    if (!path) {
      outcomes.push({ path: file.uri, status: "skipped", reason: "unresolvable path" });
      continue;
    }
    if (!file.edits.length) {
      outcomes.push({ path, status: "skipped", reason: "no text edits" });
      continue;
    }
    try {
      const open = hooks.getOpenBuffer(path);
      if (open) {
        const next = applyLspTextEditsToString(open.text, file.edits);
        if (!open.dirty) {
          // Clean open buffer: apply then save so the user is not left with
          // an unexpected dirty marker after rename / code action / replace.
          hooks.applyToOpenBuffer(open.key, next);
          await hooks.saveOpenBuffer(open.key, next);
          outcomes.push({ path, status: "applied-open", dirty: false });
        } else {
          hooks.applyToOpenBuffer(open.key, next);
          outcomes.push({ path, status: "applied-open", dirty: true });
        }
        continue;
      }
      const disk = await hooks.readDisk(path);
      if (!disk) {
        outcomes.push({ path, status: "failed", reason: "file not found on disk" });
        continue;
      }
      const next = applyLspTextEditsToString(disk.text, file.edits);
      await hooks.writeDisk(path, next, disk.hash);
      outcomes.push({ path, status: "applied-disk" });
    } catch (error) {
      outcomes.push({
        path,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

export function summarizeWorkspaceEditOutcomes(outcomes: WorkspaceEditApplyOutcome[]): string {
  const applied = outcomes.filter((item) => item.status.startsWith("applied")).length;
  const failed = outcomes.filter((item) => item.status === "failed").length;
  const skipped = outcomes.filter((item) => item.status === "skipped").length;
  return `Applied ${applied}, failed ${failed}, skipped ${skipped}`;
}
