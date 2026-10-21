import type { useRootlessApplicationDraft } from "./useRootlessApplicationDraft";
import { ChevronDown, ChevronRight, FolderOpen, Loader2, Pencil, Play, Plus, Square, Trash2, X } from "lucide-react";
import { type AppSelector, type LaunchedAppInfo, type ScopeMode, type SocksCapCapabilities, type SocksCapConfig, type SocksCapProfile } from "../../../lib/sockscap";
import { Field } from "./Field";
import { rootlessAppKey, formatRootlessCommand } from "./launchPolicy";
import { Section } from "./Section";
import { ManualAppAdd } from "./ManualAppAdd";

export interface ApplicationsSectionProps {
  draft: ReturnType<typeof useRootlessApplicationDraft>;
  linuxLaunchOnly: boolean;
  t: import("../../../lib/i18n").TranslateFn;
  caps: SocksCapCapabilities | null;
  locked: boolean;
  selectedProf: SocksCapProfile;
  patchSelectedProfile: (partial: Partial<SocksCapProfile>) => Promise<SocksCapConfig | null>;
  addRootlessApplication: () => Promise<void>;
  pickMacosApplication: () => Promise<void>;
  pickLinuxApplication: () => Promise<void>;
  loadProcesses: () => Promise<void>;
  addAppPath: (path: string, name?: string) => Promise<{ app: AppSelector; config: SocksCapConfig; } | null>;
  launchedApps: LaunchedAppInfo[];
  cfg: SocksCapConfig | null;
  stoppingPid: number | null;
  launchingPath: string | null;
  onStopLaunchedApp: (pid: number) => Promise<void>;
  running: boolean;
  busy: boolean;
  probing: boolean;
  onRootlessLaunchApp: (profileId: string, path: string, args?: string[], launchMode?: "desktop" | "terminal", launchPreparation?: import("../../../lib/sockscap").LaunchPreparation, name?: string, configOverride?: SocksCapConfig) => Promise<void>;
}

export function ApplicationsSection(viewProps: ApplicationsSectionProps) {
  return (<Section
    sectionId={viewProps.linuxLaunchOnly ? "applications" : "scope"}
    title={
      viewProps.linuxLaunchOnly
        ? viewProps.t("sockscap.rootlessApplicationsTitle")
        : viewProps.t("sockscap.section.scope")
    }
    defaultExpanded={viewProps.linuxLaunchOnly}
  >
    {!viewProps.linuxLaunchOnly && (
      <>
        <div className="flex gap-2">
          {(["global", "apps"] as ScopeMode[]).map((m) => {
            // The backend refuses app scope when it cannot identify the
            // source application, so do not offer it as a choice.
            const unsupported = m === "apps" && viewProps.caps !== null && !viewProps.caps.appFilter;
            const disabled = viewProps.locked || unsupported;
            return (
              <button
                key={m}
                type="button"
                data-testid={`sockscap-mode-${m}`}
                disabled={disabled}
                title={
                  viewProps.locked
                    ? viewProps.t("sockscap.lockedTooltip")
                    : unsupported
                      ? viewProps.t("sockscap.appModeUnsupported")
                      : undefined
                }
                className={`px-3 py-1.5 rounded text-[12px] border disabled:opacity-50 disabled:cursor-not-allowed ${viewProps.selectedProf.mode === m
                  ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] font-medium"
                  : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                  }`}
                onClick={() => void viewProps.patchSelectedProfile({ mode: m })}
              >
                {viewProps.t(`sockscap.mode.${m}`)}
              </button>
            );
          })}
        </div>
        {viewProps.caps !== null && !viewProps.caps.appFilter && (
          <p className="mt-2 text-[11px] text-[var(--taomni-text-muted)]">
            {viewProps.t("sockscap.appModeUnsupported")}
          </p>
        )}
      </>
    )}
    {(viewProps.selectedProf.mode === "apps" || viewProps.linuxLaunchOnly) && (
      <div className="mt-3 space-y-2">
        {viewProps.linuxLaunchOnly ? (
          <div
            data-testid="sockscap-rootless-app-editor"
            className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] p-2.5"
          >
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)_140px_auto] gap-2 items-end">
              <Field label={viewProps.t("sockscap.rootlessCommandLabel")}>
                <div className="flex gap-1">
                  <input
                    data-testid="sockscap-rootless-command"
                    className="flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] disabled:opacity-60"
                    value={viewProps.draft.rootlessCommand}
                    disabled={viewProps.locked}
                    placeholder={viewProps.t("sockscap.rootlessCommandPlaceholder")}
                    onChange={(event) => viewProps.draft.setRootlessCommand(event.target.value)}
                  />
                  <button
                    type="button"
                    data-testid="sockscap-pick-linux-application"
                    className="shrink-0 px-2 py-1.5 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50"
                    onClick={() => void viewProps.draft.pickRootlessApplication()}
                    disabled={viewProps.locked}
                  >
                    {viewProps.t("sockscap.browseApplication")}
                  </button>
                </div>
              </Field>
              <Field label={viewProps.t("sockscap.rootlessArgumentsLabel")}>
                <input
                  data-testid="sockscap-rootless-arguments"
                  className="w-full text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] disabled:opacity-60"
                  value={viewProps.draft.rootlessArguments}
                  disabled={viewProps.locked}
                  placeholder={viewProps.t("sockscap.rootlessArgumentsPlaceholder")}
                  onChange={(event) => viewProps.draft.setRootlessArguments(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void viewProps.addRootlessApplication();
                  }}
                />
              </Field>
              <Field label={viewProps.t("sockscap.rootlessLaunchModeLabel")}>
                <select
                  data-testid="sockscap-rootless-launch-mode"
                  className="w-full text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] disabled:opacity-60"
                  value={viewProps.draft.rootlessLaunchMode}
                  disabled={viewProps.locked}
                  onChange={(event) =>
                    viewProps.draft.setRootlessLaunchMode(
                      event.target.value as "desktop" | "terminal",
                    )
                  }
                >
                  <option value="desktop">
                    {viewProps.t("sockscap.rootlessLaunchModeDesktop")}
                  </option>
                  <option value="terminal">
                    {viewProps.t("sockscap.rootlessLaunchModeTerminal")}
                  </option>
                </select>
              </Field>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="sockscap-add-rootless-application"
                  className="inline-flex flex-1 items-center justify-center gap-1 px-3 py-1.5 rounded text-[11px] border border-[var(--taomni-accent)] text-[var(--taomni-accent)] hover:bg-[var(--taomni-accent)]/10 disabled:opacity-50"
                  disabled={viewProps.locked || !viewProps.draft.rootlessCommand.trim()}
                  onClick={() => void viewProps.addRootlessApplication()}
                >
                  {viewProps.draft.editingRootlessAppKey ? (
                    <Pencil className="w-3 h-3" />
                  ) : (
                    <Plus className="w-3 h-3" />
                  )}
                  {viewProps.t(
                    viewProps.draft.editingRootlessAppKey
                      ? "sockscap.updateApplication"
                      : "sockscap.addApplication",
                  )}
                </button>
                {viewProps.draft.editingRootlessAppKey && (
                  <button
                    type="button"
                    data-testid="sockscap-cancel-rootless-application-edit"
                    className="p-1.5 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50"
                    disabled={viewProps.locked}
                    title={viewProps.t("common.cancel")}
                    aria-label={viewProps.t("common.cancel")}
                    onClick={viewProps.draft.resetRootlessApplicationDraft}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
            <button
              type="button"
              data-testid="sockscap-rootless-preparation-toggle"
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] disabled:opacity-50"
              disabled={viewProps.locked}
              aria-expanded={viewProps.draft.rootlessPreparationOpen}
              onClick={() => viewProps.draft.setRootlessPreparationOpen((open) => !open)}
            >
              {viewProps.draft.rootlessPreparationOpen ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              {viewProps.t("sockscap.rootlessPreparationTitle")}
            </button>
            {viewProps.draft.rootlessPreparationOpen && (
              <div
                data-testid="sockscap-rootless-preparation"
                className="mt-2 border-t border-[var(--taomni-divider)] pt-2 space-y-2"
              >
                <div className="grid grid-cols-1 xl:grid-cols-[minmax(280px,1fr)_140px] gap-2">
                  <Field label={viewProps.t("sockscap.rootlessWorkingDirectoryLabel")}>
                    <div className="flex gap-1">
                      <input
                        data-testid="sockscap-rootless-working-directory"
                        className="flex-1 min-w-0 text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] disabled:opacity-60"
                        value={viewProps.draft.rootlessWorkingDirectory}
                        disabled={viewProps.locked}
                        placeholder={viewProps.t("sockscap.rootlessWorkingDirectoryPlaceholder")}
                        onChange={(event) =>
                          viewProps.draft.setRootlessWorkingDirectory(event.target.value)
                        }
                      />
                      <button
                        type="button"
                        data-testid="sockscap-pick-rootless-working-directory"
                        className="p-1.5 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50"
                        disabled={viewProps.locked}
                        title={viewProps.t("sockscap.browseDirectory")}
                        aria-label={viewProps.t("sockscap.browseDirectory")}
                        onClick={() => void viewProps.draft.pickRootlessWorkingDirectory()}
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </Field>
                  <Field label={viewProps.t("sockscap.rootlessShellLabel")}>
                    <select
                      data-testid="sockscap-rootless-shell"
                      className="w-full text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] disabled:opacity-60"
                      value={viewProps.draft.rootlessLaunchShell}
                      disabled={viewProps.locked}
                      onChange={(event) =>
                        viewProps.draft.setRootlessLaunchShell(event.target.value as "sh" | "bash")
                      }
                    >
                      <option value="sh">POSIX sh</option>
                      <option value="bash">Bash</option>
                    </select>
                  </Field>
                </div>
                <Field label={viewProps.t("sockscap.rootlessPreCommandLabel")}>
                  <textarea
                    data-testid="sockscap-rootless-pre-command"
                    className="w-full min-h-20 resize-y font-mono text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] disabled:opacity-60"
                    value={viewProps.draft.rootlessPreCommand}
                    disabled={viewProps.locked}
                    placeholder={viewProps.t("sockscap.rootlessPreCommandPlaceholder")}
                    onChange={(event) => viewProps.draft.setRootlessPreCommand(event.target.value)}
                  />
                </Field>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium">
                      {viewProps.t("sockscap.rootlessEnvironmentLabel")}
                    </span>
                    <button
                      type="button"
                      data-testid="sockscap-add-rootless-environment"
                      className="inline-flex items-center gap-1 text-[10px] text-[var(--taomni-accent)] hover:underline disabled:opacity-50"
                      disabled={viewProps.locked}
                      onClick={() =>
                        viewProps.draft.setRootlessEnvironment((entries) => [
                          ...entries,
                          {
                            id: viewProps.draft.nextEnvironmentDraftId.current++,
                            name: "",
                            value: "",
                          },
                        ])
                      }
                    >
                      <Plus className="w-3 h-3" />
                      {viewProps.t("sockscap.addEnvironmentVariable")}
                    </button>
                  </div>
                  <div className="space-y-1">
                    {viewProps.draft.rootlessEnvironment.map((entry, index) => (
                      <div
                        key={entry.id}
                        className="grid grid-cols-[minmax(120px,0.45fr)_minmax(160px,1fr)_auto] gap-1"
                      >
                        <input
                          data-testid={`sockscap-rootless-environment-name-${index}`}
                          aria-label={viewProps.t("sockscap.environmentName")}
                          className="min-w-0 font-mono text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] disabled:opacity-60"
                          value={entry.name}
                          disabled={viewProps.locked}
                          placeholder={viewProps.t("sockscap.environmentName")}
                          onChange={(event) =>
                            viewProps.draft.setRootlessEnvironment((entries) =>
                              entries.map((current) =>
                                current.id === entry.id
                                  ? { ...current, name: event.target.value }
                                  : current,
                              ),
                            )
                          }
                        />
                        <input
                          data-testid={`sockscap-rootless-environment-value-${index}`}
                          aria-label={viewProps.t("sockscap.environmentValue")}
                          className="min-w-0 font-mono text-[11px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] disabled:opacity-60"
                          value={entry.value}
                          disabled={viewProps.locked}
                          placeholder={viewProps.t("sockscap.environmentValue")}
                          onChange={(event) =>
                            viewProps.draft.setRootlessEnvironment((entries) =>
                              entries.map((current) =>
                                current.id === entry.id
                                  ? { ...current, value: event.target.value }
                                  : current,
                              ),
                            )
                          }
                        />
                        <button
                          type="button"
                          className="p-1.5 rounded hover:text-red-500 disabled:opacity-50"
                          disabled={viewProps.locked}
                          title={viewProps.t("common.remove")}
                          aria-label={viewProps.t("common.remove")}
                          onClick={() =>
                            viewProps.draft.setRootlessEnvironment((entries) =>
                              entries.filter((current) => current.id !== entry.id),
                            )
                          }
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <p className="mt-2 text-[10px] text-[var(--taomni-text-muted)]">
              {viewProps.t("sockscap.rootlessCommandHint")}
            </p>
          </div>
        ) : (
          <div className="flex gap-2">
            {viewProps.caps?.platform === "macos" && (
              <button
                type="button"
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => void viewProps.pickMacosApplication()}
                disabled={viewProps.locked}
                title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
              >
                <Plus className="w-3 h-3" />
                {viewProps.t("sockscap.pickApplication")}
              </button>
            )}
            {viewProps.caps?.platform === "linux" && (
              <button
                type="button"
                data-testid="sockscap-pick-linux-application"
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => void viewProps.pickLinuxApplication()}
                disabled={viewProps.locked}
                title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
              >
                <Plus className="w-3 h-3" />
                {viewProps.t("sockscap.pickApplication")}
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => void viewProps.loadProcesses()}
              disabled={viewProps.locked}
              title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
            >
              <Plus className="w-3 h-3" />
              {viewProps.t("sockscap.pickProcess")}
            </button>
            <ManualAppAdd onAdd={(path) => void viewProps.addAppPath(path)} disabled={viewProps.locked} />
          </div>
        )}
        {viewProps.selectedProf.apps.length === 0 ? (
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            {viewProps.t(viewProps.linuxLaunchOnly ? "sockscap.rootlessAppsEmpty" : "sockscap.appsEmpty")}
          </div>
        ) : (
          <ul className="space-y-1">
            {viewProps.selectedProf.apps.map((a, index) => {
              const appKey = rootlessAppKey(
                a.path,
                a.args,
                a.launchMode,
                a.launchPreparation,
              );
              const matchingLaunches = viewProps.launchedApps.filter(
                (app) =>
                  app.profileId === viewProps.selectedProf.id &&
                  rootlessAppKey(
                    app.path,
                    app.args,
                    app.terminalSessionId ? "terminal" : "desktop",
                    app.launchPreparation,
                  ) === appKey,
              );
              const latestLaunch = matchingLaunches.at(-1);
              const launched = latestLaunch?.running ? latestLaunch : undefined;
              const profileActive =
                viewProps.selectedProf.enabled &&
                (viewProps.cfg?.activeProfileIds.includes(viewProps.selectedProf.id) ?? false);
              return (
                <li
                  key={appKey}
                  className="flex items-center gap-2 text-[12px] px-2 py-1 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                >
                  <span className="flex-1 min-w-0" title={a.path}>
                    <span className="block truncate">{a.name || a.path}</span>
                    {viewProps.linuxLaunchOnly && (
                      <>
                        <span className="block truncate font-mono text-[10px] text-[var(--taomni-text-muted)]">
                          {formatRootlessCommand(a.path, a.args)}
                        </span>
                        <span className="block text-[10px] text-sky-700 dark:text-sky-300">
                          {viewProps.t(
                            a.launchMode === "terminal"
                              ? "sockscap.rootlessLaunchModeTerminal"
                              : "sockscap.rootlessLaunchModeDesktop",
                          )}
                        </span>
                        {a.launchPreparation?.workingDirectory && (
                          <span className="block truncate font-mono text-[10px] text-[var(--taomni-text-muted)]">
                            {viewProps.t("sockscap.rootlessWorkingDirectorySummary", {
                              path: a.launchPreparation.workingDirectory,
                            })}
                          </span>
                        )}
                        {a.launchPreparation?.preCommand && (
                          <span className="block truncate font-mono text-[10px] text-[var(--taomni-text-muted)]">
                            {viewProps.t("sockscap.rootlessPreCommandSummary", {
                              command: a.launchPreparation.preCommand.split(/\r?\n/)[0],
                            })}
                          </span>
                        )}
                      </>
                    )}
                    {a.macosIdentity && (
                      <span className="block truncate text-[10px] text-[var(--taomni-text-muted)]">
                        {a.macosIdentity.mainExecutablePath} ·{" "}
                        {a.macosIdentity.kind === "executable"
                          ? viewProps.t("sockscap.executableOnlyCoverage")
                          : viewProps.t("sockscap.bundleFamilyCoverage")}
                      </span>
                    )}
                    {launched && (
                      <span
                        className={`block text-[10px] ${launched.phase === "preparing"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-emerald-600 dark:text-emerald-400"
                          }`}
                      >
                        {viewProps.t(
                          launched.phase === "preparing"
                            ? "sockscap.applicationPreparing"
                            : "sockscap.applicationRunning",
                          { pid: launched.pid },
                        )}
                      </span>
                    )}
                    {!launched && latestLaunch?.phase === "failed" && (
                      <span
                        className="block truncate text-[10px] text-red-600 dark:text-red-400"
                        title={latestLaunch.launchError}
                      >
                        {viewProps.t("sockscap.applicationLaunchFailed", {
                          reason: latestLaunch.launchError ?? viewProps.t("common.unknownError"),
                        })}
                      </span>
                    )}
                  </span>
                  {a.macosIdentity?.teamId && (
                    <span
                      className="text-[10px] text-[var(--taomni-text-muted)]"
                      title={a.macosIdentity.designatedRequirement}
                    >
                      {a.macosIdentity.teamId}
                    </span>
                  )}
                  {viewProps.linuxLaunchOnly &&
                    (launched ? (
                      <button
                        type="button"
                        data-testid={`sockscap-stop-launched-app-${launched.pid}`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        disabled={viewProps.stoppingPid !== null || viewProps.launchingPath !== null}
                        onClick={() => void viewProps.onStopLaunchedApp(launched.pid)}
                      >
                        {viewProps.stoppingPid === launched.pid ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Square className="w-3 h-3" />
                        )}
                        {viewProps.t("sockscap.stopApplication")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`sockscap-launch-app-${index}`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--taomni-accent)] text-[var(--taomni-accent)] hover:bg-[var(--taomni-accent)]/10 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={
                          (viewProps.running && !profileActive) ||
                          viewProps.busy ||
                          viewProps.probing ||
                          viewProps.launchingPath !== null ||
                          viewProps.stoppingPid !== null
                        }
                        title={
                          viewProps.running && !profileActive
                            ? viewProps.t("sockscap.launchProfileInactive")
                            : undefined
                        }
                        onClick={() =>
                          void viewProps.onRootlessLaunchApp(
                            viewProps.selectedProf.id,
                            a.path,
                            a.args ?? [],
                            a.launchMode ?? "desktop",
                            a.launchPreparation ?? {},
                            a.name,
                          )
                        }
                      >
                        {viewProps.launchingPath === appKey ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Play className="w-3 h-3" />
                        )}
                        {viewProps.t(
                          a.launchMode === "terminal"
                            ? viewProps.running
                              ? "sockscap.openTerminalApplication"
                              : "sockscap.startTerminalAndCapture"
                            : viewProps.running
                              ? "sockscap.launchApplication"
                              : "sockscap.startAndCapture",
                        )}
                      </button>
                    ))}
                  {viewProps.linuxLaunchOnly && (
                    <button
                      type="button"
                      data-testid={`sockscap-edit-app-${index}`}
                      className="p-1 hover:text-[var(--taomni-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
                      disabled={viewProps.locked || launched !== undefined}
                      title={viewProps.t("sockscap.editApplication")}
                      aria-label={viewProps.t("sockscap.editApplication")}
                      onClick={() => viewProps.draft.editRootlessApplication(a)}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="p-1 hover:text-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={viewProps.locked}
                    title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
                    onClick={() =>
                      void viewProps.patchSelectedProfile({
                        apps: viewProps.selectedProf.apps.filter(
                          (item) =>
                            rootlessAppKey(
                              item.path,
                              item.args,
                              item.launchMode,
                              item.launchPreparation,
                            ) !== appKey,
                        ),
                      })
                    }
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    )}
  </Section>);
}
