import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { addressesThisWindow } from "../../../lib/windowLabel";
import type { AcpPermissionDismissed, AcpPermissionPrompt, CcPermissionResolved, PermissionPrompt, QueuedPermission } from "./types";

export function sameApproval(left: QueuedPermission, right: QueuedPermission) {
  if (left.callId !== right.callId) return false;
  if (left.source === "cc") return right.source === "cc";
  return right.source === "acp" && left.threadId === right.threadId && left.permissionOwnerId === right.permissionOwnerId;
}

export function usePendingApprovals() {
  const [queue, setQueue] = useState<QueuedPermission[]>([]);
  useEffect(() => {
    let disposed = false;
    let replaying = true;
    const listeners: UnlistenFn[] = [];
    // A dismissal received while the mount snapshot is in flight wins over
    // the older snapshot, including dismissals applying to an entire thread.
    const dismissedDuringReplay: Array<(prompt: QueuedPermission) => boolean> = [];
    const add = (prompt: QueuedPermission) => {
      if (disposed || !prompt.callId || !addressesThisWindow(prompt.windowLabel)) return;
      setQueue((items) => items.some((item) => sameApproval(item, prompt)) ? items : [...items, prompt]);
    };
    const dismiss = (matches: (prompt: QueuedPermission) => boolean) => {
      if (disposed) return;
      if (replaying) dismissedDuringReplay.push(matches);
      setQueue((items) => items.filter((item) => !matches(item)));
    };
    const subscribe = async <T,>(event: string, handle: (payload: T) => void) => {
      const close = await listen<T>(event, ({ payload }) => handle(payload));
      if (disposed) close();
      else listeners.push(close);
    };
    const restore = async <T extends PermissionPrompt | AcpPermissionPrompt,>(command: string, fromPayload: (value: T) => QueuedPermission) => {
      const prompts = await invoke<T[]>(command);
      if (disposed || !Array.isArray(prompts)) return;
      for (const payload of prompts) {
        if (!payload) continue;
        const prompt = fromPayload(payload);
        if (!dismissedDuringReplay.some((matches) => matches(prompt))) add(prompt);
      }
    };
    async function connect() {
      await Promise.allSettled([
        subscribe<PermissionPrompt>("agent-cc-permission", (p) => add({ ...p, source: "cc" })),
        subscribe<AcpPermissionPrompt>("agent-acp-permission", (p) => add({ ...p, source: "acp" })),
        subscribe<CcPermissionResolved>("agent-cc-permission-resolved", ({ callId, threadId }) => {
          dismiss((p) => p.source === "cc" && (callId != null ? p.callId === callId : p.threadId === threadId));
        }),
        subscribe<AcpPermissionDismissed>("agent-acp-permission-dismissed", ({ threadId, permissionOwnerId, callId }) => {
          dismiss((p) => p.source === "acp" && p.threadId === threadId
            && (permissionOwnerId == null || p.permissionOwnerId === permissionOwnerId)
            && (callId == null || callId === p.callId));
        }),
      ]);
      if (disposed) return;
      await Promise.allSettled([
        restore<PermissionPrompt>("cc_pending_permission_prompts", (p) => ({ ...p, source: "cc" })),
        restore<AcpPermissionPrompt>("acp_pending_permission_prompts", (p) => ({ ...p, source: "acp" })),
      ]);
      replaying = false;
      dismissedDuringReplay.length = 0;
    }
    void connect();
    return () => {
      disposed = true;
      for (const close of listeners) close();
    };
  }, []);
  return { queue, setQueue };
}
