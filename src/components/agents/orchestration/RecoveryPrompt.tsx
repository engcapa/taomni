import { useState } from "react";
import type { AgentRun } from "../../../lib/ipc/orchestration";
import { useOrchestrationStore } from "../../../stores/orchestrationStore";
import { OrchestrationDialog } from "./OrchestrationDialog";
import { useOrchT } from "./locales";

export function RecoveryPrompt({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const t = useOrchT();
  const pending = useOrchestrationStore((state) => state.pending);
  const [error, setError] = useState<string | null>(null);
  const resource = run.settingsSnapshot.resources.find((entry) => entry.id === run.settingsSnapshot.planningResourceId);
  const confirm = async () => {
    if (pending || run.status !== "partial" || run.recoveryCount > 0) return;
    setError(null);
    try { await useOrchestrationStore.getState().recover(run.id); onClose(); }
    catch (reason) { setError(String(reason)); }
  };
  return <OrchestrationDialog testId="orch-recovery-dialog" title={t("recoveryTitle")} className="orch-recovery-dialog" onClose={onClose}>
    <h2>{t("recoveryTitle")}</h2><p>{t("recoveryHint")}</p>
    <div className="orch-recovery-summary"><span>{t("recoveryResource")}</span><strong>{resource?.name ?? t("unknown")}</strong>
      <span>{t("shared")}</span><strong>{t("snapshot", { name: run.settingsSnapshot.name, revision: run.settingsSnapshot.revision })}</strong>
      <span>{t("extraCalls")}</span><strong>{t("oneCall")}</strong>
    </div>
    <p className="orch-small-note">{t("costUnknown", { coefficient: resource?.costCoefficient ?? t("unknown") })}</p>
    {error && <p data-testid="orch-recovery-error" role="alert" className="orch-error">{error}</p>}
    <div className="orch-dialog-actions"><button type="button" data-testid="orch-recovery-dismiss" className="orch-outline" onClick={onClose}>{t("later")}</button>
      <button type="button" data-testid="orch-recovery-confirm" className="orch-solid" disabled={!!pending || run.status !== "partial" || run.recoveryCount > 0} onClick={() => { void confirm(); }}>{t("allowRecovery")}</button>
    </div>
  </OrchestrationDialog>;
}
