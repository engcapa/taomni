import type { CodeActionProviderClient } from "./types";

const JDTLS_CODE_ASSIST_CANCELLED = "Java code assist was cancelled by the language server:";

/** Recover one provider-side read cancellation within the caller's existing deadline. */
export async function requestCandidateActions(
  client: CodeActionProviderClient,
  params: Parameters<CodeActionProviderClient["requestCodeActions"]>[0],
  providerId: string,
  signal: AbortSignal,
) {
  try {
    return await client.requestCodeActions(params, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal.aborted || providerId !== "jdtls" || !message.startsWith(JDTLS_CODE_ASSIST_CANCELLED)) {
      throw error;
    }
    // This asks for candidates only. Resolve, commands and edits are never
    // replayed. The service's one timeout/cancellation race owns both attempts.
    return client.requestCodeActions(params, signal);
  }
}
