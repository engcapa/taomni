import { useTransferStore, isTransferActive } from "../../stores/transferStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { sftpCancelTransfer } from "../sftp";
import { t } from "../i18n";
import type { CloseAdapter } from "./closeCoordinator";
import type { CloseRisk } from "./types";

export function activeSftpJobs(sessionId: string) { return useTransferStore.getState().items.filter((job) => job.sessionId === sessionId && isTransferActive(job.state)); }
export function waitTransferTerminal(jobId: string, signal: AbortSignal, timeout = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const current = () => useTransferStore.getState().byId(jobId);
    if (!current() || !isTransferActive(current()!.state)) { resolve(); return; }
    const finish = (error?: Error) => { clearTimeout(timer); unsubscribe(); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
    const abort = () => finish(new Error("Transfer cancellation was interrupted"));
    const unsubscribe = useTransferStore.subscribe(() => { if (!current() || !isTransferActive(current()!.state)) finish(); });
    const timer = setTimeout(() => finish(new Error("The transfer has not acknowledged cancellation")), timeout);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export function createSftpCloseAdapter(panelId: string, sessionId: string, ownerId: string): CloseAdapter {
  let handedOff = false;
  return {
    getRisks: async (exit): Promise<CloseRisk[]> => {
      const jobs = activeSftpJobs(sessionId);
      const panel = useShellLayoutStore.getState().panels[panelId];
      if (!exit && ownerId !== panelId && panel?.placement.kind === "primary" && panel.placement.tabId !== ownerId) return [];
      if (!jobs.length || (handedOff && !exit)) return [];
      return [{ kind: "job", id: `${panelId}:jobs`, ownerId, revision: jobs.map((job) => job.id).sort().join(","),
        detail: t("shell.transferCloseRisk", { count: jobs.length }), choices: exit ? ["cancel-job", "cancel"] : ["background", "cancel-job", "cancel"] }];
    },
    resolve: async (_risk, choice, signal) => {
      if (choice === "background") {
        const shell = useShellLayoutStore.getState(), panel = shell.panels[panelId];
        if (!panel) throw new Error("The transfer panel is unavailable");
        shell.patchPanel(panelId, { owner: { kind: "background", resourceKey: `sftp:${sessionId}`, restoreRef: panel.owner.restoreRef }, requestedOpen: false,
          ...(panel.placement.kind === "primary" && panel.placement.tabId === ownerId ? { placement: { kind: "dock" as const, edge: shell.layout.panelDefaults.sftp.edge } } : {}) });
        handedOff = true;
      } else if (choice === "cancel-job") {
        for (const job of activeSftpJobs(sessionId)) { await sftpCancelTransfer(job.id); await waitTransferTerminal(job.id, signal); }
      } else throw new Error("Unsupported transfer close choice");
    },
    flush: async () => {
      const shell = useShellLayoutStore.getState(), panel = shell.panels[panelId];
      if (ownerId !== panelId && panel?.placement.kind === "primary" && panel.placement.tabId !== ownerId) shell.patchPanel(panelId, { owner: { kind: "background", resourceKey: `sftp:${sessionId}`, restoreRef: panel.owner.restoreRef } });
    },
  };
}
