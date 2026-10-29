import { useMemo } from "react";
import type { ProjectTreeOpenFileHint } from "../projectTreeTypes";

/** The tree consumes dirty badges; editor text and loading are owned elsewhere. */
export function useProjectTreeOpenFileHints(files: Record<string, ProjectTreeOpenFileHint | undefined>) {
  const dirtyKeys = JSON.stringify(Object.keys(files).filter((key) => files[key]?.dirty).sort());
  return useMemo<Record<string, ProjectTreeOpenFileHint>>(() => Object.fromEntries(
    (JSON.parse(dirtyKeys) as string[]).map((key) => [key, { dirty: true }]),
  ), [dirtyKeys]);
}
