import { Channel, invoke } from "@tauri-apps/api/core";
import type { ChatBackend, TaoEvent, TaoRequest, TaoThread } from "./ports";

/** Channel messages are consumed immediately; invoke's completion only closes
 * the iterator. Rust never returns a second copy of the streamed events. */
function stream(command: string, args: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<TaoEvent> {
  const queued: TaoEvent[] = [];
  let done = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const channel = new Channel<TaoEvent>();
  channel.onmessage = (event) => { queued.push(event); wake?.(); };
  const finish = () => { done = true; wake?.(); };
  const abort = () => { failure = new DOMException("Aborted", "AbortError"); finish(); };
  if (signal?.aborted) abort();
  else {
    signal?.addEventListener("abort", abort, { once: true });
    void invoke(command, { ...args, onEvent: channel }).catch((error: unknown) => { failure = error; }).finally(finish);
  }
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (!done || queued.length) {
          if (queued.length) { yield queued.shift()!; continue; }
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
        }
        if (failure) throw failure;
      } finally { signal?.removeEventListener("abort", abort); }
    },
  };
}

export const deepSeekAppBackend: ChatBackend = {
  async send(request: TaoRequest, signal?: AbortSignal) { return stream("deepseek_app_send", { request }, signal); },
  async stop(threadId) { await invoke("deepseek_app_stop", { threadId }); },
  async regenerate(threadId) { return stream("deepseek_app_regenerate", { threadId }); },
  async continue(threadId) { return stream("deepseek_app_continue", { threadId }); },
  async clone(sourceThreadId, targetThreadId, throughMessageIndex) { await invoke("deepseek_app_clone_thread", { sourceThreadId, targetThreadId, throughMessageIndex }); },
};

export const nativeThreadStorage = {
  load: () => invoke<TaoThread[]>("deepseek_app_load_threads"),
  save: (thread: TaoThread) => invoke<void>("deepseek_app_save_thread", { thread }),
  remove: (threadId: string) => invoke<void>("deepseek_app_delete_thread", { threadId }),
};
