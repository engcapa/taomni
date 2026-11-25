import { useT } from "../../../lib/i18n";
import { clonePhaseTitleKey } from "../../../lib/gitClone";
import type { GitCloneTask } from "../../../stores/gitCloneStore";
import { GitCloneProgressBar } from "./GitCloneProgressBar";

export interface GitCloneProgressViewProps {
  task: GitCloneTask;
}

export function GitCloneProgressView({ task }: GitCloneProgressViewProps) {
  const t = useT();
  const active = !["completed", "failed", "cancelled"].includes(task.phase);
  const objects = task.objectsDone !== null && task.objectsTotal !== null
    ? t("gitClone.objects", { done: task.objectsDone, total: task.objectsTotal })
    : null;
  return (
    <div data-testid="workspace-git-clone-progress" data-phase={task.phase} className="space-y-4">
      <div className="space-y-1 text-ui-small text-[var(--taomni-text-muted)]">
        <p className="truncate" title={task.request.url}>
          <span className="font-semibold">{t("gitClone.url")}: </span>
          <code className="taomni-mono">{task.request.url}</code>
        </p>
        <p className="truncate" title={task.request.destination}>
          <span className="font-semibold">{t("gitClone.destination")}: </span>
          <code className="taomni-mono">{task.request.destination}</code>
        </p>
      </div>
      <div className="rounded-lg border p-3" style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}>
        <div className="flex items-center justify-between gap-2">
          <strong data-testid="workspace-git-clone-phase" className="text-ui-body text-[var(--taomni-text)]">
            {t(clonePhaseTitleKey(task.phase))}
          </strong>
          {task.percent !== null && (
            <span data-testid="workspace-git-clone-percent" className="taomni-mono text-ui-body text-[var(--taomni-accent)]">
              {t("gitClone.overallPercent", { percent: Math.round(task.percent) })}
            </span>
          )}
        </div>
        <GitCloneProgressBar
          percent={task.percent}
          indeterminate={task.indeterminate || active && task.percent === null}
        />
        {objects && (
          <p data-testid="workspace-git-clone-objects" className="mt-1 taomni-mono text-ui-small text-[var(--taomni-text-muted)]">
            {objects}
          </p>
        )}
        {task.message && (
          <p data-testid="workspace-git-clone-message" className="mt-1 break-words taomni-mono text-ui-small text-[var(--taomni-text-muted)]">
            {task.message}
          </p>
        )}
      </div>

      {active && (
        <p data-testid="workspace-git-clone-background-hint" className="rounded border px-3 py-2 text-ui-small"
          style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-panel-bg)", color: "var(--taomni-text-muted)" }}>
          {t("gitClone.backgroundHint")}
        </p>
      )}

      {task.phase === "completed" && task.result && (
        <div data-testid="workspace-git-clone-success" className="rounded-lg border p-3 text-ui-body"
          style={{ borderColor: "var(--taomni-success-icon, #10b981)", background: "var(--taomni-card-bg)" }}>
          <strong className="block text-[var(--taomni-text)]">{t("gitClone.successTitle")}</strong>
          <code className="taomni-mono mt-1 block break-all text-ui-small text-[var(--taomni-text-muted)]">{task.result.repoRoot}</code>
          {task.result.branch && (
            <p className="mt-1 text-ui-small text-[var(--taomni-text-muted)]">
              {t("gitClone.successBranch", { branch: task.result.branch })}
            </p>
          )}
          {task.result.tokenRemembered && (
            <p data-testid="workspace-git-clone-token-saved" className="mt-1 text-ui-small text-[var(--taomni-text-muted)]">
              {t("gitClone.tokenSaved")}
            </p>
          )}
        </div>
      )}

      {task.phase === "cancelled" && (
        <p data-testid="workspace-git-clone-cancelled" role="status" className="text-ui-body text-[var(--taomni-text-muted)]">
          {t("gitClone.cancelledHint")}
        </p>
      )}

      {task.phase === "failed" && task.error && (
        <div data-testid="workspace-git-clone-error" role="alert" className="rounded-lg border p-3"
          style={{ borderColor: "var(--taomni-danger, #ef4444)", background: "var(--taomni-card-bg)" }}>
          <strong className="block text-ui-body text-ui-danger">{t("gitClone.failed")}</strong>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words taomni-mono text-ui-small text-[var(--taomni-text-muted)]">{task.error}</pre>
        </div>
      )}
    </div>
  );
}
