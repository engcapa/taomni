import { ApiError, request, type Instance } from "./api";

export type OpenTarget = { kind: "local" } | { kind: "saved"; saved_session_id: string };
interface OpenStatus { request_id: string; status: "pending" | "opened" | "failed"; session_id?: string; error?: string }

const POLL_MS = 1000;
// The instance gives up after 180 s; stop a little later so its answer wins.
const GIVE_UP_MS = 190_000;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
  const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
  signal.addEventListener("abort", cancel, { once: true });
});

/**
 * Asks the instance's desktop window to open a saved session or a new local
 * terminal, then waits until the desktop reports the running terminal.
 * Resolves with the `term:` session id; rejects with an ApiError code.
 */
export async function openSession(instance: Instance, target: OpenTarget, signal: AbortSignal): Promise<string> {
  const started = await request<OpenStatus>(instance, "/open-requests", target, signal);
  const deadline = Date.now() + GIVE_UP_MS;
  let status = started;
  while (status.status === "pending") {
    if (Date.now() > deadline) throw new ApiError("open_timeout");
    await sleep(POLL_MS, signal);
    try {
      status = await request<OpenStatus>(instance, `/open-requests/${encodeURIComponent(started.request_id)}`, undefined, signal);
    } catch (error) {
      // A dropped poll is not a failed open: the desktop may still finish.
      if (error instanceof ApiError && error.code === "connection_failed") continue;
      throw error;
    }
  }
  if (status.status === "opened" && status.session_id) return status.session_id;
  throw new ApiError(status.error || "open_failed");
}
