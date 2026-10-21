import type { LspCodeAction, LspDiagnostic, LspRange, LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type CapabilityEvidenceV3 } from "../capabilityEvidence";
import type { WorkspaceEditApplyOutcome } from "../workspaceEditApply";
import { buildCodeActionParams } from "./provider";

/**
 * §8.21.4 V3: Typed provider action contract with capability evidence and
 * disabled reason.
 */
export interface ProviderActionV4 {
  action: LspCodeAction;
  evidence: CapabilityEvidenceV3;
  disabledReason: string | null;
}

/**
 * §8.21.4 V3 CodeActionProviderResultV4 union.
 * Provider responses are strictly categorized: ready actions, null/empty,
 * malformed, version-level unsupported, timeout, caller cancellation, or
 * failure without faking completion.
 */
export type CodeActionProviderResultV4 =
  | {
    state: "ready";
    actions: readonly ProviderActionV4[];
    evidence: CapabilityEvidenceV3;
    discardedMalformedCount: number;
  }
  | { state: "empty"; reason: "null-response"; evidence: CapabilityEvidenceV3; }
  | {
    state: "malformed";
    message: string;
    malformedCount: number;
    providerStillHealthy: boolean;
    evidence: CapabilityEvidenceV3;
  }
  | { state: "unsupported"; reason: string; evidence: CapabilityEvidenceV3; }
  | { state: "timeout"; requestId: string; cancelled: boolean; providerStillHealthy: boolean; retryAfter: "manual" | "restart"; }
  | {
    state: "cancelled";
    requestId: string;
    reason: "aborted";
    providerStillHealthy: boolean;
    /**
     * ED-PARITY-007 DEC-05: the raw provider message when the language server
     * itself cancelled the request (for example "…cancelled: document
     * changed"), so callers can report the real cause instead of a generic
     * "no actions provided". Absent for caller-side aborts.
     */
    detail?: string;
  }
  | { state: "failed"; message: string; providerStillHealthy: boolean; };

export interface DocumentIdentity {
  uri: string;
  revision: number;
  languageId: string;
}

export interface ProviderIdentity {
  id: string;
  version?: string | null;
  generation: number;
  projectFingerprint: string;
  trusted?: boolean;
}

export interface CodeActionContextIdentity {
  document: DocumentIdentity;
  provider: ProviderIdentity;
  range: LspRange;
  diagnostics: readonly LspDiagnostic[];
  only?: readonly string[];
}

export interface CodeActionCandidate {
  id: string;
  title: string;
  kind: string;
  isPreferred?: boolean;
  preferred?: boolean;
  disabledReason: string | null;
  resolveRequired: boolean;
  rawAction: LspCodeAction;
  evidence?: CapabilityEvidenceV3 | null;
}

export interface ImmutableCodeActionPlan {
  actionId: string;
  title: string;
  kind: string;
  document: DocumentIdentity;
  provider: ProviderIdentity;
  edit: LspWorkspaceEdit | null;
  command: { command: string; arguments?: unknown[]; } | null;
  evidence: CapabilityEvidenceV3 | null;
  createdAt: number;
}

export type CodeActionResolveOutcome =
  | { state: "resolved"; plan: ImmutableCodeActionPlan; }
  | { state: "unresolved"; reason: string; retryable: boolean; }
  | { state: "stale"; reason: string; }
  | { state: "rejected"; reason: "untrusted" | "language-mismatch" | "command-disallowed" | "malformed"; };

export interface CodeActionProviderClient {
  requestCodeActions: (
    params: ReturnType<typeof buildCodeActionParams>,
    signal?: AbortSignal,
  ) => Promise<readonly LspCodeAction[] | null>;
  resolveCodeAction?: (action: LspCodeAction, signal?: AbortSignal) => Promise<LspCodeAction | null>;
  checkCapability?: () => { supported: boolean; reason?: string; };
}

export interface CodeActionAffectedResource {
  uri: string;
  path: string | null;
}

export interface PlanOnlyCodeActionResult {
  plan: ImmutableCodeActionPlan | null;
  requestState: CodeActionProviderResultV4["state"];
  outcome: CodeActionResolveOutcome;
  effectCounters: {
    liveEdits: 0;
    diskWrites: 0;
    historyEntries: 0;
    commands: 0;
  };
}

export interface CodeActionUriHashState {
  uri: string;
  preHash: string;
  postHash: string;
  undoHash: string;
}

export interface CodeActionPlanPreview {
  plan: ImmutableCodeActionPlan;
  affectedUris: readonly string[];
  requiresConfirmation: boolean;
  preHashes: Readonly<Record<string, string>>;
}

export type CodeActionApplyOutcome =
  | {
    status: "applied";
    plan: ImmutableCodeActionPlan;
    historyId: string | null;
    recoveryId: string | null;
    affectedUris: readonly string[];
    uriHashes: Readonly<Record<string, CodeActionUriHashState>>;
    outcomes: readonly WorkspaceEditApplyOutcome[];
    durationMs: number;
  }
  | {
    status: "stale" | "conflict";
    reason: string;
    affectedUris: readonly string[];
  }
  | {
    status: "cancelled";
    reason: string;
  }
  | {
    status: "failed";
    error: string;
    affectedUris: readonly string[];
    outcomes?: readonly WorkspaceEditApplyOutcome[];
    recoveryId?: string;
    recoveryState?: "performed" | "registered" | "unavailable";
  };

export interface CodeActionResourceSnapshot {
  uri: string;
  path: string;
  exists: boolean;
  text: string | null;
  encoding?: string;
  bom?: boolean;
  eol?: "lf" | "crlf" | "cr";
}

export interface CodeActionTransactionSnapshot {
  resources: readonly CodeActionResourceSnapshot[];
}

export interface CodeActionWorkspaceEditApplyResult {
  outcomes: readonly WorkspaceEditApplyOutcome[];
  appliedEdit: LspWorkspaceEdit;
}

export interface CodeActionApplyHooks {
  getLiveDocumentText: (uri: string) => string | null;
  getLiveDocumentRevision: (uri: string) => number | null;
  verifyIdentity?: () =>
    | { valid: true; }
    | { valid: false; status: "stale" | "conflict"; reason: string; };
  captureSnapshot?: (edit: LspWorkspaceEdit) => Promise<CodeActionTransactionSnapshot | null>;
  restoreSnapshot?: (snapshot: CodeActionTransactionSnapshot) => Promise<void>;
  applyWorkspaceEdit: (
    edit: LspWorkspaceEdit,
    options?: {
      historyId?: string;
      recoveryId?: string;
      onBeforeCommit?: () => Promise<void> | void;
    },
  ) => Promise<WorkspaceEditApplyOutcome[] | CodeActionWorkspaceEditApplyResult>;
  executeCommand?: (command: string, args?: unknown[]) => Promise<unknown>;
  registerHistoryEntry?: (entry: {
    id: string;
    label: string;
    affectedUris: string[];
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  }) => void;
  registerRecoveryEntry?: (entry: {
    id: string;
    label: string;
    affectedUris: string[];
    recover: () => Promise<void>;
  }) => void;
}
