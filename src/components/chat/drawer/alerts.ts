import { useEffect, useMemo } from "react";
import { useAppStore } from "../../../stores/appStore";
import { useNotesStore } from "../../../stores/notesStore";
import { useTaoAlertStore } from "../../../stores/taoAlertStore";
import { buildTaoAlerts, type TaoAlert } from "../../../lib/tao/taoAlerts";

export interface UseChatDrawerAlertsContext {
  setHubTab: (tab: import("../../../stores/taoHubStore").TaoHubTab) => void;
  setActiveAppTab: (id: string) => void;
  setActiveThread: (threadId: string | null) => void;
}

export function useChatDrawerAlerts(context: UseChatDrawerAlertsContext) {
  const { setHubTab, setActiveAppTab, setActiveThread } = context;
  const noteAlerts = useNotesStore((s) => s.alerts);
  const setActiveNote = useNotesStore((s) => s.setActiveNote);
  const ackNoteAlert = useNotesStore((s) => s.ackAlert);
  const aiDoneAlerts = useTaoAlertStore((s) => s.aiDone);
  const mailNewAlerts = useTaoAlertStore((s) => s.mailNew);
  const alertHistory = useTaoAlertStore((s) => s.history);
  const alertHistoryLimit = useTaoAlertStore((s) => s.historyLimit);
  const recordAlertHistory = useTaoAlertStore((s) => s.recordHistory);
  const setAlertHistoryLimit = useTaoAlertStore((s) => s.setHistoryLimit);
  const clearAlertHistory = useTaoAlertStore((s) => s.clearHistory);
  const ackAiDone = useTaoAlertStore((s) => s.ack);
  const clearMailTab = useTaoAlertStore((s) => s.clearMailTab);
  const taoAlerts = useMemo(
    () => buildTaoAlerts(noteAlerts, aiDoneAlerts, mailNewAlerts),
    [noteAlerts, aiDoneAlerts, mailNewAlerts],
  );
  const alertBadgeCount = useMemo(
    () => taoAlerts.reduce((sum, alert) => sum + (alert.count ?? 1), 0),
    [taoAlerts],
  );
  useEffect(() => {
    recordAlertHistory(taoAlerts);
  }, [recordAlertHistory, taoAlerts]);

  const jumpToAlert = (alert: TaoAlert) => {
    if (alert.source === "notes") {
      setHubTab("notes");
      if (alert.noteId) setActiveNote(alert.noteId);
      const rawId = alert.id.startsWith("note:") ? alert.id.slice("note:".length) : alert.id;
      void ackNoteAlert(rawId);
      return;
    }
    if (alert.source === "mail") {
      const tabId = alert.mailTabId;
      if (tabId && useAppStore.getState().tabs.some((tab) => tab.id === tabId)) {
        setActiveAppTab(tabId);
        clearMailTab(tabId);
      }
      return;
    }
    setHubTab("chat");
    if (alert.threadId) setActiveThread(alert.threadId);
    ackAiDone(alert.id);
  };

  const ackAlert = (alert: TaoAlert) => {
    if (alert.source === "notes") {
      const rawId = alert.id.startsWith("note:") ? alert.id.slice("note:".length) : alert.id;
      void ackNoteAlert(rawId);
      return;
    }
    if (alert.source === "mail") {
      if (alert.mailTabId) clearMailTab(alert.mailTabId);
      return;
    }
    ackAiDone(alert.id);
  };
  return { alertBadgeCount, taoAlerts, alertHistory, alertHistoryLimit, jumpToAlert, ackAlert, setAlertHistoryLimit, clearAlertHistory };
}
