import type { ShellResumeState } from "../../hooks/useShellResumeComposer";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import { useT } from "../../lib/i18n";

export function ShellResumeRow({ resume }: { resume: ShellResumeState }) {
  const t = useT(), confirm = useConfirmDialog();
  const busy = ["loading", "restoring", "awaiting-auth"].includes(resume.state);
  return <div data-testid="shell-restore-row" className="mt-4 rounded border p-3 text-xs">
    <div className="flex items-center gap-2 flex-wrap">
      <button data-testid="welcome-restore-last-session" className="taomni-button" disabled={busy || !resume.total} aria-busy={busy} onClick={() => void resume.start()}>{t("shell.restoreWorkingSet")}</button>
      <span data-testid="welcome-restore-status" data-state={resume.state} role="status">{t(`shell.restoreStates.${resume.state}`)} · {resume.outcomes.length}/{resume.total}</span>
      {busy && resume.state !== "loading" && <button data-testid="welcome-restore-cancel" onClick={resume.cancel}>{t("common.cancel")}</button>}
      {!busy && resume.outcomes.some((o) => ["failed", "cancelled"].includes(o.status)) && <button data-testid="welcome-restore-retry" onClick={() => void resume.retry()}>{t("shell.retry")}</button>}
      {!busy && resume.error && <button data-testid="shell-restore-refresh" onClick={resume.refresh}>{t("common.refresh")}</button>}
      {!busy && !!resume.total && <button data-testid="welcome-restore-clear" onClick={async () => {
        if (await confirm.confirm({ title: t("welcome.restoreClearTitle"), message: t("welcome.restoreClearMessage"), danger: true })) await resume.clear();
      }}>{t("welcome.restoreClearConfirm")}</button>}
    </div>
    {resume.error && <p role="alert" data-testid="shell-restore-error">{resume.error}</p>}
    <ul>{resume.outcomes.map((outcome) => <li key={outcome.identity} data-testid="shell-restore-entry" data-entry-id={outcome.identity} data-status={outcome.status} data-tab-id={outcome.tabId ?? ""}>{outcome.name} · {t(`shell.restoreStates.${outcome.status === "ready" ? "succeeded" : outcome.status}`)} {outcome.error}</li>)}</ul>
    {confirm.render}
  </div>;
}
