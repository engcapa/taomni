import { type LastBasicInvocation, type RecordedCompletionInvocation, type CompletionInvocationReason, type CompletionInvocationEvidence } from "./types";


export const lastBasicInvocation = new Map<string, LastBasicInvocation>();

export const completionInvocationRing: RecordedCompletionInvocation[] = [];

export const COMPLETION_INVOCATION_RING_MAX = 50;


/**
 * Record one Basic invocation and return its ordinal (§8.18.3 / §8.19.4).
 * Only EXPLICIT invocations advance the repeated-call counter — typing or
 * trigger-char popups inherit the live sequence without bumping it. Any edit
 * (revision change), caret move (position change) or provider restart
 * (generation change) resets the next explicit call back to ordinal 1.
 */
export function recordBasicCompletionInvocation(input: {
  workspaceId: string;
  fileKey: string;
  documentRevision: number;
  /** Approximate caret identity; callers pass `${line}:${character}`. */
  positionKey: string;
  reason: CompletionInvocationReason;
  providerGeneration?: number;
}): number {
  const key = `${input.workspaceId} ${input.fileKey}`;
  const previous = lastBasicInvocation.get(key);
  const generation = input.providerGeneration ?? previous?.providerGeneration ?? 0;
  const sameIdentity = !!previous
    && previous.revision === input.documentRevision
    && previous.positionKey === input.positionKey
    && previous.providerGeneration === generation;
  if (input.reason !== "explicit") {
    return sameIdentity ? previous!.ordinal : 1;
  }
  if (sameIdentity) {
    const ordinal = previous!.ordinal + 1;
    lastBasicInvocation.set(key, {
      revision: input.documentRevision,
      positionKey: input.positionKey,
      providerGeneration: generation,
      ordinal,
    });
    return ordinal;
  }
  lastBasicInvocation.set(key, {
    revision: input.documentRevision,
    positionKey: input.positionKey,
    providerGeneration: generation,
    ordinal: 1,
  });
  return 1;
}


/**
 * Popup closed: the repeated-call sequence ends, so the next explicit call is
 * a fresh ordinal-1 Basic request even at the same revision + position.
 */
export function resetBasicCompletionSession(workspaceId: string, fileKey: string): void {
  lastBasicInvocation.delete(`${workspaceId} ${fileKey}`);
}


/** What the provider did with a requested scope expansion. */
export function providerScopeFor(
  requestedScope: "default" | "expanded",
  providerAdvertisesExpansion: boolean,
): CompletionInvocationEvidence["providerScope"] {
  if (requestedScope !== "expanded") return "unknown";
  return providerAdvertisesExpansion ? "expanded" : "unchanged";
}


export function recordCompletionInvocationEvidence(entry: RecordedCompletionInvocation): void {
  completionInvocationRing.push(entry);
  if (completionInvocationRing.length > COMPLETION_INVOCATION_RING_MAX) {
    completionInvocationRing.splice(0, completionInvocationRing.length - COMPLETION_INVOCATION_RING_MAX);
  }
}


/** Snapshot of recent invocation evidence (oldest first); copy, not live. */
export function recentCompletionInvocations(): readonly RecordedCompletionInvocation[] {
  return [...completionInvocationRing];
}
