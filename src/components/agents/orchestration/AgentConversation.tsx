import { FileText } from "lucide-react";
import type { AgentIntent, AgentRun } from "../../../lib/ipc/orchestration";
import { isAgentRunActive } from "../../../stores/orchestrationStore";
import { useOrchT } from "./locales";

interface Props {
  run: AgentRun | null;
  projectName: string;
  pending: boolean;
  onSuggestion: (goal: string, intent: AgentIntent) => void;
  onStart: () => void;
  onStop: () => void;
  onRecover: () => void;
  onArtifact: (id: string) => void;
  onContext: () => void;
}

export function AgentConversation({
  run, projectName, pending, onSuggestion, onStart, onStop, onRecover, onArtifact, onContext,
}: Props) {
  const t = useOrchT();
  if (!run) {
    return (
      <section className="orch-empty-state" data-testid="orch-empty-state">
        <div className="orch-brand-ghost" aria-hidden="true">T</div>
        <p className="orch-eyebrow">TAOMNI AGENT</p>
        <h1>{projectName ? t("startTitle", { project: projectName }) : t("emptyTitle")}</h1>
        <p className="orch-empty-description">{t("emptyDescription")}</p>
        <div className="orch-suggestions">
          <button
            type="button"
            data-testid="orch-suggest-plan"
            onClick={() => onSuggestion(t("architectureGoal"), "plan")}
          >
            {t("architecture")} <span>↗</span>
          </button>
          <button
            type="button"
            data-testid="orch-suggest-develop"
            onClick={() => onSuggestion(t("featureGoal"), "develop")}
          >
            {t("feature")} <span>↗</span>
          </button>
          <button
            type="button"
            data-testid="orch-suggest-review"
            onClick={() => onSuggestion(t("reviewGoal"), "review")}
          >
            {t("review")} <span>↗</span>
          </button>
        </div>
      </section>
    );
  }

  const snapshot = run.settingsSnapshot;
  const resourceName = (id: string) =>
    snapshot.resources.find((resource) => resource.id === id)?.name ?? t("unknown");

  return (
    <section className="orch-messages" data-testid="orch-conversation" data-run-id={run.id}>
      <article className="orch-user-message">
        <span className="orch-message-label">{t("you")}</span><div>{run.goal}</div>
      </article>
      <article className="orch-agent-message">
        <div className="orch-agent-byline">
          <span className="orch-agent-avatar">T</span><strong>Taomni</strong>
          <span className="orch-muted orch-tiny">{t("agent")}</span>
        </div>
        <div className="orch-agent-body">
          <button
            type="button"
            className="orch-quiet orch-context-disclosure"
            data-testid="orch-run-sources"
            onClick={onContext}
          >
            <FileText />{t("context")} · {run.sources.length}
          </button>
          <div className="orch-plan-card" data-testid="orch-plan">
            <div className="orch-plan-heading">
              <strong>{t("developmentPlan")}</strong>
              <span className="orch-subtle-badge" data-testid="orch-run-status" data-status={run.status}>
                {t(`status_${run.status}`)}
              </span>
            </div>
            {run.tasks.length > 0 ? (
              <ol className="orch-plan-list">
                {run.tasks.map((task, index) => (
                  <li key={task.id} data-testid={`orch-step-${task.id}`}>
                    <span className="orch-step-circle">{index + 1}</span>
                    <div>
                      <strong>{task.title}</strong>
                      {task.dependencies.length > 0 && <small>{task.dependencies.join(" · ")}</small>}
                    </div>
                    <span className="orch-step-status">{task.status}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="orch-small-note">{t("noPlanTasks")}</p>}
            <div className="orch-plan-footer">
              <span data-testid="orch-run-snapshot">
                {t("snapshot", { name: snapshot.name, revision: snapshot.revision })}
              </span>
              {run.status === "planned" && (
                <button
                  type="button"
                  data-testid="orch-approve-plan"
                  className="orch-solid compact"
                  disabled={pending}
                  onClick={onStart}
                >
                  {t("approval")}
                </button>
              )}
            </div>
          </div>
          {run.status === "planned" && <p className="orch-small-note">{t("approvalHint")}</p>}
          <details className="orch-execution-details" data-testid="orch-execution-details">
            <summary>{t("execution")}</summary>
            <dl>
              <dt>{t("planningResource")}</dt><dd>{resourceName(snapshot.planningResourceId)}</dd>
              <dt>{t("workers")}</dt>
              <dd>{snapshot.workerResourceIds.map(resourceName).join(" · ") || t("unknown")}</dd>
              <dt>{t("reviewResource")}</dt><dd>{resourceName(snapshot.reviewResourceId)}</dd>
              <dt>{t("shared")}</dt>
              <dd>{t("snapshot", { name: snapshot.name, revision: snapshot.revision })}</dd>
            </dl>
            <p className="orch-small-note">{t("frozenHint")}</p>
          </details>
          {isAgentRunActive(run) && (
            <div className="orch-running-note" role="status" data-testid="orch-running">
              <span className="orch-working-dot" />
              <span>{run.status === "stopping" ? t("stoppingHint") : t(`status_${run.status}`)}</span>
              <span className="orch-fill" />
              <button
                type="button"
                data-testid="orch-cancel-run"
                className="orch-quiet"
                disabled={pending || run.status === "stopping"}
                onClick={onStop}
              >
                {t("stop")}
              </button>
            </div>
          )}
          {run.error && <p data-testid="orch-run-error" role="alert" className="orch-error">{run.error}</p>}
          {run.status === "partial" && (
            <section className="orch-partial-card" data-testid="orch-partial">
              <div className="orch-partial-heading">
                <span className="orch-task-dot amber" /><strong>{t("partial")}</strong>
              </div>
              <p>{t("partialHint")}</p>
              <div className="orch-partial-files">
                {run.artifacts.map((artifact) => (
                  <button
                    type="button"
                    key={artifact.id}
                    className="orch-artifact-link"
                    data-testid={`orch-partial-artifact-${artifact.id}`}
                    onClick={() => onArtifact(artifact.id)}
                  >
                    <FileText />{artifact.name}<span>{artifact.status}</span>
                  </button>
                ))}
              </div>
              <div className="orch-partial-actions">
                <span>{t("noAutomaticApply")}</span>
                {run.recoveryCount === 0 ? (
                  <button
                    type="button"
                    data-testid="orch-recovery-open"
                    className="orch-solid compact"
                    disabled={pending}
                    onClick={onRecover}
                  >
                    {t("recover")}
                  </button>
                ) : <span data-testid="orch-recovery-used">{t("recoveryUsed")}</span>}
              </div>
            </section>
          )}
          <div className="orch-activity" data-testid="orch-events" aria-live="polite">
            {[...run.events].sort((a, b) => a.sequence - b.sequence).map((event) => (
              <p key={event.sequence} data-testid="orch-event" data-sequence={event.sequence}>{event.message}</p>
            ))}
            {!run.events.length && <p className="orch-small-note">{t("noEvents")}</p>}
          </div>
          <p className="orch-closing-note">{t("noAutomaticApply")}</p>
          <p className="orch-small-note">{t("requests", { count: run.requestCount })}</p>
        </div>
      </article>
    </section>
  );
}
