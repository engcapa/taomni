import { type Completion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { LspCompletionItem, LspCompletionResolveResult, LspCompletionResult, LspPosition, LspTextEdit } from "../../../../lib/editor/lsp";
import { type CompletionScopeFactsState } from "../completionScopeAdapter";
import { type BasicCompletionPolicyV2, type WorkspaceCompletionPreferences } from "../intelligencePreferences";
import { LspCompletionController } from "./policyController";
import { parseLspSnippet } from "./snippets";


/**
 * Mandatory request identity for every production completion request
 * (§8.16.2). All fields are required: a request that cannot prove who it
 * belongs to must be treated as unavailable, never guessed.
 */
export interface CompletionRequestToken {
  workspaceId: string;
  fileKey: string;
  filePath: string;
  uri: string;
  languageId: string;
  documentRevision: number;
  lspSessionGeneration: number;
  requestId: string;
  /**
   * ED-COMP-004: the effective project scope recorded for this request.
   * Resolved from the ready same-workspace facts snapshot at request build;
   * a scope-facts-missing state (with its reason and generation) is recorded
   * explicitly instead of guessing module/project scope. Absent only on
   * document-scope requests that never consult facts.
   */
  projectScope?: CompletionScopeFactsState;
}


/** Live identity captured at request start; requestId is minted per request. */
export type CompletionRequestIdentity = Omit<CompletionRequestToken, "requestId">;


export type CompletionAcceptIntent = "insert" | "replace";


export type CompletionAcceptanceDiagnostic =
  | "truncated"
  | "invalid-additional-edits"
  | "additional-edit-unavailable"
  | "identity-mismatch"
  | "excluded-symbol-blocked"
  | "auto-inserted-single";


export interface LspCompletionHooks {
  /** Live file/session identity; null means "no provable identity". */
  identity: () => CompletionRequestIdentity | null;
  fetch: (
    position: LspPosition,
    triggerCharacter: string | null,
    token: CompletionRequestToken,
    /** Repeated-call facts (§8.19.4); ordinal ≥ 2 requests expanded scope. */
    invocation?: CompletionInvocationRequest,
  ) => Promise<LspCompletionResult | null>;
  resolve?: (raw: unknown, token: CompletionRequestToken) => Promise<LspCompletionResolveResult | LspCompletionItem | null>;
  triggerCharacters: () => string[];
  getDocumentRevision: () => number;
  /**
   * Whether the provider advertises a scope-expansion channel for repeated
   * Basic calls. Standard LSP has none, so hosts omit this and every
   * expanded request is recorded honestly as providerScope:"unchanged".
   */
  advertisesScopeExpansion?: () => boolean;
  /** Observable acceptance diagnostics for status/QA surfaces. */
  reportDiagnostic: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
  /**
   * ED-COMP-004: fired when an explicitly invoked completion resolves to
   * scope-facts-missing, so the UI can name the missing prerequisite once
   * instead of silently completing document-scoped. Typing/trigger popups
   * never fire this: only deliberate invocations explain scope fallback.
   */
  onScopeFallback?: (state: CompletionScopeFactsState, reason: CompletionInvocationReason) => void;
  /**
   * ED-PARITY-020 DEC-ALIGN-09: the provider is unavailable at a member
   * access (`obj.`). Buffer words would masquerade as members there, so the
   * source returns nothing and names the unavailable service through this hook.
   */
  onProviderUnavailable?: (info: { explicit: boolean; }) => void;
  /**
   * Resolve gate surface (§8.19.4). When wired, a resolve timeout/failure
   * presents Retry / Insert-without-import instead of inserting anything.
   * Hosts without a gate surface get the block-only behaviour: nothing is
   * inserted and the diagnostic reports the unavailable import.
   */
  onResolveGate?: (request: CompletionResolveGateRequest) => void;
  onAcceptancePending?: (cancel: () => void) => void;
  onAcceptanceSettled?: (cancel: () => void) => void;
  controller?: LspCompletionController;
  getView?: () => EditorView | null;
  consumeTriggerOrigin?: (pos: number, docLength: number) => string | null;
}


/**
 * Test-fixture source contract: no identity proof, no session generation.
 * Production code must use `createLspCompletionSource`; tests that exercise
 * mapping logic use this entry so optionality never leaks into production.
 */
export interface FixtureCompletionHooks {
  fetch: (position: LspPosition, triggerCharacter: string | null)
    => Promise<LspCompletionResult | null>;
  resolve?: (raw: unknown) => Promise<LspCompletionItem | null>;
  triggerCharacters?: () => string[];
  getDocumentRevision?: () => number;
  reportDiagnostic?: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
  /**
   * ED-COMP-004: effective project scope attached to the synthetic identity
   * (ready scope or explicit scope-facts-missing). Absent means document
   * scope without facts consultation.
   */
  projectScope?: CompletionScopeFactsState;
  onScopeFallback?: (state: CompletionScopeFactsState, reason: CompletionInvocationReason) => void;
  onProviderUnavailable?: (info: { explicit: boolean; }) => void;
}


/**
 * Request-phase telemetry (§8.17.2 step 5). Only provider identity metadata,
 * phase transitions, latency, counts and truncation are recorded — never
 * source text, labels or import content. The bounded ring is readable by QA
 * surfaces and unit tests without any UI wiring.
 */
export type CompletionRequestPhase =
  | "fetching"
  | "popup"
  | "unavailable"
  | "stale"
  | "failed"
  | "applied";


export interface CompletionRequestTelemetryEvent {
  requestId: string;
  languageId: string;
  phase: CompletionRequestPhase;
  /** Milliseconds since the request token was minted. */
  durationMs: number;
  itemCount: number;
  truncated: boolean;
  reason?: string;
}


// ---------------------------------------------------------------------------
// §8.19.4 Basic invocation modes + repeated-invocation evidence
// ---------------------------------------------------------------------------

export type CompletionInvocationReason = "typing" | "trigger" | "explicit";


/**
 * Per-invocation facts the provider adapter receives and QA surfaces read
 * (§8.19.4). `requestedScope:"expanded"` marks a repeated explicit Basic call;
 * `providerScope` records what the provider actually did — LSP has no standard
 * expansion channel, so an unadvertised expansion stays honestly "unchanged"
 * instead of inheriting the requested scope.
 */
export interface CompletionInvocationEvidence {
  invocationOrdinal: number;
  requestedScope: "default" | "expanded";
  providerScope: "expanded" | "unchanged" | "unknown";
  itemCount: number;
  isIncomplete: boolean;
}


/** Facts handed to the fetch hook so they can travel to the backend. */
export interface CompletionInvocationRequest {
  invocationOrdinal: number;
  requestedScope: "default" | "expanded";
}


/** One recorded invocation in the bounded evidence ring. */
export interface RecordedCompletionInvocation extends CompletionInvocationEvidence {
  requestId: string;
  workspaceId: string;
  fileKey: string;
  languageId: string;
  documentRevision: number;
  providerGeneration: number;
  reason: CompletionInvocationReason;
  at: number;
  /**
   * ED-COMP-004: the effective project scope recorded for this request
   * (ready scope or explicit scope-facts-missing). Null when the request
   * never consulted facts (document scope).
   */
  projectScope?: CompletionScopeFactsState | null;
}


export interface LastBasicInvocation {
  revision: number;
  positionKey: string;
  providerGeneration: number;
  ordinal: number;
}


// ---------------------------------------------------------------------------
// §8.19.4 typed resolve state + acceptance plan (R3)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one item's completionItem/resolve round-trip (§8.19.4).
 * `timed-out` / `failed` never fall through to a silent primary-only insert:
 * they surface the resolve gate and wait for an explicit user choice.
 */
/**
 * Lifecycle of one item's completionItem/resolve round-trip (§8.19.4 / §ED-COMP-001).
 * `timed-out` / `failed` / `unavailable` never fall through to a silent primary-only insert:
 * they surface the resolve gate and wait for an explicit user choice.
 */
export type CompletionResolveState =
  | { kind: "not-required"; }
  | { kind: "ready"; resolvedAt: number; hasAdditionalEdits: boolean; }
  | { kind: "timed-out"; canRetry: true; }
  | { kind: "failed"; canRetry: true; message: string; }
  | { kind: "unavailable"; canRetry: boolean; reason: string; }
  | { kind: "cancelled"; reason: string; }
  | { kind: "stale"; };


/**
 * 7 typed completion resolve outcome kinds (§ED-COMP-001 / BB7):
 * - resolved: provider delivered full item + additionalTextEdits
 * - not-required: item already contained complete additional edits without resolve
 * - unavailable: resolver is missing / returned null (resolver 缺失不推导 not-required)
 * - timeout: resolve timed out
 * - failed: resolver threw an error
 * - cancelled: resolve was aborted / cancelled
 * - stale: request token identity or doc revision changed during resolve
 */
export type CompletionResolveOutcomeKind =
  | "resolved"
  | "not-required"
  | "unavailable"
  | "timeout"
  | "failed"
  | "cancelled"
  | "stale";


export type CompletionResolveOutcome =
  | { kind: "resolved"; item: LspCompletionItem; edits: readonly LspTextEdit[]; }
  | { kind: "not-required"; item: LspCompletionItem; }
  | { kind: "unavailable"; reason: string; item: LspCompletionItem; }
  | { kind: "timeout"; durationMs: number; item: LspCompletionItem; }
  | { kind: "failed"; error: string; item: LspCompletionItem; }
  | { kind: "cancelled"; reason: string; item: LspCompletionItem; }
  | { kind: "stale"; expectedRevision: number; currentRevision: number; item: LspCompletionItem; };


export interface ClassifyCompletionResolveInput {
  item: LspCompletionItem;
  resolvedItem?: LspCompletionItem | null;
  error?: unknown;
  timedOut?: boolean;
  cancelled?: boolean;
  hasResolver: boolean;
  isStale?: boolean;
  tokenRevision?: number;
  currentRevision?: number;
}


export interface ExecuteCompletionResolveOptions {
  item: LspCompletionItem;
  resolve?: (raw: unknown) => Promise<LspCompletionResolveResult | LspCompletionItem | null>;
  token: CompletionRequestToken;
  isStillCurrent: (token: CompletionRequestToken) => boolean;
  timeoutMs?: number;
  getDocumentRevision?: () => number;
  signal?: AbortSignal;
}


export interface CompletionAcceptancePlanV2 {
  identity: CompletionRequestIdentity;
  itemId: string;
  primary: LspTextEdit;
  additional: readonly LspTextEdit[];
  /** Parsed placeholder spans when the primary is a snippet; null otherwise. */
  snippet: ReturnType<typeof parseLspSnippet>["placeholders"] | null;
  resolve: CompletionResolveState;
  disposition:
  | "ready"
  | "needs-explicit-primary-only"
  | "blocked-stale"
  | "blocked-overlap";
}


/** Why the resolve gate opened; all mean the import edits are unavailable. */
export type CompletionResolveGateReason = "timeout" | "failed" | "unavailable";


/**
 * Handed to the host UI when an acceptance needs its import/additional edits
 * but the provider resolve did not deliver them in time (§8.19.4). The gate
 * keeps the item visible with Retry / Insert-without-import choices; nothing
 * is inserted until the user picks one.
 */
export interface CompletionResolveGateRequest {
  item: LspCompletionItem;
  range: { from: number; to: number; };
  reason: CompletionResolveGateReason;
  message: string;
  /**
   * Fresh resolve attempt (bypasses the info-panel cache). Resolves to
   * `"committed"` when the merged acceptance landed in one dispatch, or
   * `"unavailable"` when the retry also failed to produce usable import
   * edits — the gate stays open in that case.
   */
  retry(): Promise<"committed" | "unavailable">;
  /** User chose primary-only insertion: one dispatch, no import edits. */
  insertWithoutImport(): boolean;
  /** Close the banner without inserting anything. */
  dismiss(): void;
}


// ---------------------------------------------------------------------------
// §8.18.3 typed provider result envelope + capability evidence
// ---------------------------------------------------------------------------
export type CapabilityLevel = "unavailable" | "available-partial" | "available-complete";

export type CompletionUnavailableReason =
  | "no-provider" | "capability-not-advertised" | "provider-starting"
  | "indexing" | "unsupported-language" | "stale" | "cancelled" | "disposed" | "unknown";


export interface CompletionCapabilityEvidence {
  source: "lsp" | "jdtls";
  providerId: string | null;
  providerVersion: string | null;
  workspaceId: string;
  fileKey: string;
  documentRevision: number;
  providerGeneration: number;
  scope: "file";
  completeness: CapabilityLevel;
  unavailableReason?: CompletionUnavailableReason;
}


export type CompletionProviderResult =
  | {
    kind: "available"; identity: CompletionRequestIdentity; items: LspCompletionItem[];
    isIncomplete: boolean; truncated: boolean; evidence: CompletionCapabilityEvidence
   }
  | { kind: "unavailable"; identity: CompletionRequestIdentity; reason: CompletionUnavailableReason; }
  | { kind: "stale" | "cancelled"; identity: CompletionRequestIdentity; }
  | { kind: "failed"; identity: CompletionRequestIdentity; retryable: boolean; message: string; };


export interface CompletionPolicySnapshot {
  revision: number;
  policy: BasicCompletionPolicyV2;
  preferences: WorkspaceCompletionPreferences;
  provenance: Record<string, string>;
}


export type CompletionMatchTier =
  | 1 // Exact match
  | 2 // Prefix match
  | 3 // Word boundary / camelCase match
  | 4 // Subsequence / fuzzy match
  | 5;


export interface CompletionCandidateIdentity {
  candidateId: string;
  rawResponseIndex: number;
  workspaceId: string;
  fileKey: string;
  documentRevision: number;
  lspSessionGeneration: number;
  policyRevision: number;
}


export interface CompletionCandidatePair {
  identity: CompletionCandidateIdentity;
  rawItem: LspCompletionItem;
  completion: Completion;
  matchTier: CompletionMatchTier;
  matchScore: number;
}


/** One committed placeholder span; `choices` present for ${n|a,b,c|} stops. */
export interface ParsedSnippetPlaceholder {
  start: number;
  end: number;
  /** Keyboard-cyclable options (§8.18.3 choice session); first is the default. */
  choices?: readonly string[];
}


/**
 * Post-acceptance tabstop session for the combined snippet+additional-edits
 * acceptance (§8.17.2 step 2). The document lands in ONE dispatch (one undo,
 * one revision bump); this store only moves the selection between the
 * committed placeholder spans, which never creates history entries.
 */
export interface LspSnippetSessionState {
  /** Post-image placeholder spans in document order. */
  spans: Array<{ from: number; to: number; }>;
  /** Parallel option lists for choice placeholders (null = plain stop). */
  choices: Array<readonly string[] | null>;
  index: number;
  /** Doc length at commit; any foreign edit invalidates the session. */
  docLength: number;
}


export interface PlannedChange {
  from: number;
  to: number;
  insert: string;
}


export interface PlanningChanges {
  list: PlannedChange[];
  ok: boolean;
}


export type CompletionItemResolver = () => Promise<LspCompletionResolveResult | LspCompletionItem | null>;
