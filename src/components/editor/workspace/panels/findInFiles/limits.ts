import { type WorkspaceProjectFactsEntry } from "../../../../../stores/projectFactsStore";

export const EMPTY_FACTS_MODULES: NonNullable<WorkspaceProjectFactsEntry["structure"]>["modules"] = [];

/**
 * Rendering every match as a DOM row (no virtualization yet), so keep the
 * default total well below the backend's 10k ceiling.
 */
export const MAX_TOTAL_MATCHES = 2_000;

/** Default visible matches per file; extra rows need explicit expand. */
export const DEFAULT_MATCHES_PER_FILE = 10;

/** How many more rows "Show more" reveals each click. */
export const MATCHES_PER_FILE_STEP = 20;

export function splitGlobs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
