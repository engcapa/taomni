export let layoutMonotonicCounter = 0;

/**
 * Generate a workspace-scoped monotonic unique ID for layout leaves and splits.
 */
export function generateLayoutId(prefix: "leaf" | "split", workspaceId?: string): string {
  layoutMonotonicCounter += 1;
  const wsPart = workspaceId ? `${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "")}-` : "";
  return `${prefix}-${wsPart}${Date.now()}-${layoutMonotonicCounter}`;
}
