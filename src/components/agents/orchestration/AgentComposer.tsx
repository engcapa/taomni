import { ArrowUp, ChevronDown, FileText, Folder, Plus, Settings } from "lucide-react";
import { useState } from "react";
import type { AgentIntent, AgentSettings } from "../../../lib/ipc/orchestration";
import type { WorkspaceRootFolder } from "../../../stores/workspacePlatformStore";
import { useOrchT } from "./locales";

interface Props {
  roots: WorkspaceRootFolder[];
  projectPath: string;
  goal: string;
  intent: AgentIntent;
  paths: string[];
  settings: AgentSettings | null;
  pending: boolean;
  onProject: (path: string) => void;
  onGoal: (goal: string) => void;
  onIntent: (intent: AgentIntent) => void;
  onPaths: (paths: string[]) => void;
  onSubmit: () => void;
  onSettings: () => void;
  onContext: () => void;
  onAddProject: () => void;
}

export function AgentComposer({
  roots, projectPath, goal, intent, paths, settings, pending,
  onProject, onGoal, onIntent, onPaths, onSubmit, onSettings, onContext, onAddProject,
}: Props) {
  const t = useOrchT();
  const [attaching, setAttaching] = useState(false);
  const [pathText, setPathText] = useState(paths.join("\n"));
  const disabled = !projectPath || !settings || pending;

  return (
    <div className="orch-composer-dock" data-testid="orch-composer">
      <div className="orch-composer">
        <div className="orch-composer-context">
          <Folder />
          <select
            data-testid="orch-project-select"
            className="orch-context-project"
            aria-label={t("project")}
            value={projectPath}
            onChange={(event) => onProject(event.target.value)}
          >
            {!projectPath && <option value="">{t("noProject")}</option>}
            {roots.map((root) => <option key={root.id} value={root.path}>{root.name}</option>)}
          </select>
          <button
            type="button"
            data-testid="orch-project-add"
            className="orch-icon-button"
            aria-label={t("addProject")}
            onClick={onAddProject}
          >
            <Plus />
          </button>
          <span className="orch-fill" />
          <button
            type="button"
            data-testid="orch-context-preview"
            className="orch-context-count"
            onClick={onContext}
            disabled={!projectPath}
          >
            {paths.length ? t("contextCount", { count: paths.length }) : t("inspectContext")}
          </button>
        </div>
        {paths.length > 0 && (
          <div className="orch-attachment-chips">
            {paths.map((path) => (
              <span key={path}>
                <FileText />{path}
                <button
                  type="button"
                  aria-label={`${t("cancel")} ${path}`}
                  onClick={() => {
                    const next = paths.filter((value) => value !== path);
                    onPaths(next);
                    setPathText(next.join("\n"));
                  }}
                >×</button>
              </span>
            ))}
          </div>
        )}
        {attaching && (
          <div className="orch-attachments" data-testid="orch-context-files">
            <label htmlFor="orch-source-paths">{t("paths")}</label>
            <textarea
              id="orch-source-paths"
              data-testid="orch-source-paths"
              value={pathText}
              onChange={(event) => {
                setPathText(event.target.value);
                onPaths([...new Set(event.target.value.split("\n").map((value) => value.trim()).filter(Boolean))]);
              }}
              rows={3}
            />
            <p className="orch-small-note">{t("pathsHint")}</p>
          </div>
        )}
        <label className="orch-sr-only" htmlFor="orch-prompt">{t("prompt")}</label>
        <textarea
          id="orch-prompt"
          data-testid="orch-prompt"
          placeholder={t("promptPlaceholder")}
          rows={3}
          value={goal}
          disabled={!projectPath || pending}
          onChange={(event) => onGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!disabled && goal.trim()) onSubmit();
            }
          }}
        />
        <div className="orch-composer-toolbar">
          <button
            type="button"
            data-testid="orch-attach"
            className="orch-icon-button"
            aria-label={t("addContext")}
            aria-expanded={attaching}
            disabled={!projectPath}
            onClick={() => { setPathText(paths.join("\n")); setAttaching(!attaching); }}
          >
            <Plus />
          </button>
          <select
            data-testid="orch-intent"
            aria-label={t("intent")}
            value={intent}
            onChange={(event) => onIntent(event.target.value as AgentIntent)}
          >
            <option value="develop">{t("develop")}</option>
            <option value="plan">{t("plan")}</option>
            <option value="review">{t("reviewIntent")}</option>
          </select>
          <span className="orch-fill" />
          <button
            type="button"
            data-testid="orch-composer-settings"
            className="orch-config-indicator"
            onClick={onSettings}
          >
            <Settings /><span>{settings?.name ?? t("shared")}</span><ChevronDown />
          </button>
          <button
            type="button"
            data-testid="orch-send"
            className="orch-send-button"
            aria-label={t("send")}
            disabled={disabled || !goal.trim()}
            onClick={onSubmit}
          >
            <ArrowUp />
          </button>
        </div>
      </div>
      {!projectPath && (
        <p data-testid="orch-project-blocked" role="status" className="orch-small-note">{t("projectBlocked")}</p>
      )}
      {!settings && projectPath && (
        <p data-testid="orch-settings-unavailable" className="orch-small-note">{t("settingsUnavailable")}</p>
      )}
      <div className="orch-composer-hint"><span>{t("defaultsHint")}</span><span>{t("sendHint")}</span></div>
    </div>
  );
}
