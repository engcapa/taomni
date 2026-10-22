import { invoke } from "@tauri-apps/api/core";
import { type LspReferenceRequestOptions } from "./types";

export let lspRequestSequence = 0;

/**
 * Allocate a renderer-wide sequence for requests that share native
 * cancellation identity. A component-local counter can repeat after a tab
 * remount while the native registry is still finishing the previous request.
 */
export function nextLspRequestSequence(): number {
  lspRequestSequence += 1;
  return lspRequestSequence;
}

export function createLspAbortError(): Error {
  const error = new Error("LSP request cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Invoke a provider request with the renderer-owned signal bridged to the
 * native cancellation registry. The native command still receives the
 * identity even when no renderer signal is supplied, so a newer request can
 * supersede an older one at the provider boundary.
 */
export function invokeCancellable<T>(
  command: string,
  args: Record<string, unknown>,
  options?: LspReferenceRequestOptions,
): Promise<T> {
  const signal = options?.signal;
  const cancelKey = options?.cancelKey?.trim() || null;
  const requestSeq = cancelKey
    ? options?.requestSeq ?? nextLspRequestSequence()
    : null;
  if (signal?.aborted) return Promise.reject(createLspAbortError());

  let removeAbortListener: (() => void) | undefined;
  const onAbort = () => {
    if (cancelKey) {
      void lspCancelReferenceRequest(cancelKey, requestSeq ?? undefined).catch(() => undefined);
    }
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  }

  let request: Promise<T>;
  try {
    request = invoke<T>(command, {
      ...args,
      cancelKey,
      requestSeq,
    });
  } catch (error) {
    removeAbortListener?.();
    return Promise.reject(error);
  }
  // Cover an abort racing the signal-listener registration and invoke call.
  if (signal?.aborted) onAbort();
  return request.finally(() => removeAbortListener?.());
}

/**
 * Cancel an in-flight reference request without issuing a new one (popup
 * close / unmount path, §8.18.6).
 */
export function lspCancelReferenceRequest(cancelKey: string, requestSeq?: number): Promise<boolean> {
  return invoke<boolean>("lsp_cancel_reference_request", {
    cancelKey,
    requestSeq: requestSeq ?? null,
  });
}
