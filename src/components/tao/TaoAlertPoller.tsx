import { useEffect } from "react";
import { useNotesStore } from "../../stores/notesStore";

const POLL_INTERVAL_MS = 60_000;

/**
 * Drives periodic refresh of note due/overdue/reminder alerts while the app is
 * running (§10.1). Mounted once at the app root; renders nothing. The backend
 * reconciles alert state, so this simply re-pulls on an interval (and once on
 * mount) to keep the Tao Ribbon badge current.
 */
export function TaoAlertPoller() {
  const refreshAlerts = useNotesStore((s) => s.refreshAlerts);

  useEffect(() => {
    void refreshAlerts();
    const id = window.setInterval(() => void refreshAlerts(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshAlerts]);

  return null;
}
