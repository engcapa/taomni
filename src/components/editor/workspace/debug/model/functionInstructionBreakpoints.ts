import {
  type DebugFunctionBreakpoint,
  type FunctionBreakpointSyncPlan,
  type DebugInstructionBreakpoint,
  type InstructionBreakpointSyncPlan,
  type DebugBreakpointMode,
  type DebugBreakpointModeApplicability,
  type FunctionBreakpointBinding,
  type InstructionBreakpointBinding,
  type BreakpointRuntimeState,
} from "./types";
import { compareText, asRecord, bindingRuntimeStatus } from "./shared";

/** Decide which function breakpoints are armed for one adapter session. */
export function planFunctionBreakpointSync(
  list: DebugFunctionBreakpoint[],
  options: { muted?: boolean; } = {},
): FunctionBreakpointSyncPlan {
  const sorted = list.slice().sort((left, right) => compareText(left.name, right.name));
  return {
    sorted,
    sent: options.muted ? [] : sorted.filter((breakpoint) => breakpoint.enabled !== false),
  };
}

/** Build standard DAP `setFunctionBreakpoints` request arguments. */
export function buildSetFunctionBreakpointsArgs(plan: FunctionBreakpointSyncPlan) {
  return {
    breakpoints: plan.sent.map((breakpoint) => {
      const entry: Record<string, unknown> = { name: breakpoint.name };
      if (breakpoint.condition?.trim()) entry.condition = breakpoint.condition.trim();
      if (breakpoint.hitCondition?.trim()) entry.hitCondition = breakpoint.hitCondition.trim();
      return entry;
    }),
  };
}

/** Stable identity for one adapter-owned instruction location. */
export function instructionBreakpointKey(
  breakpoint: Pick<DebugInstructionBreakpoint, "adapterId" | "instructionReference" | "offset">,
): string {
  return JSON.stringify([
    breakpoint.adapterId,
    breakpoint.instructionReference,
    breakpoint.offset ?? 0,
  ]);
}

/** Scope instruction references to their adapter and apply global muting. */
export function planInstructionBreakpointSync(
  list: DebugInstructionBreakpoint[],
  context: { adapterId: string; muted?: boolean; },
): InstructionBreakpointSyncPlan {
  const sorted = list.slice().sort((left, right) => (
    compareText(left.adapterId, right.adapterId)
    || compareText(left.instructionReference, right.instructionReference)
    || (left.offset ?? 0) - (right.offset ?? 0)
  ));
  const applicable = sorted.filter((breakpoint) => breakpoint.adapterId === context.adapterId);
  return {
    sorted,
    applicable,
    sent: context.muted
      ? []
      : applicable.filter((breakpoint) => breakpoint.enabled !== false),
  };
}

/** Build the replacing DAP `setInstructionBreakpoints` request. */
export function buildSetInstructionBreakpointsArgs(
  plan: InstructionBreakpointSyncPlan,
  breakpointModes: readonly DebugBreakpointMode[] = [],
) {
  return {
    breakpoints: plan.sent.map((breakpoint) => {
      const entry: Record<string, unknown> = {
        instructionReference: breakpoint.instructionReference,
      };
      if (breakpoint.offset !== undefined) entry.offset = breakpoint.offset;
      if (breakpoint.condition?.trim()) entry.condition = breakpoint.condition.trim();
      if (breakpoint.hitCondition?.trim()) entry.hitCondition = breakpoint.hitCondition.trim();
      const mode = resolveBreakpointMode(breakpoint.mode, breakpointModes, "instruction");
      if (mode) entry.mode = mode;
      return entry;
    }),
  };
}

/** Parse, de-duplicate, and merge DAP breakpoint-mode capability metadata. */
export function parseBreakpointModes(
  capabilities: Record<string, unknown>,
): DebugBreakpointMode[] {
  const advertised = capabilities.breakpointModes;
  if (!Array.isArray(advertised)) return [];
  const out: DebugBreakpointMode[] = [];
  const byId = new Map<string, DebugBreakpointMode>();
  for (const value of advertised) {
    const raw = asRecord(value);
    const mode = typeof raw.mode === "string" ? raw.mode.trim() : "";
    if (!mode || mode.length > 1024 || !Array.isArray(raw.appliesTo)) continue;
    const appliesTo = Array.from(new Set(raw.appliesTo.flatMap((entry) => (
      typeof entry === "string" && entry.trim() && entry.length <= 128
        ? [entry.trim() as DebugBreakpointModeApplicability]
        : []
    ))));
    if (appliesTo.length === 0) continue;
    const existing = byId.get(mode);
    if (existing) {
      existing.appliesTo = Array.from(new Set([...existing.appliesTo, ...appliesTo]));
      continue;
    }
    const label = typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim().slice(0, 1024)
      : mode;
    const parsed: DebugBreakpointMode = {
      mode,
      label,
      description: typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim().slice(0, 4096)
        : undefined,
      appliesTo,
    };
    byId.set(mode, parsed);
    out.push(parsed);
  }
  return out;
}

/** Modes in adapter order; the first is the protocol-recommended UI default. */
export function breakpointModesFor(
  modes: readonly DebugBreakpointMode[],
  applicability: DebugBreakpointModeApplicability,
): DebugBreakpointMode[] {
  return modes.filter((mode) => mode.appliesTo.includes(applicability));
}

/** Keep a valid saved mode, otherwise use the first applicable advertised mode. */
export function resolveBreakpointMode(
  preferred: string | undefined,
  modes: readonly DebugBreakpointMode[],
  applicability: DebugBreakpointModeApplicability,
): string | undefined {
  const applicable = breakpointModesFor(modes, applicability);
  return applicable.some((candidate) => candidate.mode === preferred)
    ? preferred
    : applicable[0]?.mode;
}

/** Parse the positional response to `setFunctionBreakpoints`. */
export function parseSetFunctionBreakpointsResponse(
  plan: FunctionBreakpointSyncPlan,
  body: unknown,
): FunctionBreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((breakpoint, index) => {
    const rec = asRecord(list[index]);
    return {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      name: breakpoint.name,
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason: rec.reason === "pending" || rec.reason === "failed" ? rec.reason : null,
    };
  });
}

/** Parse `setInstructionBreakpoints`; response order matches the request. */
export function parseSetInstructionBreakpointsResponse(
  plan: InstructionBreakpointSyncPlan,
  body: unknown,
): InstructionBreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((breakpoint, index) => {
    const rec = asRecord(list[index]);
    return {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      key: instructionBreakpointKey(breakpoint),
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason: rec.reason === "pending" || rec.reason === "failed" ? rec.reason : null,
    };
  });
}

/** Verification state per persisted function name for the active session. */
export function functionBreakpointVerificationMap(
  plan: FunctionBreakpointSyncPlan,
  bindings: FunctionBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  plan.sent.forEach((breakpoint, index) => {
    const binding = bindings[index];
    out[breakpoint.name] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}

/** Verification state per adapter-scoped instruction location. */
export function instructionBreakpointVerificationMap(
  plan: InstructionBreakpointSyncPlan,
  bindings: InstructionBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  plan.sent.forEach((breakpoint, index) => {
    const binding = bindings[index];
    out[instructionBreakpointKey(breakpoint)] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}
