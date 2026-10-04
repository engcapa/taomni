import { useRef } from "react";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { getPanelActions } from "../lib/shell/panelActions";
import { waitShellReady } from "../lib/shell/readiness";
import { t } from "../lib/i18n";
import type { SessionConfig } from "../lib/ipc";
import type { CodeWorkspaceTabInfo, Tab } from "../types";
import type { OpenEntryResult } from "./useWelcomeSessionResume";
import type { ShellRestoreOutcome } from "./useShellResumeComposer";
import type { ReopenRecentPanel } from "../components/shell/ShellRecentPanels";

interface RecentPanelOpeners {
  openWorkspace(workspace: CodeWorkspaceTabInfo, signal: AbortSignal): Promise<ShellRestoreOutcome>;
  loadSession(id: string): Promise<SessionConfig>;
  openSession(session: SessionConfig, context: { operationId: string; entryIdentity: string }): Promise<OpenEntryResult>;
  cancelAuth(operationId: string): void;
  openSftp(tab: Tab): void;
}
const chooseOwner = () => Object.assign(new Error(t("shell.missingPanelOwner")), { code: "choose-owner" });

export function useRecentPanelReopen(openers: RecentPanelOpeners): ReopenRecentPanel {
  const latest = useRef(openers); latest.current = openers;
  const pending = useRef(new Map<string, Promise<string>>());
  const openedOwners = useRef(new Map<string, { selection: string; tabId: string }>());
  return (entry, selection, signal) => {
    const key = `${entry.restoreRef}:${entry.kind}`;
    const existing = pending.current.get(key); if (existing) return existing;
    const run = (async () => {
      const operationId = crypto.randomUUID();
      const cancel = () => latest.current.cancelAuth(operationId);
      signal.addEventListener("abort", cancel, { once: true });
      const check = () => { if (signal.aborted) throw new Error(t("common.cancel")); };
      try {
        check();
        let shell = useShellLayoutStore.getState(), app = useAppStore.getState();
        const selectionKey = selection ? `${selection.kind}:${selection.id}` : "";
        const restoreRef = selection?.kind === "session" ? `run-entry:saved:${selection.id}` : entry.restoreRef;
        const usable = (id: string) => app.tabs.some((tab) => tab.id === id) && app.terminalRuntimeByTab[id]?.state !== "disconnected";
        let panel = Object.values(shell.panels).find((p) => p.kind === entry.kind && p.owner.restoreRef === restoreRef
          && (p.owner.kind === "background" || usable(p.owner.tabId)));
        let ownerId = panel?.owner.kind !== "background" ? panel?.owner.tabId : undefined;
        if (selection?.kind === "workspace") {
          const previous = openedOwners.current.get(key);
          ownerId = previous?.selection === selectionKey && usable(previous.tabId) ? previous.tabId : undefined;
          panel = ownerId ? Object.values(shell.panels).find((p) => p.kind === entry.kind && p.owner.kind !== "background" && p.owner.tabId === ownerId) : undefined;
        } else if (!ownerId) ownerId = Object.entries(shell.restoreRefByTab).find(([id, ref]) => ref === restoreRef && usable(id))?.[0];
        if (!ownerId && selection?.kind === "session") ownerId = app.tabs.find((tab) => tab.sessionId === selection.id && ["terminal", "sftp"].includes(tab.type) && usable(tab.id))?.id;
        const retryPanelId = panel?.phase === "failed" ? panel.id : undefined;
        if (!panel && !ownerId) {
          const source = shell.layout.restoreSources[entry.restoreRef];
          if (selection?.kind === "workspace" || !selection && source?.kind === "workspace") {
            const recent = selection && app.recentWorkspaces.find((w) => w.id === selection.id);
            const workspace: CodeWorkspaceTabInfo | undefined = recent ? {
              ...recent, repoRoot: recent.roots[0]?.path ?? "", workspaceId: recent.id, workspaceInstanceId: crypto.randomUUID(),
            } : source?.kind === "workspace" ? { ...source.workspace, workspaceInstanceId: source.workspaceInstanceId } : undefined;
            if (!workspace || entry.kind === "sftp") throw chooseOwner();
            const result = await latest.current.openWorkspace(workspace, signal);
            if (!result.tabId || !["ready", "partial"].includes(result.status)) throw new Error(result.error ?? t("shell.missingPanelOwner"));
            ownerId = result.tabId;
          } else {
            const id = selection?.kind === "session" ? selection.id : source?.kind === "run-entry"
              ? useSessionStore.getState().sessions.find((session) => source.identity === `saved:${session.id}`)?.id : undefined;
            if (!id || entry.kind !== "sftp") throw chooseOwner();
            let session: SessionConfig;
            try { session = await latest.current.loadSession(id); } catch { throw chooseOwner(); }
            check();
            if (!["SSH", "SFTP"].includes(session.session_type)) throw chooseOwner();
            const result = await latest.current.openSession(session, { operationId, entryIdentity: `saved:${session.id}` });
            if (!result.tabId || result.status !== "ready") throw new Error(result.issue?.message ?? t("shell.missingPanelOwner"));
            check();
            ownerId = result.tabId;
            shell.bindRestoreSource(ownerId, { kind: "run-entry", identity: `saved:${session.id}` }, useAppStore.getState().tabs.length - 1);
          }
        }
        check();
        app = useAppStore.getState();
        const owner = ownerId ? app.tabs.find((tab) => tab.id === ownerId) : undefined;
        if (ownerId && !owner) throw chooseOwner();
        if (ownerId && selection) openedOwners.current.set(key, { selection: selectionKey, tabId: ownerId });
        if (ownerId) app.setActiveTab(ownerId);
        if (!panel && owner) {
          if (entry.kind === "sftp") {
            if (owner.type === "terminal" && owner.ssh) latest.current.openSftp(owner);
          } else {
            const instance = owner.codeWorkspace?.workspaceInstanceId;
            if (!instance) throw chooseOwner();
            const id = `workspace:${instance}:${entry.kind === "workspace-terminal" ? "terminal" : entry.kind}`;
            await waitShellReady(() => getPanelActions(id), signal);
            getPanelActions(id)?.open?.();
          }
          panel = await waitShellReady(() => Object.values(useShellLayoutStore.getState().panels).find((p) => p.kind === entry.kind && p.owner.kind !== "background" && p.owner.tabId === ownerId), signal);
        }
        if (!panel) throw chooseOwner();
        if (panel.phase === "failed" && panel.id === retryPanelId) {
          const retry = getPanelActions(panel.id)?.retry;
          if (!retry) throw new Error(panel.error?.message ?? t("shell.retry"));
          useShellLayoutStore.getState().patchPanel(panel.id, { phase: "initializing", error: null });
          await retry();
          check();
        }
        if (panel.placement.kind === "primary") app.setActiveTab(panel.placement.tabId);
        const panelId = panel.id;
        useShellLayoutStore.getState().openPanel(panelId);
        await waitShellReady(() => {
          const current = useShellLayoutStore.getState().panels[panelId];
          if (current?.phase === "failed") throw new Error(current.error?.message ?? t("shell.retry"));
          return current?.phase === "ready" ? current : undefined;
        }, signal);
        check();
        if (panel.placement.kind === "detached") await getPanelActions(panelId)?.focus?.();
        const newRef = useShellLayoutStore.getState().panels[panelId]?.owner.restoreRef;
        if (newRef) useShellLayoutStore.getState().updateLayout((layout) => ({ ...layout, recentPanels: [
          { ...entry, restoreRef: newRef, lastUsedAt: Date.now() },
          ...layout.recentPanels.filter((p) => p.kind !== entry.kind || p.restoreRef !== entry.restoreRef && p.restoreRef !== newRef),
        ].slice(0, 20) }));
        return panelId;
      } finally { signal.removeEventListener("abort", cancel); }
    })().finally(() => pending.current.delete(key));
    pending.current.set(key, run);
    return run;
  };
}
