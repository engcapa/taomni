import { useEffect, useMemo } from "react";
import { useNotesStore } from "../../stores/notesStore";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { useAppStore } from "../../stores/appStore";
import { buildTaoAlerts } from "../../lib/tao/taoAlerts";

const POLL_INTERVAL_MS = 60_000;

/**
 * Drives periodic refresh of note due/overdue/reminder alerts while the app is
 * running (§10.1). Mounted once at the app root; renders nothing. The backend
 * reconciles alert state, so this simply re-pulls on an interval (and once on
 * mount) to keep the permanent Tao entry and history current even before opening it.
 */
export function TaoAlertPoller() {
  const refreshAlerts = useNotesStore((s) => s.refreshAlerts);
  const notes = useNotesStore((s) => s.alerts), alerts = useTaoAlertStore(), tabs = useAppStore((s) => s.tabs);
  const pending = useMemo(() => buildTaoAlerts(notes, alerts.aiDone, alerts.mailNew, alerts.transfer), [notes, alerts.aiDone, alerts.mailNew, alerts.transfer]);
  useEffect(() => { alerts.recordHistory(pending); }, [pending, alerts.recordHistory]);
  useEffect(() => { alerts.pruneMailTabs(tabs.map((tab) => tab.id)); }, [tabs, alerts.pruneMailTabs]);

  useEffect(() => {
    void refreshAlerts();
    const id = window.setInterval(() => void refreshAlerts(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshAlerts]);

  return null;
}
