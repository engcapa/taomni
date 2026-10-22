import { type BreakpointBinding, type BreakpointRuntimeState } from "./types";

/** Map a raw binding's `verified`/`reason` to a display runtime status. */
export function bindingRuntimeStatus(
  binding: Pick<BreakpointBinding, "verified" | "message" | "reason">,
): BreakpointRuntimeState {
  if (binding.verified) return { status: "verified", message: null };
  // Unverified: `failed` means the adapter gave up; anything else (incl. an
  // explicit `pending`, or no reason yet) is treated as pending so the gutter
  // shows "not bound yet" rather than a hard failure.
  const status = binding.reason === "failed" ? "failed" : "pending";
  return { status, message: binding.message ?? null };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
