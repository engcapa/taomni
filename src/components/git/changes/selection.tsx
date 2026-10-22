import { useRef } from "react";
import { type GitChange, type GitSnapshot } from "../../../lib/git";
import type { GitWorkspaceRootInfo } from "../../../types";
import { type TriState } from "./model";

export function TriCheckbox({
  state,
  disabled,
  ariaLabel,
  onChange,
}: {
  state: TriState;
  disabled?: boolean;
  ariaLabel?: string;
  onChange: (value: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <input
      ref={(el) => {
        ref.current = el;
        if (el) el.indeterminate = state === "some";
      }}
      type="checkbox"
      className="shrink-0 accent-[var(--taomni-accent)]"
      checked={state === "all"}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

export function checkState(checkedCount: number, totalCount: number): TriState {
  if (totalCount === 0 || checkedCount === 0) return "none";
  if (checkedCount === totalCount) return "all";
  return "some";
}

export function toggleSetValue<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function pathsByRepoFromGroups(
  groups: Array<{
    root: GitWorkspaceRootInfo;
    visibleChanges: GitSnapshot["changes"];
  }>,
  predicate: (change: GitChange) => boolean = () => true,
): Record<string, string[]> {
  const byRepo: Record<string, string[]> = {};
  for (const group of groups) {
    const paths = group.visibleChanges.filter(predicate).map((change) => change.path);
    if (paths.length > 0) byRepo[group.root.repoRoot] = paths;
  }
  return byRepo;
}
