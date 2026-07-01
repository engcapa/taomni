import { AlertTriangle, Bell, Bot, Clock, X } from "lucide-react";
import type { TaoAlert, TaoAlertKind } from "../../lib/tao/taoAlerts";
import { useT } from "../../lib/i18n";

interface TaoAlertInboxProps {
  alerts: TaoAlert[];
  onJump: (alert: TaoAlert) => void;
  onAck: (alert: TaoAlert) => void;
  onClose: () => void;
}

function kindIcon(kind: TaoAlertKind) {
  switch (kind) {
    case "ai_done":
      return Bot;
    case "note_overdue":
      return AlertTriangle;
    case "note_due_soon":
      return Clock;
    default:
      return Bell;
  }
}

function kindLabelKey(kind: TaoAlertKind): string {
  switch (kind) {
    case "ai_done":
      return "tao.alertAiDone";
    case "note_overdue":
      return "tao.alertOverdue";
    case "note_due_soon":
      return "tao.alertDueSoon";
    default:
      return "tao.alertReminder";
  }
}

/** A compact list of pending Tao alerts with jump + dismiss actions (§7.3). */
export function TaoAlertInbox({ alerts, onJump, onAck, onClose }: TaoAlertInboxProps) {
  const t = useT();
  return (
    <div
      className="rounded-md border border-[var(--taomni-divider)] shadow-xl overflow-hidden min-w-[220px] max-w-[300px]"
      style={{ background: "var(--taomni-panel-bg)", color: "var(--taomni-text)" }}
      data-testid="tao-alert-inbox"
      role="menu"
    >
      <div className="flex items-center gap-2 px-2 h-7 border-b border-[var(--taomni-divider)]">
        <Bell className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
        <span className="text-[12px] font-semibold flex-1">{t("tao.alertInboxTitle")}</span>
        <button
          type="button"
          className="taomni-btn h-5 w-5 p-0 inline-flex items-center justify-center"
          onClick={onClose}
          aria-label={t("notes.close")}
          data-testid="tao-alert-inbox-close"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      {alerts.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--taomni-text-muted)]">
          {t("tao.alertInboxEmpty")}
        </div>
      ) : (
        <ul className="max-h-64 overflow-y-auto">
          {alerts.map((alert) => {
            const Icon = kindIcon(alert.kind);
            const color =
              alert.kind === "note_overdue"
                ? "text-red-400"
                : alert.kind === "note_due_soon" || alert.kind === "note_reminder"
                  ? "text-amber-400"
                  : "text-[var(--taomni-accent)]";
            return (
              <li key={alert.id} className="border-b border-[var(--taomni-divider)] last:border-b-0">
                <div className="flex items-center gap-1.5 px-2 py-1.5" data-testid="tao-alert-inbox-item">
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${color}`} />
                  <button
                    type="button"
                    className="flex-1 min-w-0 text-left"
                    onClick={() => onJump(alert)}
                    data-testid="tao-alert-jump"
                  >
                    <div className="text-[11px] truncate">{alert.title}</div>
                    <div className="text-[10px] text-[var(--taomni-text-muted)]">{t(kindLabelKey(alert.kind))}</div>
                  </button>
                  <button
                    type="button"
                    className="taomni-btn h-5 w-5 p-0 inline-flex items-center justify-center hover:text-red-400"
                    onClick={() => onAck(alert)}
                    title={t("tao.alertAck")}
                    aria-label={t("tao.alertAck")}
                    data-testid="tao-alert-ack"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
