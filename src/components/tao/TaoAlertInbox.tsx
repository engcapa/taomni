import { useMemo, useState } from "react";
import { AlertTriangle, Bell, Bot, Clock, Mail, Search, Trash2, X } from "lucide-react";
import type { TaoAlert, TaoAlertKind } from "../../lib/tao/taoAlerts";
import { useT, type TranslateFn } from "../../lib/i18n";
import {
  taoAlertHistoryKey,
  type TaoAlertHistoryEntry,
  type TaoAlertHistoryLimit,
} from "../../stores/taoAlertStore";

interface TaoAlertInboxProps {
  alerts: TaoAlert[];
  history?: TaoAlertHistoryEntry[];
  historyLimit?: TaoAlertHistoryLimit;
  onJump: (alert: TaoAlert) => void;
  onAck: (alert: TaoAlert) => void;
  onHistoryLimitChange?: (limit: TaoAlertHistoryLimit) => void;
  onClearHistory?: () => void;
  onClose?: () => void;
  embedded?: boolean;
}

function kindIcon(kind: TaoAlertKind) {
  switch (kind) {
    case "ai_done":
      return Bot;
    case "note_overdue":
      return AlertTriangle;
    case "note_due_soon":
      return Clock;
    case "mail_new":
      return Mail;
    default:
      return Bell;
  }
}

function alertSubtitle(alert: TaoAlert, t: TranslateFn): string {
  if (alert.kind === "mail_new") {
    return t("tao.alertMailNewCount", { count: alert.count ?? 1 });
  }
  switch (alert.kind) {
    case "ai_done":
      return t("tao.alertAiDone");
    case "note_overdue":
      return t("tao.alertOverdue");
    case "note_due_soon":
      return t("tao.alertDueSoon");
    default:
      return t("tao.alertReminder");
  }
}

function sourceLabel(alert: TaoAlert, t: TranslateFn): string {
  switch (alert.source) {
    case "chat":
      return t("tao.tabChat");
    case "notes":
      return t("tao.tabNotes");
    case "mail":
      return t("tao.alertSourceMail");
  }
}

function formatHistoryTime(secs: number): string {
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** A compact list of pending Tao alerts with jump + dismiss actions (§7.3). */
export function TaoAlertInbox({
  alerts,
  history = [],
  historyLimit = 300,
  onJump,
  onAck,
  onHistoryLimitChange,
  onClearHistory,
  onClose,
  embedded = false,
}: TaoAlertInboxProps) {
  const t = useT();
  const [historyQuery, setHistoryQuery] = useState("");
  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase();
  const pendingHistoryIds = useMemo(
    () => new Set(alerts.map((alert) => taoAlertHistoryKey(alert))),
    [alerts],
  );
  const historyResults = useMemo(() => {
    if (!normalizedHistoryQuery) return [];
    return history
      .filter((entry) => !pendingHistoryIds.has(entry.historyId))
      .filter((entry) => {
        const haystack = [
          entry.title,
          entry.kind,
          entry.source,
          alertSubtitle(entry, t),
          sourceLabel(entry, t),
        ].join(" ").toLocaleLowerCase();
        return haystack.includes(normalizedHistoryQuery);
      });
  }, [history, normalizedHistoryQuery, pendingHistoryIds, t]);
  const canClearHistory = history.length > 0 && !!onClearHistory;
  return (
    <div
      className={
        embedded
          ? "h-full min-w-0 overflow-hidden flex flex-col"
          : "rounded-md border border-[var(--taomni-divider)] shadow-xl overflow-hidden min-w-[220px] max-w-[300px]"
      }
      style={{ background: "var(--taomni-panel-bg)", color: "var(--taomni-text)" }}
      data-testid="tao-alert-inbox"
      role="menu"
    >
      <div className="flex items-center gap-2 px-2 h-7 border-b border-[var(--taomni-divider)] shrink-0">
        <Bell className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
        <span className="text-[12px] font-semibold flex-1">{t("tao.alertInboxTitle")}</span>
        {onClose && (
          <button
            type="button"
            className="taomni-btn h-5 w-5 p-0 inline-flex items-center justify-center"
            onClick={onClose}
            aria-label={t("notes.close")}
            data-testid="tao-alert-inbox-close"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {alerts.length === 0 ? (
        <div className="px-3 py-4 text-center text-[11px] text-[var(--taomni-text-muted)]">
          {t("tao.alertInboxEmpty")}
        </div>
      ) : (
        <ul className={embedded ? "flex-1 min-h-0 overflow-y-auto" : "max-h-64 overflow-y-auto"}>
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
                    <div className="text-[10px] text-[var(--taomni-text-muted)]">{alertSubtitle(alert, t)}</div>
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
      <div className="border-t border-[var(--taomni-divider)] shrink-0 px-2 py-2 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <label className="relative flex-1 min-w-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
            <input
              type="search"
              className="taomni-input h-7 w-full pl-7 pr-2 text-[11px]"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.currentTarget.value)}
              placeholder={t("tao.alertHistorySearchPlaceholder")}
              aria-label={t("tao.alertHistorySearchAria")}
              data-testid="tao-alert-history-search"
            />
          </label>
          <div
            className="inline-flex h-7 overflow-hidden rounded border border-[var(--taomni-divider)] shrink-0"
            aria-label={t("tao.alertHistoryLimit")}
          >
            {([30, 300] as TaoAlertHistoryLimit[]).map((limit) => (
              <button
                key={limit}
                type="button"
                className={`w-8 text-[10px] ${
                  historyLimit === limit
                    ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)]"
                    : "hover:bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"
                }`}
                onClick={() => onHistoryLimitChange?.(limit)}
                title={t("tao.alertHistoryLimitTitle", { limit })}
                aria-pressed={historyLimit === limit}
                data-testid={`tao-alert-history-limit-${limit}`}
              >
                {limit}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
            onClick={onClearHistory}
            disabled={!canClearHistory}
            title={t("tao.alertHistoryClear")}
            aria-label={t("tao.alertHistoryClear")}
            data-testid="tao-alert-history-clear"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {normalizedHistoryQuery ? (
          historyResults.length === 0 ? (
            <div className="py-2 text-center text-[10.5px] text-[var(--taomni-text-muted)]">
              {t("tao.alertHistoryEmpty")}
            </div>
          ) : (
            <ul className="max-h-36 overflow-y-auto rounded border border-[var(--taomni-divider)]">
              {historyResults.map((entry) => {
                const Icon = kindIcon(entry.kind);
                return (
                  <li
                    key={entry.historyId}
                    className="flex items-center gap-1.5 border-b border-[var(--taomni-divider)] px-2 py-1.5 last:border-b-0"
                    data-testid="tao-alert-history-result"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px]">{entry.title}</div>
                      <div className="truncate text-[10px] text-[var(--taomni-text-muted)]">
                        {alertSubtitle(entry, t)} - {sourceLabel(entry, t)} - {formatHistoryTime(entry.lastSeenAt)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <div className="text-[10px] text-[var(--taomni-text-muted)]">
            {t("tao.alertHistoryHiddenHint", { count: history.length, limit: historyLimit })}
          </div>
        )}
      </div>
    </div>
  );
}
