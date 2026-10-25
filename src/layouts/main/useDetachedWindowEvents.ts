import { useEffect } from "react";
import { subscribeReattach, drainPendingReattach, clearReattachHandoff, type ReattachMessage } from "../../lib/detachedSession";
import type { DetachedRdpParams, DetachedVncParams, DetachedTerminalParams, DetachedDbParams } from "../../components/detached/DetachedSessionWindow";
import { vncConsumeDetachClaim } from "../../lib/vnc";
import { deserializeVncViewerOptions } from "../../lib/vncOptions";
import type { Tab } from "../../types";
import { useLanChatStore } from "../../stores/lanChatStore";
import { t as tr } from "../../lib/i18n";


export interface UseDetachedWindowEventsContext {
  tabsRef: import("react").RefObject<Tab[]>;
  setActiveTab: (id: string) => void;
  addTab: (tab: Tab) => void;
  setStatusMessage: (message: string) => void;
}

export function useDetachedWindowEvents(context: UseDetachedWindowEventsContext) {
  const { tabsRef, setActiveTab, addTab, setStatusMessage } = context;

  /**
   * Subscribe to reattach messages broadcast by detached windows. Each
   * time a detached window asks to come back, recreate the equivalent
   * tab in this window using the credential payload from the reattach
   * envelope. localStorage envelopes left behind by abrupt closes are
   * also drained on subscribe.
   */
  useEffect(() => {
    // Collapse a single close "burst" into one tab. Closing a detached
    // window can fan a reattach out across several transports/listeners
    // (BroadcastChannel + localStorage backstop, leaked onCloseRequested
    // listeners, beforeunload+pagehide double-fire). They all carry the
    // same (kind,id) within a few hundred ms, so a short per-(kind,id)
    // window dedupes them without blocking a legitimate later re-detach.
    const recentReattach = new Map<string, number>();
    const BURST_WINDOW_MS = 1500;
    const handle = async (msg: ReattachMessage) => {
      const burstKey = `${msg.kind}.${msg.id}`;
      const now = Date.now();
      const last = recentReattach.get(burstKey);
      if (last !== undefined && now - last < BURST_WINDOW_MS) {
        clearReattachHandoff(msg.kind, msg.id);
        return;
      }
      recentReattach.set(burstKey, now);
      if (msg.kind === "lan-chat") {
        const p = msg.payload as { activeConvId?: string; title?: string } | undefined;
        const convId = p?.activeConvId || msg.id;
        const existing = tabsRef.current.find((tab) => tab.type === "lan-chat");
        if (existing) {
          setActiveTab(existing.id);
        } else {
          addTab({
            id: "lan-chat",
            type: "lan-chat",
            title: tr("tabs.lanChat"),
            closable: true,
          });
        }
        if (convId) {
          if (convId.startsWith("direct:") || convId.startsWith("group:")) {
            void useLanChatStore.getState().openConversation(convId);
          }
        }
        setStatusMessage(tr("status.reattached"));
        clearReattachHandoff(msg.kind, msg.id);
        return;
      }
      // Idempotent tab identity: use the original source tab id when the
      // payload has it so chat threads stay bound across detach/reattach.
      // Older handoffs fall back to the detached id-derived shape.
      const payloadTabId =
        typeof (msg.payload as { tabId?: unknown } | undefined)?.tabId === "string"
          ? ((msg.payload as { tabId: string }).tabId.trim() || null)
          : null;
      const reattachTabId = payloadTabId ?? `${msg.kind}-reattach-${msg.id}`;
      if (tabsRef.current.some((t) => t.id === reattachTabId)) {
        setActiveTab(reattachTabId);
        clearReattachHandoff(msg.kind, msg.id);
        return;
      }
      switch (msg.kind) {
        case "rdp": {
          const p = msg.payload as DetachedRdpParams | undefined;
          if (!p?.host) return;
          addTab({
            id: reattachTabId,
            type: "rdp",
            title: p.title || `${p.host}:${p.port}`,
            sessionId: p.sessionId,
            closable: true,
            rdp: {
              sessionId: p.sessionId,
              host: p.host,
              port: p.port,
              username: p.username ?? undefined,
              password: p.password,
              options: p.options,
              networkSettingsJson: p.networkSettingsJson ?? null,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "vnc": {
          let p = msg.payload as DetachedVncParams | undefined;
          if (p?.claimId && !p.host) {
            const claim = await vncConsumeDetachClaim(p.claimId);
            p = {
              ...p,
              claimId: undefined,
              host: claim.host,
              port: claim.port,
              username: claim.username,
              password: claim.password,
              networkSettingsJson: claim.network_settings_json,
              securityPolicy: claim.security_policy,
              viewOnly: claim.view_only,
              clipboardPolicy: claim.clipboard_policy as DetachedVncParams["clipboardPolicy"],
              viewerOptions: deserializeVncViewerOptions(claim.viewer_options_json),
            };
          }
          if (!p?.host) return;
          addTab({
            id: reattachTabId,
            type: "vnc",
            title: p.title || `${p.host}:${p.port}`,
            sessionId: p.sessionId,
            closable: true,
            vnc: {
              sessionId: p.sessionId,
              host: p.host,
              port: p.port,
              username: p.username ?? undefined,
              password: p.password,
              networkSettingsJson: p.networkSettingsJson ?? null,
              securityPolicy: p.securityPolicy,
              viewOnly: p.viewOnly,
              clipboardPolicy: p.clipboardPolicy,
              viewerOptions: p.viewerOptions,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "terminal": {
          const p = msg.payload as DetachedTerminalParams | undefined;
          if (!p) return;
          const adopted = p.reattach?.terminalSessionId
            ? {
                sessionId: p.reattach.terminalSessionId,
                snapshotText: p.reattach.snapshotText,
              }
            : undefined;
          addTab({
            id: reattachTabId,
            type: "terminal",
            title: p.title || tr("tabs.localTerminal"),
            sessionId: p.savedSessionId,
            terminalTitleMode: p.terminalTitleMode,
            terminalTitleOperation: p.terminalTitleOperation,
            terminalTitleSessionName: p.terminalTitleSessionName,
            closable: true,
            ssh: p.ssh ?? undefined,
            commandTerminal: p.commandTerminal ?? undefined,
            localShell: p.localShell ?? undefined,
            terminalProfile: p.terminalProfile ?? undefined,
            adoptedTerminal: adopted,
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        case "database": {
          const p = msg.payload as DetachedDbParams | undefined;
          if (!p?.info) return;
          addTab({
            id: reattachTabId,
            type: "database",
            title: p.title || `${p.info.engine} ${p.info.host}`,
            sessionId: reattachTabId,
            closable: true,
            db: {
              ...p.info,
              sessionId: reattachTabId,
              workspaceSessionId: p.info.workspaceSessionId ?? p.info.sessionId,
            },
          });
          setStatusMessage(tr("status.reattached"));
          break;
        }
        default:
          /* SFTP reattach not wired — SFTP detach is co-existing, not exclusive. */
          break;
      }
      clearReattachHandoff(msg.kind, msg.id);
    };
    const unsub = subscribeReattach((msg) => { void handle(msg); });
    // Drain any envelopes left by detached windows that closed abruptly
    // before we subscribed.
    drainPendingReattach().forEach((msg) => { void handle(msg); });
    return unsub;
  }, [addTab, setActiveTab, setStatusMessage]);
  return {  };
}
