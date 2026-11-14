import { invoke } from "@tauri-apps/api/core";
import type { ChatBackend, TaoEvent, TaoRequest } from "./ports";

interface NativeResponse {
  events?: TaoEvent[];
}

/** Native bridge for the DeepSeek Messages track. The browser preview deliberately
 * does not fabricate an answer: an unavailable command is surfaced as a network
 * error card so screenshots cannot be mistaken for a provider integration. */
export const deepSeekAppBackend: ChatBackend = {
  async send(request: TaoRequest, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await invoke<NativeResponse>("deepseek_app_send", { request });
    return response?.events ?? [];
  },
  async stop(threadId) {
    await invoke("deepseek_app_stop", { threadId });
  },
};
