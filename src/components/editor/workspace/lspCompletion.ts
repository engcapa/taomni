declare module "@codemirror/autocomplete" {
  interface Completion {
    /** LSP CompletionItemKind preserved from provider response */
    rawKind?: number | null;
    /** Explicit template / snippet source origin */
    isTemplateSnippet?: boolean;
  }
}

export {
  type CompletionRequestToken,
  type CompletionRequestIdentity,
  type CompletionAcceptIntent,
  type CompletionAcceptanceDiagnostic,
  type LspCompletionHooks,
  type FixtureCompletionHooks,
  type CompletionRequestPhase,
  type CompletionRequestTelemetryEvent,
  type CompletionInvocationReason,
  type CompletionInvocationEvidence,
  type CompletionInvocationRequest,
  type RecordedCompletionInvocation,
  type CompletionResolveState,
  type CompletionResolveOutcomeKind,
  type CompletionResolveOutcome,
  type ClassifyCompletionResolveInput,
  type ExecuteCompletionResolveOptions,
  type CompletionAcceptancePlanV2,
  type CompletionResolveGateReason,
  type CompletionResolveGateRequest,
  type CapabilityLevel,
  type CompletionUnavailableReason,
  type CompletionCapabilityEvidence,
  type CompletionProviderResult,
  type CompletionPolicySnapshot,
  type CompletionMatchTier,
  type CompletionCandidateIdentity,
  type CompletionCandidatePair,
  type ParsedSnippetPlaceholder,
  type PlannedChange,
  type PlanningChanges,
} from "./completion/types";

export {
  recentCompletionTelemetry,
  resetCompletionTelemetry,
} from "./completion/telemetry";

export {
  recordBasicCompletionInvocation,
  resetBasicCompletionSession,
  providerScopeFor,
  recentCompletionInvocations,
} from "./completion/invocation";

export {
  classifyCompletionResolveOutcome,
  executeCompletionResolve,
  completionItemId,
  buildCompletionAcceptancePlanV2,
} from "./completion/resolve";

export {
  toCompletionProviderResult,
} from "./completion/capabilities";

export {
  completionKindToType,
  boostFromSortText,
  DEFAULT_COMPLETION_TRIGGERS,
  MAX_COMPLETION_OPTIONS,
  matchCompletionQuery,
  compareCandidatePairs,
  compareCompletionCandidates,
  symbolIdentityFromItem,
  matchesSymbolPattern,
  matchesCaseRule,
  mergeCompletionTriggers,
  boostFromTypedPrefix,
} from "./completion/ranking";

export {
  LspCompletionController,
  WorkspaceCompletionPolicyController,
} from "./completion/policyController";

export {
  parseLspSnippet,
  activeLspSnippetSession,
  activeLspSnippetChoices,
  cycleLspSnippetChoice,
  advanceLspSnippetTabstop,
  cancelLspSnippetSession,
  retreatLspSnippetTabstop,
  seedLspSnippetSessionForTest,
  lspSnippetSessionInvalidator,
} from "./completion/snippets";

export {
  postImageAnchor,
  planCompletionChanges,
  commitLspCompletion,
} from "./completion/acceptance";

export {
  withCompletionAcceptIntent,
} from "./completion/acceptIntent";

export {
  createLspCompletionSource,
  createFixtureCompletionSource,
} from "./completion/sources";
