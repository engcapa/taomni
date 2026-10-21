import { fsPathComparisonKey } from "../codeWorkspaceModel";
import { type ReplaceApplyOutcomeLike, type ReplaceCommitReport, type ReplaceInFilesMatch } from "./model";

export const APPLIED_OUTCOME_STATUSES = new Set([
  "applied-open",
  "applied-disk",
  "applied-create",
  "applied-rename",
  "applied-delete",
]);

/**
 * ED-AUDIT-003: the applier's per-operation ledger is the only truth for what
 * actually changed. A failed or skipped document must surface the real applied
 * set — the report never claims the planned counts when effects stopped early,
 * and a declined retry leaves the replace preview open with the blocker list.
 */
export function summarizeReplaceCommitReport(
  outcomes: readonly ReplaceApplyOutcomeLike[],
  matches: readonly ReplaceInFilesMatch[],
): ReplaceCommitReport {
  const appliedPaths = new Set<string>();
  const blockers: string[] = [];
  for (const outcome of outcomes) {
    if (APPLIED_OUTCOME_STATUSES.has(outcome.status)) {
      appliedPaths.add(fsPathComparisonKey(outcome.path));
    }
    if (outcome.status === "failed" || outcome.status === "skipped") {
      blockers.push(`${outcome.path}: ${outcome.reason ?? "blocked"}`);
    }
  }
  const plannedKeys = Array.from(new Set(matches.map((match) => fsPathComparisonKey(match.filePath))));
  const appliedCount = matches.filter((match) => appliedPaths.has(fsPathComparisonKey(match.filePath))).length;
  const fileCount = plannedKeys.filter((key) => appliedPaths.has(key)).length;
  const ok = blockers.length === 0;
  const occurrence = (count: number) => `${count} occurrence${count === 1 ? "" : "s"}`;
  const file = (count: number) => `${count} file${count === 1 ? "" : "s"}`;
  let message: string;
  if (ok) {
    message = `Replaced ${occurrence(appliedCount)} in ${file(fileCount)} — Ctrl+Z to undo`;
  } else if (appliedCount === 0) {
    message = `Replace blocked, nothing applied: ${blockers.join("; ")}`;
  } else {
    message = `Replace partially applied: ${appliedCount} of ${matches.length} occurrences in ${fileCount} of ${plannedKeys.length} files; blocked: ${blockers.join("; ")}`;
  }
  return {
    ok,
    appliedCount,
    fileCount,
    plannedCount: matches.length,
    plannedFileCount: plannedKeys.length,
    blockers,
    message,
  };
}
