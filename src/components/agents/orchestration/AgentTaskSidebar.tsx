import { Folder, Plus, Search, Settings } from "lucide-react";
import { useState } from "react";
import type { AgentRun, AgentSettings } from "../../../lib/ipc/orchestration";
import type { PlatformWorkspace } from "../../../stores/workspacePlatformStore";
import { useOrchT } from "./locales";

interface Props {
  workspace: PlatformWorkspace | undefined;
  projectPath: string;
  runs: AgentRun[];
  selectedId: string | null;
  settings: AgentSettings | null;
  onProject: (path: string) => void;
  onSelect: (id: string | null) => void;
  onSettings: () => void;
}

export function AgentTaskSidebar({
  workspace, projectPath, runs, selectedId, settings, onProject, onSelect, onSettings,
}: Props) {
  const t = useOrchT();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const visible = runs.filter((run) =>
    run.projectPath === projectPath && run.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );

  return (
    <aside data-testid="orch-sidebar" className="orch-project-sidebar">
      <div className="orch-sidebar-title">
        <strong>{t("title")}</strong><span className="orch-fill" />
        <button
          type="button"
          className="orch-icon-button"
          aria-label={t("search")}
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search />
        </button>
      </div>
      <button type="button" data-testid="orch-new-task" className="orch-new-task-button" onClick={() => onSelect(null)}>
        <Plus />{t("newTask")}
      </button>
      {searchOpen && (
        <input
          data-testid="orch-task-search"
          className="orch-sidebar-search"
          autoFocus
          aria-label={t("search")}
          placeholder={t("search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}
      <div className="orch-sidebar-section"><Folder /><strong>{workspace?.name ?? t("noProject")}</strong></div>
      <div className="orch-task-list" data-testid="orch-task-list">
        <button
          type="button"
          data-testid="orch-task-draft"
          className={`orch-task-entry ${!selectedId ? "active" : ""}`}
          onClick={() => onSelect(null)}
        >
          <span className="orch-task-dot hollow" />{t("newTask")}
        </button>
        {visible.map((run) => (
          <button
            key={run.id}
            type="button"
            data-testid={`orch-run-${run.id}`}
            data-run-id={run.id}
            data-status={run.status}
            className={`orch-task-entry ${selectedId === run.id ? "active" : ""}`}
            aria-current={selectedId === run.id ? "page" : undefined}
            onClick={() => onSelect(run.id)}
          >
            <span className={`orch-task-dot ${["partial", "blocked", "failed", "interrupted"].includes(run.status) ? "amber" : ""}`} />
            <span className="orch-task-label">{run.title}</span>
            <span className="orch-task-age">{t(`status_${run.status}`)}</span>
          </button>
        ))}
        {!visible.length && <p className="orch-small-note">{t("noTasks")}</p>}
      </div>
      {workspace && workspace.rootFolders.length > 1 && (
        <div className="orch-project-roots">
          {workspace.rootFolders.map((root) => (
            <button
              type="button"
              key={root.id}
              className={`orch-project-other ${root.path === projectPath ? "active" : ""}`}
              data-testid={`orch-project-${root.id}`}
              onClick={() => onProject(root.path)}
            >
              <Folder /><span>{root.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="orch-sidebar-bottom">
        <button type="button" data-testid="orch-settings-open" className="orch-shared-config" onClick={onSettings}>
          <Settings />
          <span>
            <strong>{t("shared")}</strong>
            <small>{settings ? t("sharedHint", { name: settings.name }) : t("loading")}</small>
          </span>
        </button>
        <div className="orch-identity"><span className="orch-avatar">T</span><span>{t("workspace")}</span></div>
      </div>
    </aside>
  );
}
