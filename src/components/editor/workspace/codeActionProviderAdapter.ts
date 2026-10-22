export {
  type ProviderActionV4,
  type CodeActionProviderResultV4,
  type DocumentIdentity,
  type ProviderIdentity,
  type CodeActionContextIdentity,
  type CodeActionCandidate,
  type ImmutableCodeActionPlan,
  type CodeActionResolveOutcome,
  type CodeActionProviderClient,
  type CodeActionAffectedResource,
  type PlanOnlyCodeActionResult,
  type CodeActionUriHashState,
  type CodeActionPlanPreview,
  type CodeActionApplyOutcome,
  type CodeActionResourceSnapshot,
  type CodeActionTransactionSnapshot,
  type CodeActionWorkspaceEditApplyResult,
  type CodeActionApplyHooks,
} from "./codeActions/types";

export { buildCodeActionParams, buildCodeActionClientCapabilities, toProviderActionsV4, evaluateCodeActionResult } from "./codeActions/provider";

export { DEFAULT_ALLOWED_COMMAND_PREFIXES, isCommandAllowed, computeStableActionId, snapshotCodeActionContext } from "./codeActions/identity";

export { CanonicalCodeActionService } from "./codeActions/service";

export { extractAffectedResourcesFromWorkspaceEdit, extractAffectedUrisFromWorkspaceEdit } from "./codeActions/snapshots";
