import { type CompletionRequestTelemetryEvent, type CompletionRequestToken, type CompletionRequestPhase } from "./types";
import { lastBasicInvocation, completionInvocationRing } from "./invocation";


export const completionTelemetryRing: CompletionRequestTelemetryEvent[] = [];

export const COMPLETION_TELEMETRY_RING_MAX = 50;

export const completionRequestStartedAt = new WeakMap<CompletionRequestToken, number>();


export function telemetryElapsed(token: CompletionRequestToken): number {
  const startedAt = completionRequestStartedAt.get(token);
  return startedAt === undefined ? 0 : Math.max(0, Math.round(performance.now() - startedAt));
}


export function recordCompletionTelemetry(
  token: CompletionRequestToken,
  phase: CompletionRequestPhase,
  options: { itemCount?: number; truncated?: boolean; reason?: string; } = {},
): void {
  completionTelemetryRing.push({
    requestId: token.requestId,
    languageId: token.languageId,
    phase,
    durationMs: telemetryElapsed(token),
    itemCount: options.itemCount ?? 0,
    truncated: options.truncated ?? false,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  });
  if (completionTelemetryRing.length > COMPLETION_TELEMETRY_RING_MAX) {
    completionTelemetryRing.splice(0, completionTelemetryRing.length - COMPLETION_TELEMETRY_RING_MAX);
  }
}


/** Snapshot of recent request phases (oldest first); copy, caller cannot mutate. */
export function recentCompletionTelemetry(): readonly CompletionRequestTelemetryEvent[] {
  return [...completionTelemetryRing];
}


/** Test/diagnostic reset of the telemetry ring. */
export function resetCompletionTelemetry(): void {
  completionTelemetryRing.length = 0;
  lastBasicInvocation.clear();
  completionInvocationRing.length = 0;
}
