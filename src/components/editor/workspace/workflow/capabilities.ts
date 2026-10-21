import type { LspCapabilitySummary, LspDocumentStatus } from "../../../../lib/editor/lsp";
import {
  type RearrangeCapabilities,
  type RearrangeInput,
  type RearrangeDecision,
  type CleanupCapabilities,
  type CleanupInput,
  type CleanupDecision,
} from "./types";

export function resolveRearrangeCapabilities(
  capabilities?: LspCapabilitySummary | null,
  status?: LspDocumentStatus | null,
): RearrangeCapabilities {
  if (!capabilities) {
    return {
      rearrangeSupported: false,
      providerId: status?.displayName ?? status?.presetId ?? undefined,
    };
  }

  const codeActionKinds = capabilities.codeActionKinds ?? [];
  const hasRearrangeCodeAction =
    codeActionKinds.includes("source.rearrange") ||
    codeActionKinds.includes("source.rearrangeCode") ||
    codeActionKinds.includes("rearrange");
  const isExplicitlySupported =
    (capabilities as unknown as { rearrangeSupported?: boolean; }).rearrangeSupported === true;

  const providerId =
    (capabilities as unknown as { rearrangeProvider?: { id: string; version?: string; }; })
      ?.rearrangeProvider?.id ??
    status?.displayName ??
    status?.presetId ??
    "lsp";
  const providerVersion =
    (capabilities as unknown as { rearrangeProvider?: { id: string; version?: string; }; })
      ?.rearrangeProvider?.version;

  return {
    rearrangeSupported: Boolean(hasRearrangeCodeAction || isExplicitlySupported),
    providerId,
    providerVersion,
  };
}

export function planRearrange(input: RearrangeInput): RearrangeDecision {
  const requestedScope: "selection" | "file" =
    input.scope === "selection" && input.hasSelection ? "selection" : "file";

  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: "No file is open to rearrange",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: `${input.targetPath} is read-only and cannot be rearranged`,
    };
  }

  if (!input.capabilities.rearrangeSupported) {
    const providerLabel = input.capabilities.providerId;
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: providerLabel
        ? `${providerLabel} does not support member-rearrangement for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`
        : `No member-rearrangement provider is available for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`,
    };
  }

  const decision: RearrangeDecision = {
    kind: "execute",
    scope: requestedScope,
    stage: "rearrange",
  };
  if (input.capabilities.providerId) {
    decision.provider = {
      id: input.capabilities.providerId,
      version: input.capabilities.providerVersion,
    };
  }
  return decision;
}

export function resolveCleanupCapabilities(
  capabilities?: LspCapabilitySummary | null,
  status?: LspDocumentStatus | null,
): CleanupCapabilities {
  if (!capabilities) {
    return {
      cleanupSupported: false,
      providerId: status?.displayName ?? status?.presetId ?? undefined,
    };
  }

  const codeActionKinds = capabilities.codeActionKinds ?? [];
  const hasCleanupCodeAction =
    codeActionKinds.includes("source.cleanup") ||
    codeActionKinds.includes("source.fixAll") ||
    codeActionKinds.includes("cleanup");
  const isExplicitlySupported =
    (capabilities as unknown as { cleanupSupported?: boolean; }).cleanupSupported === true;

  const providerId =
    (capabilities as unknown as { cleanupProvider?: { id: string; version?: string; }; })
      ?.cleanupProvider?.id ??
    status?.displayName ??
    status?.presetId ??
    "lsp";
  const providerVersion =
    (capabilities as unknown as { cleanupProvider?: { id: string; version?: string; }; })
      ?.cleanupProvider?.version;

  const supportedProfiles =
    (capabilities as unknown as { supportedProfiles?: readonly string[]; }).supportedProfiles ??
    (capabilities as unknown as { cleanupProvider?: { supportedProfiles?: readonly string[]; }; })
      ?.cleanupProvider?.supportedProfiles ??
    ["default", "full-cleanup"];

  return {
    cleanupSupported: Boolean(hasCleanupCodeAction || isExplicitlySupported),
    providerId,
    providerVersion,
    supportedProfiles,
  };
}

export function planCleanup(input: CleanupInput): CleanupDecision {
  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: "No target is selected for code cleanup",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: `${input.targetPath} is read-only and cannot be cleaned up`,
    };
  }

  if (!input.capabilities.cleanupSupported) {
    const providerLabel = input.capabilities.providerId;
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: providerLabel
        ? `${providerLabel} does not support code cleanup for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`
        : `No code cleanup provider is available for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`,
    };
  }

  const decision: CleanupDecision = {
    kind: "execute",
    scope: input.scope,
    stage: "cleanup",
    profileId: input.profileId ?? "default",
  };
  if (input.capabilities.providerId) {
    decision.provider = {
      id: input.capabilities.providerId,
      version: input.capabilities.providerVersion,
    };
  }
  return decision;
}

// ---------------------------------------------------------------------------
// ED-AUDIT-015: production execute wiring for Rearrange Code.
// ---------------------------------------------------------------------------

/**
 * Provider action kinds that count as a dedicated arrangement capability.
 * Matched by exact kind equality only — never by summary booleans or title
 * substring guessing. `source.sortMembers` is the Eclipse JDT LS
 * member-arrangement action (Sort Members support, JDT LS 1.61 #2169;
 * JavaCodeActionKind in the pinned 1.61.0 bundle; live-verified against the
 * pinned server with a bare-LSP probe returning a real edit). JDT LS never
 * advertises it in codeActionKinds, so discovery is live-only by design.
 */
export const REARRANGE_ACTION_KINDS: readonly string[] = [
  "source.rearrange",
  "source.rearrangeCode",
  "rearrange",
  "source.sortMembers",
];

export function isRearrangeActionKind(kind: string | null): boolean {
  return kind !== null && REARRANGE_ACTION_KINDS.includes(kind);
}

/**
 * ED-AUDIT-016: production execute wiring for Code Cleanup.
 * ---------------------------------------------------------------------------
 * Mirrors the rearrange execute owner (ED-AUDIT-015): file scope with the
 * default profile only; other scopes/profiles stay unavailable per spec.
 */

/**
 * Provider action kinds that count as a dedicated batch-cleanup capability.
 * Matched by exact kind equality only — never by summary booleans, title
 * substring guessing, or relabeling format/organizeImports as cleanup.
 * ED-IMPROVE-003: generic `source.fixAll` is NOT an equivalent Cleanup kind —
 * without a dedicated cleanup/profile contract a fixAll payload stays
 * unavailable instead of being executed under the Cleanup label.
 * NOTE: Eclipse JDT LS 1.61 exposes no cleanup kind (bundle + live probe
 * verified: only generate/organizeImports/overrideMethods/sortMembers), so
 * this list matches nothing on this box today; the wiring below still
 * performs the real request/resolve/plan/confirm/apply/post-verify chain
 * for any provider that does advertise one of these kinds.
 */
export const CLEANUP_ACTION_KINDS: readonly string[] = [
  "source.cleanup",
  "cleanup",
];

export function isCleanupActionKind(kind: string | null): boolean {
  return kind !== null && CLEANUP_ACTION_KINDS.includes(kind);
}
