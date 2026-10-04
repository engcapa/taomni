import { listenSftpComplete, listenSftpPaused, listenSftpProgress } from "./sftp";
import { useTransferStore } from "../stores/transferStore";
import { useSftpStore, type PaneSide } from "../stores/sftpStore";
import { useAppStore } from "../stores/appStore";

const tracking = new Map<string, Promise<void>>();
export function trackSftpTransfer(transferId: string, sessionId: string, refreshSide?: PaneSide): Promise<void> {
  const existing = tracking.get(transferId);
  if (existing) return existing;
  const run = (async () => {
    let finished = false;
    const off: Array<() => void> = [];
    const cleanup = () => { finished = true; for (const unlisten of off) unlisten(); tracking.delete(transferId); };
    const results = await Promise.allSettled([
      listenSftpProgress(transferId, (payload) => useTransferStore.getState().patch(transferId, { bytes: payload.bytes, size: payload.total || undefined, rate: payload.rate, eta: payload.eta, state: "running" })),
      listenSftpPaused(transferId, (payload) => useTransferStore.getState().patch(transferId, { bytes: payload.bytes, rate: 0, eta: 0, state: "paused" })),
      listenSftpComplete(transferId, (payload) => {
        const store = useTransferStore.getState();
        if (payload.success) {
          store.setState(transferId, "done");
          useAppStore.getState().setStatusMessage(`Transfer complete: ${transferId}`);
          if (refreshSide && useSftpStore.getState().sessions[sessionId]) void useSftpStore.getState().refreshPane(sessionId, refreshSide);
        } else store.setState(transferId, (payload.error ?? "").toLowerCase().includes("cancel") ? "cancelled" : "error", payload.error ?? "transfer failed");
        cleanup();
      }),
    ]);
    for (const result of results) if (result.status === "fulfilled") off.push(result.value);
    const failure = results.find((result) => result.status === "rejected");
    if (finished || failure) cleanup();
    if (failure?.status === "rejected") throw failure.reason;
  })();
  tracking.set(transferId, run);
  void run.catch(() => { tracking.delete(transferId); });
  return run;
}
