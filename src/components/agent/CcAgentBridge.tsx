import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ActionCard, type ActionCardDecision } from "./ActionCard";
import { getTerminal } from "../../lib/terminal/terminalRegistry";
import { formatCcTerminalEcho, type CcTerminalEcho } from "../../lib/terminal/ccEcho";
import { getQueryTab } from "../../lib/queryRegistry";
import { useAiStore } from "../../stores/aiStore";
import { useChatStore } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import {
  type QueuedPermission,
  type CaptureProgress,
  type PermissionPrompt,
  type AcpPermissionPrompt,
  type AcpPermissionDismissed,
  type ToolDispatch,
  type SqlEcho,
} from "./bridge/types";
import { executeTool } from "./bridge/tools";
import { useSafetyGatePlacement, AcpPermissionCard } from "./bridge/safetyGate";
import { buildEchoNote, fmtBytes, describe, preview } from "./bridge/formatting";

export function CcAgentBridge() {
  const [queue, setQueue] = useState<QueuedPermission[]>([]);
  const [deciding, setDeciding] = useState(false);
  const [captures, setCaptures] = useState<CaptureProgress[]>([]);
  const activeThreadId = useChatStore((state) => state.activeThreadId);

  // --- permission prompts (HITL) ---------------------------------------
  useEffect(() => {
    let unlistenCc: UnlistenFn | null = null;
    let unlistenAcp: UnlistenFn | null = null;
    let unlistenAcpDismissed: UnlistenFn | null = null;
    let disposed = false;
    void listen<PermissionPrompt>("agent-cc-permission", (event) => {
      // Dedupe by callId: a stray double-emit must not stack two cards.
      const prompt: QueuedPermission = { source: "cc", ...event.payload };
      setQueue((q) =>
        q.some((p) => p.source === prompt.source && p.callId === prompt.callId)
          ? q
          : [...q, prompt],
      );
    }).then((fn) => {
      // `listen` resolves async. If the effect was already torn down (React
      // StrictMode double-mount in dev), unregister immediately instead of
      // leaking this listener — a leak would fire every handler twice.
      if (disposed) void fn();
      else unlistenCc = fn;
    }).catch(() => {
      // `listen` can reject outside Tauri (e.g. jsdom tests); ignore — the
      // bridge is simply inert there.
    });
    void listen<AcpPermissionPrompt>("agent-acp-permission", (event) => {
      const prompt: QueuedPermission = { source: "acp", ...event.payload };
      setQueue((q) =>
        q.some(
          (p) =>
            p.source === prompt.source &&
            p.threadId === prompt.threadId &&
            p.callId === prompt.callId,
        )
          ? q
          : [...q, prompt],
      );
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenAcp = fn;
    }).catch(() => {
      // ACP gates are only emitted by the desktop backend; ignore a missing
      // event bridge in browser-only tests just like the CC listener above.
    });
    void listen<AcpPermissionDismissed>("agent-acp-permission-dismissed", (event) => {
      const { threadId, permissionOwnerId, callId } = event.payload;
      setQueue((q) =>
        q.filter((p) => {
          if (p.source !== "acp" || p.threadId !== threadId) return true;
          if (callId != null && p.callId !== callId) return true;
          return permissionOwnerId != null && p.permissionOwnerId !== permissionOwnerId;
        }),
      );
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenAcpDismissed = fn;
    }).catch(() => {
      // The backend can dismiss a gate after an ACP timeout, stop, or close.
    });
    return () => {
      disposed = true;
      unlistenCc?.();
      unlistenAcp?.();
      unlistenAcpDismissed?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen("taomni-sessions-changed", () => {
      void useSessionStore.getState().loadSessions();
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => { });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const decide = useCallback(
    async (prompt: Extract<QueuedPermission, { source: "cc"; }>, decision: ActionCardDecision) => {
      setDeciding(true);
      try {
        // ActionCardDecision values ("allow" | "allow-session" | "deny") map
        // 1:1 onto the backend CcPermissionDecision (kebab-case) enum.
        await invoke("cc_resolve_permission", {
          callId: prompt.callId,
          decision,
        });
      } catch (e) {
        console.error("cc_resolve_permission failed:", e);
      } finally {
        setQueue((q) =>
          q.filter((p) => p.source !== prompt.source || p.callId !== prompt.callId),
        );
        setDeciding(false);
      }
    },
    [],
  );

  const decideAcp = useCallback(
    async (prompt: Extract<QueuedPermission, { source: "acp"; }>, optionId: string) => {
      setDeciding(true);
      try {
        await invoke("acp_resolve_permission", {
          threadId: prompt.threadId,
          callId: prompt.callId,
          optionId,
        });
      } catch (e) {
        console.error("acp_resolve_permission failed:", e);
      } finally {
        setQueue((q) =>
          q.filter((p) => p.source !== prompt.source || p.callId !== prompt.callId),
        );
        setDeciding(false);
      }
    },
    [],
  );

  const cancelAcp = useCallback(
    async (prompt: Extract<QueuedPermission, { source: "acp"; }>) => {
      setDeciding(true);
      try {
        await invoke("acp_cancel_permission", {
          threadId: prompt.threadId,
          callId: prompt.callId,
        });
      } catch (e) {
        console.error("acp_cancel_permission failed:", e);
      } finally {
        setQueue((q) =>
          q.filter((p) => p.source !== prompt.source || p.callId !== prompt.callId),
        );
        setDeciding(false);
      }
    },
    [],
  );

  // --- side-effect tool dispatch ---------------------------------------
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<ToolDispatch>("agent-cc-tool", (event) => {
      void executeTool(event.payload);
    }).then((fn) => {
      // See the permission listener above: avoid leaking a duplicate listener,
      // which here would write the command into the terminal twice.
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => {
      // `listen` can reject outside Tauri (e.g. jsdom tests); ignore — the
      // bridge is simply inert there.
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const head = queue[0] ?? null;
  const safetyGatePlacement = useSafetyGatePlacement(Boolean(head));

  // --- captured-run progress (方案4) -----------------------------------
  useEffect(() => {
    let unlistenProgress: UnlistenFn | null = null;
    let unlistenEnd: UnlistenFn | null = null;
    let disposed = false;
    void listen<CaptureProgress>("agent-cc-capture-progress", (event) => {
      setCaptures((cs) => {
        const i = cs.findIndex((c) => c.captureId === event.payload.captureId);
        if (i === -1) return [...cs, event.payload];
        const next = cs.slice();
        next[i] = event.payload;
        return next;
      });
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenProgress = fn;
    }).catch(() => { });
    void listen<{ captureId: string; }>("agent-cc-capture-end", (event) => {
      setCaptures((cs) => cs.filter((c) => c.captureId !== event.payload.captureId));
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenEnd = fn;
    }).catch(() => { });
    return () => {
      disposed = true;
      unlistenProgress?.();
      unlistenEnd?.();
    };
  }, []);

  // --- captured-run terminal echo (方案4 mirror) -----------------------
  // The default run_captured path runs in an independent channel, so it never
  // appears in the bound terminal. The backend emits this once a captured run
  // finishes; we paint a compact, read-only trace (command + output head +
  // stats) into that terminal so the user sees what CC did. Display-only
  // (writeEcho -> xterm.write), never touches stdin.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<CcTerminalEcho>("agent-cc-terminal-echo", (event) => {
      if (useAiStore.getState().config?.cc_bridge.terminal_echo_enabled === false) {
        return;
      }
      const term = getTerminal(event.payload.sessionId);
      if (!term?.writeEcho) return; // terminal closed / no display sink; chat still has it
      try {
        term.writeEcho(formatCcTerminalEcho(event.payload));
      } catch (e) {
        console.error("cc terminal echo failed:", e);
      }
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => { });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // --- SQL echo to the linked query tab --------------------------------
  // When CC runs SQL on a bound DB connection the backend emits
  // `agent-cc-sql-echo`; if the toggle is on we resolve the thread's linked
  // query tab and append the statement to its editor (never run it).
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<SqlEcho>("agent-cc-sql-echo", (event) => {
      if (!useAppStore.getState().sqlEcho) return;
      const e = event.payload;
      const tabId =
        useChatStore.getState().threads.find((t) => t.id === e.threadId)
          ?.linked_session_id ?? null;
      const entry = getQueryTab(tabId);
      if (!entry) return;
      try {
        entry.appendEchoSql(e.sql, buildEchoNote(e));
      } catch (err) {
        console.error("sql echo append failed:", err);
      }
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => { });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const cancelCapture = useCallback(async (captureId: string) => {
    try {
      await invoke("cc_cancel_capture", { captureId });
    } catch (e) {
      console.error("cc_cancel_capture failed:", e);
    }
  }, []);

  return (
    <>
      {captures.length > 0 && (
        <div className="fixed bottom-4 left-4 z-[1000] flex max-w-[360px] flex-col gap-2">
          {captures.map((c) => (
            <div
              key={c.captureId}
              className="flex items-center justify-between gap-3 rounded bg-[var(--taomni-bg-elevated,#222)] px-3 py-2 text-xs shadow-lg"
            >
              <span className="truncate text-[var(--taomni-text-muted)]">
                捕获中 {c.lines.toLocaleString()} 行 · {fmtBytes(c.bytes)}
              </span>
              <button
                type="button"
                className="shrink-0 rounded border border-[var(--taomni-border,#444)] px-2 py-0.5 hover:bg-[var(--taomni-bg-hover,#333)]"
                onClick={() => void cancelCapture(c.captureId)}
              >
                取消
              </button>
            </div>
          ))}
        </div>
      )}
      {head && (
        <div
          className="fixed z-[1000] shadow-lg"
          style={safetyGatePlacement.style}
          data-testid="ai-chat-safety-gate"
          data-anchor={safetyGatePlacement.anchored ? "chat-drawer" : "viewport"}
        >
          {head.source === "cc" ? (
            <ActionCard
              tool={head.tool}
              description={describe(head.tool, head.args)}
              preview={preview(head.args)}
              requiresConfirmation={true}
              executing={deciding}
              onDecide={(d) => void decide(head, d)}
            />
          ) : (
            <AcpPermissionCard
              prompt={head}
              executing={deciding}
              isActiveThread={head.threadId === activeThreadId}
              onSelect={(optionId) => void decideAcp(head, optionId)}
              onCancel={() => void cancelAcp(head)}
            />
          )}
        </div>
      )}
    </>
  );
}
