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
  type ToolDispatch,
  type SqlEcho,
} from "./bridge/types";
import { executeTool } from "./bridge/tools";
import { useSafetyGatePlacement, AcpPermissionCard } from "./bridge/safetyGate";
import { buildEchoNote, fmtBytes, describe, preview } from "./bridge/formatting";
import { addressesThisWindow } from "../../lib/windowLabel";
import { QA_APPROVAL_PROBE_ENABLED, installApprovalProbe } from "./approvalProbe";

import { sameApproval, usePendingApprovals } from "./bridge/usePendingApprovals";
import { getLocale, useT } from "../../lib/i18n";

export function CcAgentBridge() {
  const t = useT();
  const { queue, setQueue } = usePendingApprovals();
  const [deciding, setDeciding] = useState(false);
  const [captures, setCaptures] = useState<CaptureProgress[]>([]);
  const activeThreadId = useChatStore((state) => state.activeThreadId);

  // Hidden QA approval probe (issue #869): only the isolated QA bundle and the
  // browser preview install it, so production never listens for the chord.
  useEffect(
    () => (QA_APPROVAL_PROBE_ENABLED ? installApprovalProbe() : undefined),
    [],
  );

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
          q.filter((p) => !sameApproval(p, prompt)),
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
          permissionOwnerId: prompt.permissionOwnerId,
          callId: prompt.callId,
          optionId,
        });
      } catch (e) {
        console.error("acp_resolve_permission failed:", e);
      } finally {
        setQueue((q) =>
          q.filter((p) => !sameApproval(p, prompt)),
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
          permissionOwnerId: prompt.permissionOwnerId,
          callId: prompt.callId,
        });
      } catch (e) {
        console.error("acp_cancel_permission failed:", e);
      } finally {
        setQueue((q) =>
          q.filter((p) => !sameApproval(p, prompt)),
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
      // Only the addressed window performs the effect; otherwise two windows
      // would write the same command into their terminals (issue #869).
      if (!addressesThisWindow(event.payload.windowLabel)) return;
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
        <div className="fixed bottom-4 left-4 z-[var(--taomni-z-toast)] flex max-w-[360px] flex-col gap-2">
          {captures.map((c) => (
            <div
              key={c.captureId}
              className="flex items-center justify-between gap-3 rounded bg-[var(--taomni-panel-bg)] px-3 py-2 text-ui-body shadow-[var(--taomni-shadow-md)]"
            >
              <span className="truncate text-[var(--taomni-text-muted)]">
                {t("agent.captureProgress", { lines: c.lines.toLocaleString(getLocale()), size: fmtBytes(c.bytes) })}
              </span>
              <button
                type="button"
                className="shrink-0 rounded border border-[var(--taomni-divider)] px-2 py-0.5 hover:bg-[var(--taomni-hover)]"
                onClick={() => void cancelCapture(c.captureId)}
              >
                {t("common.cancel")}
              </button>
            </div>
          ))}
        </div>
      )}
      {head && (
        <div
          className="fixed z-[var(--taomni-z-blocking-gate)]"
          style={safetyGatePlacement.style}
          data-testid="ai-chat-safety-gate"
          data-call-id={head.callId}
          data-source-window={head.sourceWindow}
          data-anchor={safetyGatePlacement.anchored ? "chat-drawer" : "viewport"}
          // Observable queue depth: only the head renders, so a stacked
          // duplicate is invisible in the DOM without this.
          data-queue-length={String(queue.length)}
        >
          {head.sourceWindow && (
            <div className="rounded-t border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] px-3 py-1 text-ui-body">
              {t("agent.approvalWindow", { name: head.sourceWindowTitle || head.sourceWindow })}
            </div>
          )}
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
