import { type ActionDisabledReason, type ActionState, type WorkspaceActionContext, type WorkspaceFocus } from "../types";

export function defaultDisabledReason(context: WorkspaceActionContext): ActionDisabledReason {
  if (context.readOnly) return "readOnly";
  if (!context.hasActiveFile && context.focus === "editor") return "noEditor";
  if (!context.hasSelection && context.focus === "editor") return "noSelection";
  return "capability";
}

export function unsupportedState(): ActionState {
  return {
    availability: "unsupported",
    disabledReason: "unsupported",
    source: "unsupported",
    scope: "workspace",
    freshness: "unknown",
    completeness: "unavailable",
  };
}

export function freezeContext(context: WorkspaceActionContext): Readonly<WorkspaceActionContext> {
  const activeCapabilities = context.activeCapabilities
    ? Object.freeze({ ...context.activeCapabilities })
    : context.activeCapabilities;
  return Object.freeze({ ...context, activeCapabilities });
}

export function focusByPriority(
  context: Partial<WorkspaceActionContext>,
  candidate: WorkspaceFocus,
): WorkspaceFocus {
  if (context.modalOpen || candidate === "modal") return "modal";
  if (context.completionActive || candidate === "completion") return "completion";
  if (context.snippetActive || candidate === "snippet") return "snippet";
  return candidate;
}

export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown; }).then === "function";
}
