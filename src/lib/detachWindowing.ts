import { invoke } from "@tauri-apps/api/core";
import type { DetachedKind } from "./detachedSession";

export interface OpenDetachedWindowOptions {
  kind: DetachedKind;
  sessionId: string;
  title?: string;
  width?: number;
  height?: number;
}

/**
 * Ask the Rust side to spawn a new OS window for a detached session. The
 * frontend writes credentials to localStorage *before* invoking so the
 * new window can pick them up via `consumeDetachedHandoff(kind, id)`.
 */
export async function openDetachedWindow(
  opts: OpenDetachedWindowOptions,
): Promise<void> {
  return invoke("open_detached_window", {
    kind: opts.kind,
    sessionId: opts.sessionId,
    title: opts.title,
    width: opts.width,
    height: opts.height,
  });
}

export async function closeCurrentDetachedWindow(): Promise<void> {
  return invoke("close_current_detached_window");
}
