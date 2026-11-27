import { useId } from "react";
import { X, Trash2, RotateCcw } from "lucide-react";
import { entryDisplayName, entryKindSummary } from "../../lib/welcomeSessionResume";
import { type TranslateFn } from "../../lib/i18n";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import { type WelcomeRestoreProp } from "./types";


export function RestoreLastSessionRow({
  restore,
  translate: t,
  redactNames = false,
}: {
  restore: WelcomeRestoreProp;
  translate: TranslateFn;
  redactNames?: boolean;
}) {
  const { view } = restore;
  const statusId = useId();
  const clearConfirm = useConfirmDialog();

  // A fully restored snapshot is no longer a pending action. Keep its outcomes
  // in the controller for diagnostics, but remove the completed banner from Home.
  // Partial/failed results remain visible so retry and error details stay reachable.
  if (view.state === "succeeded") return null;

  const busy = view.state === "restoring" || view.state === "awaiting-auth";
  const available = view.state === "available";
  const finished = view.state === "partial" || view.state === "failed";
  const failures = finished ? restore.outcomes.filter((o) => o.status === "failed" || o.status === "cancelled") : [];

  const summary = (() => {
    switch (view.state) {
      case "available":
      case "restoring":
      case "awaiting-auth":
      case "partial":
      case "failed": {
        const record = "record" in view ? view.record : null;
        if (!record) return "";
        const kinds = record.entries.map(entryKindSummary);
        const unique = [...new Set(kinds)].join(", ");
        const count = t("welcome.restoreEntryCount", { count: record.entries.length });
        if (redactNames) return `${count} · ${unique}`;
        const names = record.entries.slice(0, 3).map(entryDisplayName).join(", ");
        return `${count} · ${unique} · ${names}${record.entries.length > 3 ? "…" : ""}`;
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
      case "partial":
        return t("welcome.restorePartial", {
          failed: failures.length,
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
      className="welcome-restore-row mt-4 flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2"
    >
      <button
        data-testid="welcome-restore-last-session"
        className="taomni-btn h-8 px-3 inline-flex items-center gap-1.5"
        type="button"
        disabled={!available && !finished}
        aria-busy={busy || undefined}
        aria-describedby={statusId}
        onClick={restore.onStartRestore}
      >
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        <span>{t("welcome.restoreTitle")}</span>
      </button>
      <div
        id={statusId}
        data-testid="welcome-restore-status"
        data-state={view.state}
        className="min-w-0 flex-1 text-ui-body text-[var(--taomni-text-muted)]"
        role={view.state === "failed" ? "alert" : "status"}
      >
        <span className="block truncate" title={[statusText, summary].filter(Boolean).join(" · ")}>
          {statusText}
          {summary ? <span className="ml-1"> · {summary}</span> : null}
        </span>
        {failures.length > 0 && !redactNames ? (
          <ul className="mt-1 max-h-20 space-y-0.5 overflow-auto">
            {failures.map((o) => (
              <li key={o.identity} className="truncate" title={o.issue?.message ?? ""}>
                {o.displayName}{o.issue ? ` · ${o.issue.code}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {busy ? (
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
      {failures.length > 0 ? (
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
