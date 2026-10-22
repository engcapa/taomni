import {
  type DebugDataBreakpointTarget,
  type DebugDataBreakpointInfo,
  type DebugDataBreakpointAccessType,
  type DebugDataBreakpoint,
  type DataBreakpointSyncPlan,
  type DataBreakpointBinding,
  type BreakpointRuntimeState,
} from "./types";
import { asRecord, compareText, bindingRuntimeStatus } from "./shared";

/** Build a standard DAP `dataBreakpointInfo` request from a variable/expression. */
export function buildDataBreakpointInfoArgs(target: DebugDataBreakpointTarget) {
  const args: Record<string, unknown> = { name: target.name };
  if (target.asAddress === true) {
    args.asAddress = true;
  } else {
    if (typeof target.variablesReference === "number" && target.variablesReference > 0) {
      args.variablesReference = target.variablesReference;
    } else if (typeof target.frameId === "number") {
      args.frameId = target.frameId;
    }
  }
  if (Number.isInteger(target.bytes) && (target.bytes as number) > 0) {
    args.bytes = target.bytes;
  }
  if (target.mode?.trim()) args.mode = target.mode.trim();
  return args;
}

/** Parse adapter-owned data id and access modes without inventing a fallback id. */
export function parseDataBreakpointInfo(body: unknown): DebugDataBreakpointInfo {
  const rec = asRecord(body);
  const accessTypes: DebugDataBreakpointAccessType[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rec.accessTypes)) {
    for (const value of rec.accessTypes) {
      if (
        (value === "read" || value === "write" || value === "readWrite")
        && !seen.has(value)
      ) {
        seen.add(value);
        accessTypes.push(value);
      }
    }
  }
  return {
    dataId: typeof rec.dataId === "string" && rec.dataId.length > 0 ? rec.dataId : null,
    description: typeof rec.description === "string" ? rec.description : "",
    accessTypes,
    canPersist: rec.canPersist === true,
  };
}

/** IDEA defaults a watchpoint to modification when the adapter offers it. */
export function defaultDataBreakpointAccessType(
  accessTypes: readonly DebugDataBreakpointAccessType[],
): DebugDataBreakpointAccessType | undefined {
  if (accessTypes.includes("write")) return "write";
  return accessTypes[0];
}

/** Stable identity for UI/runtime maps; the opaque data id is never parsed. */
export function dataBreakpointKey(breakpoint: DebugDataBreakpoint): string {
  return JSON.stringify([
    breakpoint.sessionId ? "session" : "adapter",
    breakpoint.sessionId ?? breakpoint.adapterId,
    breakpoint.dataId,
  ]);
}

/** Scope persistent data ids by adapter and transient ids by their owner session. */
export function planDataBreakpointSync(
  list: DebugDataBreakpoint[],
  context: { adapterId: string; sessionId: string; muted?: boolean; },
): DataBreakpointSyncPlan {
  const sorted = list.slice().sort((left, right) => (
    compareText(left.adapterId, right.adapterId)
    || compareText(left.description, right.description)
    || compareText(left.dataId, right.dataId)
  ));
  const applicable = sorted.filter((breakpoint) => (
    breakpoint.sessionId
      ? breakpoint.sessionId === context.sessionId
      : breakpoint.canPersist && breakpoint.adapterId === context.adapterId
  ));
  return {
    sorted,
    applicable,
    sent: context.muted
      ? []
      : applicable.filter((breakpoint) => breakpoint.enabled !== false),
  };
}

/** Build the replacing `setDataBreakpoints` payload required by DAP. */
export function buildSetDataBreakpointsArgs(plan: DataBreakpointSyncPlan) {
  return {
    breakpoints: plan.sent.map((breakpoint) => {
      const entry: Record<string, unknown> = { dataId: breakpoint.dataId };
      if (breakpoint.accessType) entry.accessType = breakpoint.accessType;
      if (breakpoint.condition?.trim()) entry.condition = breakpoint.condition.trim();
      if (breakpoint.hitCondition?.trim()) entry.hitCondition = breakpoint.hitCondition.trim();
      return entry;
    }),
  };
}

/** Parse `setDataBreakpoints`; response order matches the replacing request. */
export function parseSetDataBreakpointsResponse(
  plan: DataBreakpointSyncPlan,
  body: unknown,
): DataBreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((breakpoint, index) => {
    const rec = asRecord(list[index]);
    return {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      key: dataBreakpointKey(breakpoint),
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason: rec.reason === "pending" || rec.reason === "failed" ? rec.reason : null,
    };
  });
}

/** Verification state per data-breakpoint identity for the selected session. */
export function dataBreakpointVerificationMap(
  plan: DataBreakpointSyncPlan,
  bindings: DataBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  plan.sent.forEach((breakpoint, index) => {
    const binding = bindings[index];
    out[dataBreakpointKey(breakpoint)] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}
