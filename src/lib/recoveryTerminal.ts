import { Channel, invoke } from "@tauri-apps/api/core";

/** Explicit read-only observation of the ORIGINAL session. No write/resize/startup IPC. */
export function observeRecoveryTerminal(sessionId: string, onOutput: (data: Uint8Array) => void) {
  let stopped = false;
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (data: ArrayBuffer | number[]) => {
    if (!stopped) onOutput(data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
  };
  const ready = invoke("attach_terminal_output", { sessionId, onOutput: channel });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // An in-flight attach may finish after unmount; remove that particular channel
    // only AFTER its registration, never close the original terminal.
    void ready.then(() => invoke("detach_terminal_output", { sessionId, channelId: channel.id }))
      .catch((error: unknown) => console.warn("[recovery] output subscription cleanup unavailable", error));
  };
  return { ready, stop };
}

export const RECOVERY_OUTPUT_CHARS = 64 * 1024;
export function appendRecoveryOutput(previous: string, chunk: Uint8Array): string {
  // Not a VT screen or checkpoint: lossy bounded observation, explicitly labelled.
  // Clip raw bytes before decoding so even one oversized chunk has bounded work.
  const text = new TextDecoder().decode(chunk.subarray(Math.max(0, chunk.length - RECOVERY_OUTPUT_CHARS)));
  return (previous + text).slice(-RECOVERY_OUTPUT_CHARS);
}
