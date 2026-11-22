import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { SOCKSCAP_RECOVERY_STATUS_EVENT, sockscapStatus, type SocksCapStatus } from "../sockscap";

export function useRecoveryStatus() {
  const [pending, setPending] = useState<SocksCapStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      const request = ++sequence;
      const status = await sockscapStatus().catch(() => undefined);
      if (status && !disposed && request === sequence) {
        setPending(status.phase === "recoveryRequired" ? status : null);
      }
    };
    void listen(SOCKSCAP_RECOVERY_STATUS_EVENT, () => void refresh())
      .then((release) => {
        if (disposed) {
          release();
          return;
        }
        unlisten = release;
        // Read after registering so boot recovery cannot be missed.
        void refresh();
      })
      .catch(() => void refresh());
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return pending;
}
