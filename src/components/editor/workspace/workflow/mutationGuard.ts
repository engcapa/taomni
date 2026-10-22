import { sha256Hex } from "../projectAnalysisModel";
import {
  type WorkflowIdentityDeps,
  type FrozenWorkflowIdentity,
  type WorkflowMutationGuard,
  type WorkflowIdentityCheck,
  type RearrangeRequestState,
  type CleanupRequestState,
  type WorkflowExecuteFailureState,
  type RearrangeResolveState,
  type CleanupResolveState,
} from "./types";

export function buildWorkflowMutationGuard(
  deps: WorkflowIdentityDeps,
  frozen: FrozenWorkflowIdentity,
): WorkflowMutationGuard {
  const check = (): WorkflowIdentityCheck => {
    const live = deps.readLive();
    if (!live) {
      return {
        ok: false,
        state: "cancelled",
        reason: `${frozen.targetPath} closed or the workspace changed`,
      };
    }
    if (live.readOnly) {
      return {
        ok: false,
        state: "conflict",
        reason: `${frozen.targetPath} became read-only`,
      };
    }
    if (sha256Hex(live.text) !== frozen.textSha256) {
      return {
        ok: false,
        state: "stale",
        reason: `${frozen.targetPath} changed since the frozen preimage`,
      };
    }
    if (
      frozen.requestToken !== undefined
      && deps.requestToken
      && deps.requestToken() !== frozen.requestToken
    ) {
      return {
        ok: false,
        state: "stale",
        reason: "a newer request superseded this one",
      };
    }
    if (deps.providerGeneration() !== frozen.providerGeneration) {
      return {
        ok: false,
        state: "stale",
        reason: `provider generation changed (${frozen.providerGeneration} -> ${deps.providerGeneration()})`,
      };
    }
    return { ok: true };
  };
  return {
    check,
    assertCurrent() {
      const current = check();
      if (!current.ok) throw new Error(current.reason);
    },
  };
}

export function mapRequestFailureState(
  state: RearrangeRequestState | CleanupRequestState,
): WorkflowExecuteFailureState {
  if (state === "cancelled") return "cancelled";
  if (state === "stale") return "stale";
  return "failed";
}

export function mapResolveFailureState(
  state: RearrangeResolveState | CleanupResolveState,
): WorkflowExecuteFailureState {
  if (state === "unsupported") return "unsupported";
  if (state === "stale") return "stale";
  return "failed";
}
