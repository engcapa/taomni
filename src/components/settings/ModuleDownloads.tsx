import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { isModuleDownloadActive, useModuleDownloadStore } from "../../stores/moduleDownloadStore";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Observing transfers never controls their lifetime. A new native instance
 * discovers safe partials and exposes explicit Resume instead of networking. */
export function ModuleDownloads() {
  const t = useT();
  const { tasks, recoveryErrors, error, errors, busy, loaded, refresh, cancel, resume, forget } = useModuleDownloadStore();
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!closed) timer = setTimeout(() => { void poll(); }, 1000);
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [refresh]);

  return <section data-testid="module-downloads" className="mb-5 rounded-md border border-[var(--taomni-divider)] p-3">
    <h3 className="text-ui-body font-semibold">{t("plugins.downloadsTitle")}</h3>
    <p className="my-2 text-ui-body text-[var(--taomni-text-muted)]">{t("plugins.downloadsHint")}</p>
    {error && <p data-testid="module-downloads-error" role="alert" className="text-ui-body text-ui-danger">{error}</p>}
    {recoveryErrors.map((reason, index) => <p key={index} data-testid="module-download-recovery-error" role="alert" className="text-ui-body text-ui-danger">{reason}</p>)}
    {!loaded && !error && <p>{t("plugins.downloadsLoading")}</p>}
    {loaded && tasks.length === 0 && <p data-testid="module-downloads-empty" className="text-ui-body text-[var(--taomni-text-muted)]">{t("plugins.downloadsEmpty")}</p>}
    <ul className="space-y-3">
      {tasks.map((task) => {
        const { progress } = task;
        const total = progress.total;
        const percent = total && total > 0 ? Math.min(100, progress.downloaded * 100 / total) : null;
        const active = isModuleDownloadActive(task);
        const title = task.completedPath.split(/[/\\]/).pop() ?? task.id;
        return <li key={task.id} data-testid="module-download-task" data-download-id={task.id} data-phase={progress.phase}
          data-downloaded={progress.downloaded} data-total={total ?? "unknown"} data-busy={busy[task.id] === true}
          className="rounded border border-[var(--taomni-divider)] p-2 text-ui-body">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-all font-medium">{title}</span>
            <span data-testid="module-download-phase">{t(`plugins.downloadPhase${progress.phase}`)}</span>
          </div>
          <progress data-testid="module-download-progress" aria-label={title} max={100} value={percent ?? undefined} className="my-2 h-1.5 w-full" />
          <p data-testid="module-download-bytes" className="text-[var(--taomni-text-muted)]">
            {bytes(progress.downloaded)}{total != null ? ` / ${bytes(total)}` : ""}{percent !== null ? ` · ${percent.toFixed(1)}%` : ""}
          </p>
          {(progress.error || errors[task.id]) && <p data-testid="module-download-error" role="alert" className="my-2 break-words text-ui-danger">{errors[task.id] || progress.error}</p>}
          <div className="mt-2 flex gap-2">
            {active ? <button type="button" data-testid="module-download-cancel" className="taomni-btn" disabled={busy[task.id]}
              onClick={() => { void cancel(task.id); }}>{t("plugins.downloadCancel")}</button>
              : progress.phase !== "completed" && <button type="button" data-testid="module-download-resume" className="taomni-btn" disabled={busy[task.id]}
                onClick={() => { void resume(task.id); }}>{t("plugins.downloadResume")}</button>}
            {!active && <button type="button" data-testid="module-download-forget" className="taomni-btn" disabled={busy[task.id]}
              onClick={() => { void forget(task.id); }}>{t("plugins.downloadForget")}</button>}
          </div>
        </li>;
      })}
    </ul>
  </section>;
}
