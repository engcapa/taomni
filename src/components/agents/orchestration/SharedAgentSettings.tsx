import { Link, Plus, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentResource, AgentSettings } from "../../../lib/ipc/orchestration";
import { useAiStore } from "../../../stores/aiStore";
import { useOrchestrationStore } from "../../../stores/orchestrationStore";
import { OrchestrationDialog } from "./OrchestrationDialog";
import { ResourceEditor, SettingsField } from "./ResourceEditor";
import { hasValidAgentSettings, newAgentResource } from "./settingsModel";
import { useOrchT } from "./locales";

interface Props {
  settings: AgentSettings | null;
  onClose: () => void;
}

export function SharedAgentSettings({ settings, onClose }: Props) {
  const t = useOrchT();
  const saving = useOrchestrationStore((state) => state.saving);
  const [draft, setDraft] = useState<AgentSettings | null>(() => settings ? structuredClone(settings) : null);
  const [tab, setTab] = useState<"defaults" | "resources">("defaults");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!useAiStore.getState().config && !useAiStore.getState().loading) {
      void useAiStore.getState().loadConfig();
    }
  }, []);
  // A late initial load may initialize the draft, but never replaces unsaved edits.
  useEffect(() => {
    if (settings) setDraft((current) => current ?? structuredClone(settings));
  }, [settings]);

  const patch = (update: Partial<AgentSettings>) =>
    setDraft((current) => current ? { ...current, ...update } : current);
  const editResource = (update: Partial<AgentResource>) => {
    if (!draft) return;
    const resources = draft.resources.map((resource) =>
      resource.id === editingId ? { ...resource, ...update } : resource,
    );
    patch({
      resources,
      workerResourceIds: draft.workerResourceIds.filter((id) =>
        resources.some((resource) => resource.id === id && resource.kind === "worker"),
      ),
    });
  };
  const removeResource = () => {
    if (!draft) return;
    patch({
      resources: draft.resources.filter((resource) => resource.id !== editingId),
      planningResourceId: draft.planningResourceId === editingId ? "" : draft.planningResourceId,
      reviewResourceId: draft.reviewResourceId === editingId ? "" : draft.reviewResourceId,
      workerResourceIds: draft.workerResourceIds.filter((id) => id !== editingId),
    });
    setEditingId(null);
  };
  const save = async () => {
    if (!draft || saving) return;
    if (!hasValidAgentSettings(draft)) { setError(t("invalidSettings")); return; }
    setError(null);
    try {
      await useOrchestrationStore.getState().saveSettings(draft);
      onClose();
    } catch (reason) { setError(String(reason)); }
  };
  const close = () => { if (!saving) onClose(); };
  const editingResource = draft?.resources.find((resource) => resource.id === editingId);
  const options = draft?.resources.map((resource) => (
    <option key={resource.id} value={resource.id}>{resource.name}</option>
  ));

  return (
    <OrchestrationDialog
      testId="orch-settings-dialog"
      title={t("settingsTitle")}
      className="orch-settings-dialog"
      onClose={close}
    >
      <div className="orch-settings-header">
        <div><h2>{t("settingsTitle")}</h2><p>{t("settingsSubtitle")}</p></div>
        <span className="orch-fill" />
        <button
          type="button"
          data-testid="orch-settings-close"
          className="orch-icon-button"
          aria-label={t("close")}
          disabled={saving}
          onClick={close}
        >
          <X />
        </button>
      </div>
      <div className="orch-settings-layout">
        <nav className="orch-settings-nav" aria-label={t("settingsTitle")}>
          <button
            type="button"
            data-testid="orch-settings-defaults"
            className={`orch-settings-tab ${tab === "defaults" ? "active" : ""}`}
            onClick={() => setTab("defaults")}
          >
            <Settings />{t("defaults")}
          </button>
          <button
            type="button"
            data-testid="orch-settings-resources"
            className={`orch-settings-tab ${tab === "resources" ? "active" : ""}`}
            onClick={() => setTab("resources")}
          >
            <Link />{t("resources")}
          </button>
          <p>{t("settingsScope")}</p>
        </nav>
        <fieldset disabled={saving} className="orch-settings-body">
          {!draft ? (
            <div>
              <p>{t("settingsUnavailable")}</p>
              <button
                type="button"
                className="orch-outline"
                data-testid="orch-settings-retry"
                onClick={() => { void useOrchestrationStore.getState().load(); }}
              >
                {t("retry")}
              </button>
            </div>
          ) : tab === "defaults" ? (
            <section>
              <div className="orch-settings-section-heading">
                <h3>{draft.name || t("defaults")}</h3>
                <span className="orch-subtle-badge">{t("revision", { revision: draft.revision })}</span>
              </div>
              <p className="orch-settings-description">{t("defaultsDescription")}</p>
              <SettingsField name="plan-name" label={t("planName")}>
                <input
                  id="orch-plan-name"
                  data-testid="orch-plan-name"
                  maxLength={80}
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </SettingsField>
              <SettingsField name="planning-resource" label={t("planningResource")}>
                <select
                  id="orch-planning-resource"
                  data-testid="orch-planning-resource"
                  value={draft.planningResourceId}
                  onChange={(event) => patch({ planningResourceId: event.target.value })}
                >
                  <option value="">{t("chooseResource")}</option>{options}
                </select>
              </SettingsField>
              <div className="orch-setting-row">
                <span className="orch-setting-label">{t("workers")}</span>
                <div className="orch-worker-selection">
                  {draft.resources.filter((resource) => resource.kind === "worker").map((resource) => (
                    <label key={resource.id}>
                      <input
                        type="checkbox"
                        data-testid={`orch-worker-${resource.id}`}
                        checked={draft.workerResourceIds.includes(resource.id)}
                        onChange={(event) => patch({
                          workerResourceIds: event.target.checked
                            ? [...draft.workerResourceIds, resource.id]
                            : draft.workerResourceIds.filter((id) => id !== resource.id),
                        })}
                      />
                      {resource.name}
                    </label>
                  ))}
                  {!draft.resources.some((resource) => resource.kind === "worker") && (
                    <p className="orch-small-note">{t("noWorkers")}</p>
                  )}
                </div>
              </div>
              <SettingsField name="review-resource" label={t("reviewResource")}>
                <select
                  id="orch-review-resource"
                  data-testid="orch-review-resource"
                  value={draft.reviewResourceId}
                  onChange={(event) => patch({ reviewResourceId: event.target.value })}
                >
                  <option value="">{t("chooseResource")}</option>{options}
                </select>
              </SettingsField>
              <div className="orch-setting-row">
                <span className="orch-setting-label">{t("executionPolicy")}</span>
                <span>{t("confirmationRequired")}</span>
              </div>
              <details className="orch-advanced-settings">
                <summary>{t("advanced")}</summary>
                <SettingsField name="concurrency" label={t("concurrency")}>
                  <input
                    id="orch-concurrency"
                    data-testid="orch-concurrency"
                    type="number"
                    min={1}
                    max={4}
                    value={draft.concurrency || ""}
                    onChange={(event) => patch({ concurrency: Number(event.target.value) })}
                  />
                </SettingsField>
                <label className="orch-checkbox-row">
                  <input
                    type="checkbox"
                    data-testid="orch-packed-planning"
                    checked={draft.preferPackedPlanning}
                    onChange={(event) => patch({ preferPackedPlanning: event.target.checked })}
                  />
                  {t("packed")}
                </label>
              </details>
              <div className="orch-setting-help">{t("settingsHelp")}</div>
            </section>
          ) : (
            <section>
              <div className="orch-settings-section-heading">
                <h3>{t("resources")}</h3>
                <button
                  type="button"
                  data-testid="orch-resource-add"
                  className="orch-quiet"
                  onClick={() => {
                    const resource = newAgentResource(t("resourceFallback"));
                    patch({ resources: [...draft.resources, resource] });
                    setEditingId(resource.id);
                  }}
                >
                  <Plus />{t("addResource")}
                </button>
              </div>
              <p className="orch-settings-description">{t("resourcesDescription")}</p>
              <div className="orch-resource-list">
                {draft.resources.map((resource) => (
                  <button
                    key={resource.id}
                    type="button"
                    data-testid={`orch-resource-${resource.id}`}
                    className={`orch-resource-row ${editingId === resource.id ? "active" : ""}`}
                    onClick={() => { setEditingId(resource.id); setError(null); }}
                  >
                    <span className={`orch-resource-icon ${resource.kind === "worker" ? "cli" : ""}`}>
                      {resource.kind === "api" ? "API" : "CLI"}
                    </span>
                    <span>
                      <strong>{resource.name}</strong>
                      <small>{resource.kind === "api" ? resource.model || t("unknown") : resource.harness}</small>
                    </span>
                    <span className="orch-resource-status">{t(resource.kind === "api" ? "api" : "worker")}</span>
                  </button>
                ))}
              </div>
              {!draft.resources.length && <p className="orch-small-note">{t("noResources")}</p>}
              {editingResource && (
                <ResourceEditor
                  key={editingResource.id}
                  resource={editingResource}
                  onChange={editResource}
                  onRemove={removeResource}
                />
              )}
            </section>
          )}
        </fieldset>
      </div>
      <footer className="orch-settings-footer">
        <span>
          {error
            ? <span data-testid="orch-settings-error" role="alert" className="orch-error">{error}</span>
            : t("settingsHelp")}
        </span>
        <button type="button" data-testid="orch-settings-cancel" className="orch-outline" disabled={saving} onClick={close}>
          {t("cancel")}
        </button>
        <button
          type="button"
          data-testid="orch-settings-save"
          className="orch-solid"
          disabled={!draft || saving}
          onClick={() => { void save(); }}
        >
          {t(saving ? "saving" : "save")}
        </button>
      </footer>
    </OrchestrationDialog>
  );
}
