import { useEffect, useRef, type ReactNode } from "react";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useTransferStore } from "../../stores/transferStore";
import { useShellLayoutStore, panelVisibility } from "../../stores/shellLayoutStore";
import type { PanelPlacement } from "../../lib/shell/types";
import { registerCloseAdapter, registerCloseTarget, requestTabClose } from "../../lib/shell/closeCoordinator";
import { activeSftpJobs, createSftpCloseAdapter } from "../../lib/shell/sftpShellAdapter";
import { registerPanelActions } from "../../lib/shell/panelActions";
import { StableSurface } from "./SurfaceSlot";
import { shellResourceLeases } from "../../lib/shell/panelRegistry";
import { focusSftpPanelWindow, reattachSftpPanel } from "../../lib/shell/sftpPanelWindow";

export function SftpShellSurface({ id, tabId, sessionId, title, children, onDetach, initialPlacement }: { id: string; tabId: string; sessionId: string; title: string; children: ReactNode; onDetach(): void; initialPlacement?: PanelPlacement }) {
  const shell = useShellLayoutStore(), activeTabId = useAppStore((s) => s.activeTabId);
  const panel = shell.panels[id];
  const detachRef = useRef(onDetach); detachRef.current = onDetach;
  const titleRef = useRef(title); titleRef.current = title;
  const connection = useSftpStore((s) => s.sessions[sessionId]);
  useEffect(() => {
    const s = useShellLayoutStore.getState();
    if (initialPlacement && !s.panels[id]) s.registerPanel({ id, kind: "sftp", owner: { kind: "tab", tabId, restoreRef: s.restoreRefByTab[tabId] }, generation: 1, phase: "initializing", requestedOpen: true, pinned: true, placement: initialPlacement, operation: null, error: null });
  }, [id, tabId]);
  useEffect(() => shellResourceLeases.acquire(`sftp:${sessionId}`, id, "view"), [sessionId, id]);
  useEffect(() => {
    const collect = () => {
      const s = useShellLayoutStore.getState(), current = s.panels[id];
      if (current?.owner.kind === "background" && current.placement.kind === "dock" && !current.requestedOpen && !activeSftpJobs(sessionId).length)
        s.removePanel(id);
    };
    const offJobs = useTransferStore.subscribe(collect), offPanels = useShellLayoutStore.subscribe(collect);
    return () => { offJobs(); offPanels(); };
  }, [id, sessionId]);
  useEffect(() => {
    if (!connection) return;
    const phase = connection.error ? "failed" : connection.attached ? "ready" : "initializing";
    const current = useShellLayoutStore.getState().panels[id];
    if (current && current.phase !== phase) useShellLayoutStore.getState().patchPanel(id, { phase, error: connection.error ? { code: "sftp", message: connection.error, retryable: true } : null });
  }, [connection, id]);
  useEffect(() => {
    const adapter = createSftpCloseAdapter(id, sessionId, tabId);
    const offClose = registerCloseAdapter(tabId, adapter);
    const panelAdapter = createSftpCloseAdapter(id, sessionId, id);
    const offPanelAdapter = registerCloseAdapter(id, panelAdapter);
    const offTarget = registerCloseTarget(id, () => ({ id, title: titleRef.current, adapter: createSftpCloseAdapter(id, sessionId, id), commit: () => {
      if (activeSftpJobs(sessionId).length) useShellLayoutStore.getState().hidePanel(id);
      else useShellLayoutStore.getState().removePanel(id);
    } }));
    const offActions = registerPanelActions(id, {
      promote: () => { const s = useShellLayoutStore.getState(), panel = s.panels[id]; if (!panel) return;
        if (panel.placement.kind === "primary") { useAppStore.getState().setActiveTab(panel.placement.tabId); return; }
        const promotedId = `shell-primary:${id}`;
        useAppStore.getState().addTab({ id: promotedId, type: "sftp", title: titleRef.current, closable: true, shellPanelId: id });
        s.patchPanel(id, { placement: { kind: "primary", tabId: promotedId }, requestedOpen: true });
      },
      detach: () => detachRef.current(),
      focus: () => focusSftpPanelWindow(id),
      reattach: () => reattachSftpPanel(id),
      close: async () => { await requestTabClose([id]); },
      retry: () => useSftpStore.getState().reconnect(sessionId),
    });
    return () => { offClose(); offActions(); offTarget(); offPanelAdapter(); };
  }, [id, tabId, sessionId]);
  if (!panel) return null;
  const visibility = panelVisibility(panel, activeTabId, shell.taoOpen, shell.layout.tao.edge);
  const slot = panel.placement.kind === "primary" ? `primary:${panel.placement.tabId}` : visibility === "visible" ? `panel:${id}` : "parking";
  return <StableSurface id={id} slot={slot} visible={visibility === "visible"}>{children}</StableSurface>;
}
