import {
  type DebugExceptionBreakpointFilter,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointRule,
  type DebugBreakpointMode,
  type ExceptionBreakpointSyncPlan,
  type ExceptionBreakpointFilterOption,
  type ExceptionBreakpointSyncTarget,
  type DebugExceptionBreakMode,
  type ExceptionBreakpointBinding,
  type ExceptionBreakpointBindingBase,
  type BreakpointRuntimeState,
} from "./types";
import { asRecord, bindingRuntimeStatus } from "./shared";
import { resolveBreakpointMode } from "./functionInstructionBreakpoints";

/** Parse and de-duplicate the adapter's exception-filter capability metadata. */
export function parseExceptionBreakpointFilters(
  capabilities: Record<string, unknown>,
): DebugExceptionBreakpointFilter[] {
  const filters = capabilities.exceptionBreakpointFilters;
  if (!Array.isArray(filters)) return [];
  const out: DebugExceptionBreakpointFilter[] = [];
  const seen = new Set<string>();
  for (const value of filters) {
    const filter = asRecord(value);
    const id = typeof filter.filter === "string" ? filter.filter : "";
    if (!id.trim() || seen.has(id)) continue;
    seen.add(id);
    const label = typeof filter.label === "string" && filter.label.trim()
      ? filter.label.trim()
      : id;
    out.push({
      filter: id,
      label,
      description: typeof filter.description === "string" && filter.description.trim()
        ? filter.description.trim()
        : undefined,
      default: filter.default === true,
      supportsCondition: filter.supportsCondition === true,
      conditionDescription: typeof filter.conditionDescription === "string"
        && filter.conditionDescription.trim()
        ? filter.conditionDescription.trim()
        : undefined,
    });
  }
  return out;
}

/** Stable identity for persisted adapter-specific exception settings. */
export function exceptionBreakpointKey(
  breakpoint: Pick<DebugExceptionBreakpoint, "adapterId" | "filterId">,
): string {
  return JSON.stringify([breakpoint.adapterId, breakpoint.filterId]);
}

/** Stable identity for a persisted adapter-specific exception path rule. */
export function exceptionBreakpointRuleKey(
  rule: Pick<DebugExceptionBreakpointRule, "adapterId" | "id">,
): string {
  return JSON.stringify([rule.adapterId, rule.id]);
}

/** Compact path label for the exception-breakpoints view. */
export function exceptionBreakpointRuleLabel(
  rule: Pick<DebugExceptionBreakpointRule, "path">,
): string {
  if (rule.path.length === 0) return "All exceptions";
  return rule.path.map((segment) => {
    const names = segment.names.join(" | ");
    return segment.negate ? `not (${names})` : names;
  }).join(" / ");
}

/**
 * Seed newly advertised filters from the adapter's `default` flag while
 * retaining every explicit user choice (including disabled filters).
 */
export function mergeExceptionBreakpointDefaults(
  list: DebugExceptionBreakpoint[],
  adapterId: string,
  filters: readonly DebugExceptionBreakpointFilter[],
): DebugExceptionBreakpoint[] {
  const known = new Set(list.map(exceptionBreakpointKey));
  const additions = filters.flatMap((filter) => {
    const breakpoint: DebugExceptionBreakpoint = {
      adapterId,
      filterId: filter.filter,
      enabled: filter.default,
    };
    return known.has(exceptionBreakpointKey(breakpoint)) ? [] : [breakpoint];
  });
  return additions.length > 0 ? [...list, ...additions] : list;
}

/** Plan a replacing exception-breakpoint request for one adapter session. */
export function planExceptionBreakpointSync(
  list: DebugExceptionBreakpoint[],
  ruleList: DebugExceptionBreakpointRule[],
  filters: readonly DebugExceptionBreakpointFilter[],
  context: {
    adapterId: string;
    muted?: boolean;
    supportsFilterOptions?: boolean;
    supportsExceptionOptions?: boolean;
    breakpointModes?: readonly DebugBreakpointMode[];
  },
): ExceptionBreakpointSyncPlan {
  const byKey = new Map(list.map((breakpoint) => [exceptionBreakpointKey(breakpoint), breakpoint]));
  const applicable = filters.map((filter) => {
    const fallback: DebugExceptionBreakpoint = {
      adapterId: context.adapterId,
      filterId: filter.filter,
      enabled: filter.default,
    };
    return byKey.get(exceptionBreakpointKey(fallback)) ?? fallback;
  });
  const enabled = context.muted ? [] : applicable.filter((breakpoint) => breakpoint.enabled);
  const metadata = new Map(filters.map((filter) => [filter.filter, filter]));
  const options = context.supportsFilterOptions
    ? enabled.flatMap((breakpoint): ExceptionBreakpointFilterOption[] => {
      const condition = metadata.get(breakpoint.filterId)?.supportsCondition === true
        ? breakpoint.condition?.trim() || undefined
        : undefined;
      const mode = resolveBreakpointMode(
        breakpoint.mode,
        context.breakpointModes ?? [],
        "exception",
      );
      return condition || mode ? [{ breakpoint, condition, mode }] : [];
    })
    : [];
  const optionIds = new Set(options.map((entry) => entry.breakpoint.filterId));
  const plain = enabled.filter((breakpoint) => !optionIds.has(breakpoint.filterId));
  const applicableRules = ruleList.filter((rule) => rule.adapterId === context.adapterId);
  const rules = context.supportsExceptionOptions && !context.muted
    ? applicableRules.filter((rule) => rule.enabled)
    : [];
  const sent: ExceptionBreakpointSyncTarget[] = [
    ...plain.map((breakpoint) => ({ kind: "filter" as const, breakpoint })),
    ...options.map(({ breakpoint }) => ({ kind: "filter" as const, breakpoint })),
    ...rules.map((rule) => ({ kind: "rule" as const, rule })),
  ];
  return { applicable, applicableRules, plain, options, rules, sent };
}

/** Build standard DAP `setExceptionBreakpoints` arguments with legacy fallback. */
export function buildSetExceptionBreakpointsArgs(plan: ExceptionBreakpointSyncPlan) {
  const args: {
    filters: string[];
    filterOptions?: Array<{ filterId: string; condition?: string; mode?: string; }>;
    exceptionOptions?: Array<{
      path?: Array<{ names: string[]; negate?: boolean; }>;
      breakMode: DebugExceptionBreakMode;
    }>;
  } = {
    filters: plan.plain.map((breakpoint) => breakpoint.filterId),
  };
  if (plan.options.length > 0) {
    args.filterOptions = plan.options.map(({ breakpoint, condition, mode }) => ({
      filterId: breakpoint.filterId,
      ...(condition ? { condition } : {}),
      ...(mode ? { mode } : {}),
    }));
  }
  if (plan.rules.length > 0) {
    args.exceptionOptions = plan.rules.map((rule) => ({
      ...(rule.path.length > 0
        ? {
          path: rule.path.map((segment) => ({
            names: [...segment.names],
            ...(segment.negate ? { negate: true } : {}),
          })),
        }
        : {}),
      breakMode: rule.breakMode,
    }));
  }
  return args;
}

/** Parse bindings in `filters`, `filterOptions`, then `exceptionOptions` order. */
export function parseSetExceptionBreakpointsResponse(
  plan: ExceptionBreakpointSyncPlan,
  body: unknown,
): ExceptionBreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((target, index) => {
    const rec = asRecord(list[index]);
    const reason: "pending" | "failed" | null = rec.reason === "pending" || rec.reason === "failed"
      ? rec.reason
      : null;
    const binding: ExceptionBreakpointBindingBase = {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason,
    };
    return target.kind === "filter"
      ? { ...binding, kind: "filter" as const, filterId: target.breakpoint.filterId }
      : { ...binding, kind: "rule" as const, ruleId: target.rule.id };
  });
}

/** Verification state per exception filter for the selected adapter session. */
export function exceptionBreakpointVerificationMap(
  plan: ExceptionBreakpointSyncPlan,
  bindings: ExceptionBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  const filterBindings = bindings.filter((binding) => binding.kind === "filter");
  [...plan.plain, ...plan.options.map((entry) => entry.breakpoint)].forEach((breakpoint, index) => {
    const binding = filterBindings[index];
    out[breakpoint.filterId] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}

/** Verification state per user-defined exception path rule. */
export function exceptionBreakpointRuleVerificationMap(
  plan: ExceptionBreakpointSyncPlan,
  bindings: ExceptionBreakpointBinding[],
): Record<string, BreakpointRuntimeState> {
  const out: Record<string, BreakpointRuntimeState> = {};
  const ruleBindings = bindings.filter((binding) => binding.kind === "rule");
  plan.rules.forEach((rule, index) => {
    const binding = ruleBindings[index];
    out[rule.id] = binding
      ? bindingRuntimeStatus(binding)
      : { status: "pending", message: null };
  });
  return out;
}
