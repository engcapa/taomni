import { X, Trash2, RotateCcw } from "lucide-react";
import { entryDisplayName, entryKindSummary } from "../../lib/welcomeSessionResume";
import { type TranslateFn } from "../../lib/i18n";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import { type WelcomeRestoreProp } from "./types";


export function RestoreLastSessionRow({
  restore,
  translate: t,
}: {
  restore: WelcomeRestoreProp;
  translate: TranslateFn;
}) {
  const { view } = restore;
  const clearConfirm = useConfirmDialog();
  const busy =
    view.state === "restoring" || view.state === "awaiting-auth" || view.state === "loading";
  const disabled =
    view.state === "loading" ||
    view.state === "empty" ||
    view.state === "unavailable" ||
    busy;
  const available = view.state === "available";
  const finished = view.state === "succeeded" || view.state === "partial" || view.state === "failed";
  const canRetry =
    (view.state === "partial" || view.state === "failed") &&
    restore.outcomes.some((o) => o.status === "failed" || o.status === "cancelled");

  const summary = (() => {
    switch (view.state) {
      case "available":
      case "restoring":
      case "awaiting-auth":
      case "succeeded":
      case "partial":
      case "failed": {
        const record = "record" in view ? view.record : null;
        if (!record) return "";
        const kinds = record.entries.map(entryKindSummary);
        const unique = [...new Set(kinds)].join(", ");
        const names = record.entries
          .slice(0, 3)
          .map(entryDisplayName)
          .join(", ");
        const suffix = record.entries.length > 3 ? "…" : "";
        return `${t("welcome.restoreEntryCount", { count: record.entries.length })} · ${unique} · ${names}${suffix}`;
      }
      default:
        return "";
    }
  })();

  const statusText = (() => {
    switch (view.state) {
      case "loading":
        return t("welcome.restoreLoading");
      case "empty":
        return t("welcome.restoreEmpty");
      case "available":
        return view.legacy ? t("welcome.restoreLegacy") : t("welcome.restoreAvailable");
      case "restoring":
        return t("welcome.restoreRunning", {
          completed: view.completed,
          total: view.total,
        });
      case "awaiting-auth":
        return t("welcome.restoreAwaitingAuth");
      case "succeeded":
        return t("welcome.restoreSucceeded", {
          count: restore.outcomes.filter((o) => o.status === "ready").length,
        });
      case "partial":
        return t("welcome.restorePartial", {
          failed: restore.outcomes.filter((o) => o.status === "failed" || o.status === "cancelled").length,
        });
      case "failed":
        return t("welcome.restoreFailed");
      case "unavailable":
        return view.reason === "schema"
          ? t("welcome.restoreIncompatible")
          : t("welcome.restoreStorageError");
    }
  })();

  const confirmClear = async () => {
    const confirmed = await clearConfirm.confirm({
      title: t("welcome.restoreClearTitle"),
      message: t("welcome.restoreClearMessage"),
      confirmLabel: t("welcome.restoreClearConfirm"),
      danger: true,
    });
    if (confirmed) restore.onClearRecord();
  };

  return (
    <div
      data-testid="welcome-restore-row"
      className="mt-4 flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
    >
      <button
        data-testid="welcome-restore-last-session"
        className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
        type="button"
        disabled={disabled}
        aria-busy={view.state === "restoring" || view.state === "awaiting-auth" || undefined}
        aria-live="polite"
        onClick={restore.onStartRestore}
      >
        <RotateCcw className="h-4 w-4" />
        <span>{t("welcome.restoreTitle")}</span>
      </button>
      <div
        data-testid="welcome-restore-status"
        data-state={view.state}
        className="min-w-0 flex-1 text-[12px] text-[var(--taomni-text-muted)]"
        role={view.state === "failed" ? "alert" : "status"}
      >
        <span className="block truncate" title={statusText}>
          {statusText}
          {summary ? <span className="ml-1 opacity-80">{summary}</span> : null}
        </span>
        {view.state === "partial" ? (
          <ul className="mt-1 space-y-0.5">
            {restore.outcomes
              .filter((o) => o.status === "failed" || o.status === "cancelled")
              .map((o) => (
                <li key={o.identity} className="truncate" title={o.issue?.message ?? ""}>
                  · {o.displayName}
                  {o.issue ? ` — ${o.issue.code}` : ""}
                </li>
              ))}
          </ul>
        ) : null}
      </div>
      {view.state === "restoring" || view.state === "awaiting-auth" ? (
        <button
          data-testid="welcome-restore-cancel"
          className="taomni-btn h-8 px-2 inline-flex items-center"
          type="button"
          onClick={restore.onCancelRestore}
        >
          <X className="h-3.5 w-3.5" />
          <span>{t("welcome.restoreCancel")}</span>
        </button>
      ) : null}
      {canRetry ? (
        <button
          data-testid="welcome-restore-retry"
          className="taomni-btn h-8 px-2 inline-flex items-center gap-1"
          type="button"
          onClick={restore.onRetryFailed}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>{t("welcome.restoreRetryFailed")}</span>
        </button>
      ) : null}
      {(available || finished) && (
        <button
          data-testid="welcome-restore-clear"
          className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
          type="button"
          title={t("welcome.restoreClearTitle")}
          aria-label={t("welcome.restoreClearTitle")}
          onClick={() => void confirmClear()}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
      {clearConfirm.render}
    </div>
  );
}
