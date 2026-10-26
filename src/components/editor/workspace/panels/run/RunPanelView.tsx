import { Check, Loader2, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { parseEnvironmentLines, readRunConfigurationOverrides, writeRunConfigurationOverride } from "../../runConfigurationPersistence";
import { type RunHistoryEntry, type WorkspaceTaskItem } from "./model";
import { useRunPanelConfigurations } from "./useRunPanelConfigurations";

export interface RunPanelViewProps {
  configurations: ReturnType<typeof useRunPanelConfigurations>;
  addCustomTask: () => void;
  roots: import("../../../../../types").CodeWorkspaceRootInfo[];
  onConfigureTools: (() => void) | undefined;
  tasks: WorkspaceTaskItem[];
  grouped: Map<string, WorkspaceTaskItem[]>;
  groupedConfigurations: Map<string, WorkspaceTaskItem[]>;
  renderTask: (task: WorkspaceTaskItem) => import("react").JSX.Element;
  workspaceInstanceId: string;
  history: RunHistoryEntry[];
  runTask: (task: WorkspaceTaskItem, afterExit?: (exitCode: number) => void) => void;
}

export function RunPanelView(inputs: RunPanelViewProps) {
  const {
    configurations,
    addCustomTask,
    roots,
    onConfigureTools,
    tasks,
    grouped,
    groupedConfigurations,
    renderTask,
    workspaceInstanceId,
    history,
    runTask,
  } = inputs;
  const { editingConfiguration } = configurations;
  return ((
    <section data-testid="code-workspace-run-panel" className="flex h-full min-h-0 flex-col text-[11px]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2">
        <input
          data-testid="run-panel-custom-command"
          aria-label="Custom task command"
          value={configurations.customCommand}
          onChange={(event) => configurations.setCustomCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addCustomTask();
          }}
          placeholder="Custom command"
          className="h-6 min-w-40 flex-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2"
        />
        {roots.length > 1 && (
          <select
            data-testid="run-panel-custom-root"
            aria-label="Custom task root"
            value={configurations.customRootId}
            onChange={(event) => configurations.setCustomRootId(event.target.value)}
            className="h-6 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)]"
          >
            {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
          </select>
        )}
        <button
          type="button"
          data-testid="run-panel-add-custom-task"
          aria-label="Add custom task"
          onClick={addCustomTask}
          className="h-6 w-6 rounded"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        {onConfigureTools && (
          <button
            type="button"
            data-testid="run-panel-configure-tools"
            aria-label="Configure build and run tools"
            title="Configure build, runtime, and debug tools"
            onClick={onConfigureTools}
            className="h-6 w-6 rounded"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          data-testid="run-panel-refresh"
          aria-label="Refresh tasks"
          onClick={() => void configurations.refresh()}
          className="h-6 w-6 rounded"
        >
          {configurations.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)] divide-x divide-[var(--taomni-code-border)]">
        <div className="min-h-0 min-w-0 overflow-auto p-2">
          {configurations.error && <div className="mb-2 text-red-500">{configurations.error}</div>}
          {Object.values(configurations.executionDiagnostics).some((items) => items.length > 0) && (
            <div
              data-testid="run-panel-execution-diagnostics"
              role="status"
              className="mb-2 space-y-1 border-b border-amber-500/30 pb-2 text-amber-600 dark:text-amber-400"
            >
              <div className="font-medium">Execution configuration diagnostics</div>
              {roots.flatMap((root) => (configurations.executionDiagnostics[root.id] ?? []).map((diagnostic) => (
                <div key={`${root.id}:${diagnostic}`} className="whitespace-pre-wrap">
                  {root.name}: {diagnostic}
                </div>
              )))}
            </div>
          )}
          {!configurations.loading && tasks.length === 0 && configurations.runConfigurations.length === 0 && (
            <div className="text-[var(--taomni-code-muted)]">No run configurations or tasks detected</div>
          )}
          {roots.map((root) => {
            const rootTasks = grouped.get(root.id) ?? [];
            const rootConfigurations = groupedConfigurations.get(root.id) ?? [];
            if (rootTasks.length === 0 && rootConfigurations.length === 0) return null;
            return (
              <div key={root.id} className="mb-2">
                <div className="mb-1 font-semibold">{root.name}</div>
                {rootConfigurations.length > 0 && (
                  <div data-testid={`run-panel-configurations-${root.id}`}>
                    <div className="px-1 pb-0.5 text-[10px] font-medium uppercase text-[var(--taomni-code-muted)]">
                      Run configurations
                    </div>
                    {rootConfigurations.map(renderTask)}
                  </div>
                )}
                {rootTasks.length > 0 && (
                  <div className={rootConfigurations.length > 0 ? "mt-2" : ""}>
                    <div className="px-1 pb-0.5 text-[10px] font-medium uppercase text-[var(--taomni-code-muted)]">
                      Tasks
                    </div>
                    {rootTasks.map(renderTask)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="taomni-scroll-y min-h-0 min-w-0 overflow-x-hidden p-2 pr-6">
          {editingConfiguration && (() => {
            const configuration = configurations.runConfigurations.find((item) => (
              item.id === editingConfiguration.configurationId
              && item.rootId === editingConfiguration.rootId
            ));
            if (!configuration) return null;
            return (
              <div data-testid="run-configuration-editor" className="mb-3 space-y-2 border-b border-[var(--taomni-code-border)] pb-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{configuration.label}</span>
                  {configuration.runConfiguration?.baseConfigurationId ? (
                    <button
                      type="button"
                      data-testid="run-configuration-delete"
                      aria-label="Delete run configuration"
                      title="Delete run configuration"
                      className="h-6 w-6 rounded text-red-500"
                      onClick={() => configurations.deleteNamedConfiguration(configuration)}
                    >
                      <Trash2 className="mx-auto h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="run-configuration-reset"
                      aria-label="Reset run configuration overrides"
                      title="Reset run configuration overrides"
                      className="h-6 w-6 rounded"
                      onClick={() => {
                        const defaults = configuration.runConfigurationDefaults
                          ?? configuration.runConfiguration;
                        writeRunConfigurationOverride(
                          workspaceInstanceId,
                          configuration.id,
                          null,
                          configuration.rootId,
                        );
                        configurations.setConfigurationDraft({
                          name: defaults?.label ?? configuration.label,
                          cwd: "",
                          args: "",
                          vmOptions: defaults?.runtimeOptions?.join("\n") ?? "",
                          env: "",
                          envFile: defaults?.envFile ?? "",
                          preLaunchTargets: defaults?.preLaunchTargets.join("\n") ?? "",
                          activeProfiles: "",
                          properties: "",
                        });
                        void configurations.refresh();
                      }}
                    >
                      <RefreshCw className="mx-auto h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="run-configuration-save"
                    aria-label="Save run configuration"
                    title="Save run configuration"
                    className="h-6 w-6 rounded"
                    onClick={() => {
                      const existing = readRunConfigurationOverrides(
                        workspaceInstanceId,
                        configuration.rootId,
                      )[configuration.id];
                      const profiles = configurations.configurationDraft.activeProfiles
                        .split(/[,;\s]+/)
                        .map((value) => value.trim())
                        .filter(Boolean);
                      const properties: Record<string, string> = {};
                      for (const line of configurations.configurationDraft.properties.split(/\r?\n/)) {
                        const idx = line.indexOf("=");
                        if (idx > 0) {
                          const k = line.slice(0, idx).trim();
                          const v = line.slice(idx + 1).trim();
                          if (k) properties[k] = v;
                        }
                      }
                      writeRunConfigurationOverride(workspaceInstanceId, configuration.id, {
                        name: configurations.configurationDraft.name,
                        baseConfigurationId: existing?.baseConfigurationId ?? "",
                        args: configurations.configurationDraft.args.split(/\r?\n/).filter((value) => value.length > 0),
                        vmOptions: configurations.configurationDraft.vmOptions.split(/\r?\n/).filter((value) => value.length > 0),
                        cwd: configurations.configurationDraft.cwd,
                        env: parseEnvironmentLines(configurations.configurationDraft.env),
                        envFile: configurations.configurationDraft.envFile,
                        preLaunchTargets: configurations.configurationDraft.preLaunchTargets
                          .split(/\r?\n/)
                          .map((value) => value.trim())
                          .filter(Boolean),
                        activeProfiles: profiles.length > 0 ? profiles : undefined,
                        properties: Object.keys(properties).length > 0 ? properties : undefined,
                      }, configuration.rootId);
                      void configurations.refresh();
                    }}
                  >
                    <Check className="mx-auto h-3.5 w-3.5" />
                  </button>
                </div>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Name</span>
                  <input
                    data-testid="run-configuration-name"
                    value={configurations.configurationDraft.name}
                    onChange={(event) => configurations.setConfigurationDraft((current) => ({ ...current, name: event.target.value }))}
                    className="h-6 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Active profiles (Maven -P / Spring)</span>
                  <input
                    data-testid="run-configuration-profiles"
                    value={configurations.configurationDraft.activeProfiles}
                    placeholder="e.g. dev, test"
                    onChange={(event) => configurations.setConfigurationDraft((current) => ({ ...current, activeProfiles: event.target.value }))}
                    className="h-6 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Working directory</span>
                  <input
                    data-testid="run-configuration-cwd"
                    value={configurations.configurationDraft.cwd}
                    placeholder={configuration.cwd}
                    onChange={(event) => configurations.setConfigurationDraft((current) => ({ ...current, cwd: event.target.value }))}
                    className="h-6 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">VM / runtime options</span>
                  <textarea
                    data-testid="run-configuration-vm-options"
                    value={configurations.configurationDraft.vmOptions}
                    onChange={(event) => configurations.setConfigurationDraft((current) => ({ ...current, vmOptions: event.target.value }))}
                    rows={2}
                    className="w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 py-1 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Build / system properties (-Dkey=value)</span>
                  <textarea
                    data-testid="run-configuration-properties"
                    value={configurations.configurationDraft.properties}
                    placeholder="key=value"
                    onChange={(event) => configurations.setConfigurationDraft((current) => ({ ...current, properties: event.target.value }))}
                    rows={2}
                    className="w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 py-1 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Program arguments</span>
                  <textarea
                    data-testid="run-configuration-args"
                    value={configurations.configurationDraft.args}
                    onChange={(event) => configurations.setConfigurationDraft((current) => ({ ...current, args: event.target.value }))}
                    rows={3}
                    className="w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 py-1 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Environment file</span>
                  <input
                    data-testid="run-configuration-env-file"
                    value={configurations.configurationDraft.envFile}
                    placeholder=".env or an absolute path"
                    onChange={(event) => configurations.setConfigurationDraft((current) => ({ ...current, envFile: event.target.value }))}
                    className="h-6 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 font-mono"
                  />
                </label>
                <fieldset className="space-y-1" data-testid="run-configuration-before-launch">
                  <legend className="text-[10px] text-[var(--taomni-code-muted)]">Before launch</legend>
                  {(configurations.buildTargetsByRoot[configuration.rootId] ?? []).map((target) => {
                    const selected = configurations.configurationDraft.preLaunchTargets.split(/\r?\n/).includes(target.id);
                    return (
                      <label key={target.id} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          data-testid={`run-configuration-before-launch-${target.id}`}
                          checked={selected}
                          onChange={(event) => configurations.setConfigurationDraft((current) => {
                            const ids = current.preLaunchTargets
                              .split(/\r?\n/)
                              .map((value) => value.trim())
                              .filter(Boolean);
                            const next = event.target.checked
                              ? [...new Set([...ids, target.id])]
                              : ids.filter((id) => id !== target.id);
                            return { ...current, preLaunchTargets: next.join("\n") };
                          })}
                        />
                        <span>{target.label}</span>
                      </label>
                    );
                  })}
                </fieldset>
                <label className="block">
                  <span className="mb-0.5 block text-[10px] text-[var(--taomni-code-muted)]">Environment</span>
                  <textarea
                    data-testid="run-configuration-env"
                    value={configurations.configurationDraft.env}
                    onChange={(event) => configurations.setConfigurationDraft((current) => ({ ...current, env: event.target.value }))}
                    rows={3}
                    className="w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 py-1 font-mono"
                  />
                </label>
              </div>
            );
          })()}
          <div className="mb-1 font-semibold">Run History</div>
          {history.length === 0 && <div className="text-[var(--taomni-code-muted)]">No tasks run yet</div>}
          {history.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
              onClick={() => runTask(entry.task)}
              title="Run again"
            >
              <span className={entry.status === "running"
                ? "text-sky-500"
                : entry.status === "passed" ? "text-emerald-500" : "text-red-500"}
              >
                {entry.status === "running" ? "●" : entry.status === "passed" ? "✓" : "×"}
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.task.rootName} · {entry.task.label}</span>
              <span className="shrink-0 tabular-nums text-[var(--taomni-code-muted)]">
                {entry.exitCode === null ? "running" : `exit ${entry.exitCode}`}
              </span>
              {entry.message && (
                <span className="max-w-[45%] truncate text-red-500" title={entry.message}>
                  {entry.message}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  ));
}
