import { memo, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { openLocalShellAsAdministrator, type LocalDirectoryShortcut, type SessionConfig } from "../lib/ipc";
import { sftpLocalHome } from "../lib/sftp";
import { useAppStore } from "../stores/appStore";
import { LocalTerminalCard, MailSessionsCard, WslCard } from "./welcome/LaunchCards";
import { LocalDirectoriesPanel } from "./welcome/LocalDirectoriesPanel";
import { RecentSessionsPanel } from "./welcome/RecentSessionsPanel";
import { RecentWorkspacesPanel } from "./welcome/RecentWorkspacesPanel";
import { RestoreLastSessionRow } from "./welcome/RestoreLastSessionRow";
import { localShellSelectionFromOption } from "./welcome/sessionModel";
import { type WelcomeHistoryTab, type WelcomePanelProps } from "./welcome/types";
import { useWelcomeHistory } from "./welcome/useWelcomeHistory";
import { useWelcomeShells } from "./welcome/useWelcomeShells";
import { PlatformLaunchCards } from "./welcome/PlatformLaunchCards";
import { WelcomeHistoryPanel } from "./welcome/WelcomeHistoryPanel";

const EMPTY_RECENT_SESSIONS: SessionConfig[] = [];

export const WelcomePanel = memo(function WelcomePanel({
  restore,
  onStartLocalTerminal,
  onNewSession,
  onOpenLocalPath,
  onOpenLanChat,
  recentSessions = EMPTY_RECENT_SESSIONS,
  recentWorkspaces: providedRecentWorkspaces,
  mailSessions = EMPTY_RECENT_SESSIONS,
  onOpenMailSession,
  onOpenRecentSession,
  onOpenRecentSessions,
  onEditRecentSession,
  onRevealRecentSession,
  onOpenRecentWorkspace,
  onRemoveRecentWorkspace,
  onClearRecentWorkspaces,
  onRevealRecentWorkspace,
  onOpenNewWorkspace,
  onOpenSettings,
  active = true,
}: WelcomePanelProps) {
  const [pendingDirectoryIds, setPendingDirectoryIds] = useState<string[]>([]);
  const [historyTab, setHistoryTab] = useState<WelcomeHistoryTab>("sessions");
  const setStatusMessage = useAppStore((state) => state.setStatusMessage);
  // Opening a file publishes its recent workspace. Keep the hidden Home's
  // history and controls intact without rendering them on the activation path.
  const recentWorkspacesRef = useRef(providedRecentWorkspaces ?? useAppStore.getState().recentWorkspaces);
  const visibleRecentWorkspaces = useAppStore((state) => active ? providedRecentWorkspaces ?? state.recentWorkspaces : null);
  if (visibleRecentWorkspaces) recentWorkspacesRef.current = visibleRecentWorkspaces;
  const recentWorkspaces = recentWorkspacesRef.current;
  const t = useT();
  const {
    selectedShell,
    mergedShells,
    localDirectories,
    directoriesStatus,
    directoriesError,
    reloadDirectories,
    selectedShellId,
    setSelectedShellId,
    shellStatus,
    wslDistros,
    selectedDistro,
    setSelectedDistro,
    wslStatus,
  } = useWelcomeShells({
    setStatusMessage,
    t,
    active,
  });
  const {
    filteredRecentWorkspaces,
    filteredRecentSessions,
    recentTypeOptions,
    selectedRecentSet,
    selectedRecentSessions,
    recentQuery,
    setRecentQuery,
    recentType,
    setRecentType,
    recentSort,
    setRecentSort,
    selectedRecentIds,
    setSelectedRecentIds,
    workspaceQuery,
    setWorkspaceQuery,
  } = useWelcomeHistory({
    recentSessions,
    recentWorkspaces,
  });

  const handleStartAsAdministrator = async () => {
    try {
      await openLocalShellAsAdministrator(selectedShell?.id);
      setStatusMessage(t("status.administratorRequested", {
        shell: selectedShell?.name ?? t("welcome.defaultShell"),
      }));
    } catch (error) {
      setStatusMessage(t("status.administratorFailed", { error: String(error) }));
    }
  };

  const handleOpenHomeFolder = async () => {
    if (!onOpenLocalPath) return;
    try {
      const home = await sftpLocalHome();
      if (home) onOpenLocalPath(home, { embedFolder: true });
    } catch (error) {
      setStatusMessage(t("status.homeLookupFailed", { error: String(error) }));
    }
  };

  const handleStartInDirectory = async (directory: LocalDirectoryShortcut) => {
    const directoryId = directory.directoryId || `${directory.kind}:${directory.path}`;
    if (pendingDirectoryIds.includes(directoryId)) return;
    setPendingDirectoryIds((ids) => [...ids, directoryId]);
    try {
      const shell = localShellSelectionFromOption(selectedShell, directory.path);
      const cwd = selectedShell?.id.startsWith("wsl:") ? undefined : directory.path;
      const outcome = await onStartLocalTerminal(shell, cwd);
      if (outcome && outcome.status === "failed") {
        setStatusMessage(
          t("welcome.localDirectoryStartFailed", {
            path: directory.path,
            error: outcome.error ?? "",
          }),
        );
      }
    } finally {
      setPendingDirectoryIds((ids) => ids.filter((id) => id !== directoryId));
    }
  };

  return (
    <div data-testid="welcome-panel" className="w-full h-full min-w-0 overflow-auto" style={{ background: "var(--taomni-bg)" }}>
      <div className="taomni-home-content">
        {restore ? <RestoreLastSessionRow restore={restore} translate={t} /> : null}
        <div className="taomni-home-launch-grid">
          <LocalTerminalCard
            translate={t}
            shells={mergedShells}
            selectedShell={selectedShell}
            selectedShellId={selectedShellId}
            shellStatus={shellStatus}
            onSelectShell={setSelectedShellId}
            kbd="Ctrl+Shift+T"
            onStart={() => {
              onStartLocalTerminal(localShellSelectionFromOption(selectedShell));
            }}
            onStartAsAdministrator={handleStartAsAdministrator}
            onOpenHomeFolder={onOpenLocalPath ? () => void handleOpenHomeFolder() : undefined}
          />
          {wslStatus === "ready" && wslDistros.length > 0 && (
            <WslCard
              translate={t}
              distros={wslDistros}
              selectedDistro={selectedDistro}
              onSelectDistro={setSelectedDistro}
              onStart={() => {
                if (!selectedDistro) return;
                onStartLocalTerminal({
                  id: "wsl.exe",
                  name: `WSL: ${selectedDistro}`,
                  args: ["-d", selectedDistro],
                });
              }}
            />
          )}
          <PlatformLaunchCards onNewSession={onNewSession} onOpenLanChat={onOpenLanChat} onOpenNewWorkspace={onOpenNewWorkspace} />
          {mailSessions.length > 0 ? (
            <MailSessionsCard
              translate={t}
              sessions={mailSessions}
              onOpen={onOpenMailSession}
            />
          ) : null}
        </div>
        <WelcomeHistoryPanel
          translate={t}
          activeTab={historyTab}
          directoryCount={localDirectories.length}
          workspaceCount={filteredRecentWorkspaces.length}
          sessionCount={filteredRecentSessions.length}
          onActiveTabChange={setHistoryTab}
          directoriesPanel={(
            <LocalDirectoriesPanel
              translate={t}
              directories={localDirectories}
              pendingDirectoryIds={pendingDirectoryIds}
              loadStatus={directoriesStatus}
              loadError={directoriesError}
              onRetry={reloadDirectories}
              onStartInDirectory={handleStartInDirectory}
            />
          )}
          workspacesPanel={(
            <RecentWorkspacesPanel
              translate={t}
              workspaces={recentWorkspaces}
              filteredWorkspaces={filteredRecentWorkspaces}
              query={workspaceQuery}
              onQueryChange={setWorkspaceQuery}
              onClearFilter={() => setWorkspaceQuery("")}
              onOpenWorkspace={onOpenRecentWorkspace}
              onRemoveWorkspace={onRemoveRecentWorkspace}
              onClearWorkspaces={onClearRecentWorkspaces}
              onRevealWorkspace={onRevealRecentWorkspace}
              onOpenNewWorkspace={onOpenNewWorkspace}
            />
          )}
          sessionsPanel={(
            <RecentSessionsPanel
              translate={t}
              sessions={recentSessions}
              filteredSessions={filteredRecentSessions}
              typeOptions={recentTypeOptions}
              query={recentQuery}
              typeFilter={recentType}
              sort={recentSort}
              selectedIds={selectedRecentSet}
              selectedCount={selectedRecentIds.length}
              onQueryChange={setRecentQuery}
              onTypeFilterChange={setRecentType}
              onSortChange={setRecentSort}
              onToggleSession={(id) => {
                setSelectedRecentIds((ids) =>
                  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
                );
              }}
              onClearFilter={() => {
                setRecentQuery("");
                setRecentType("all");
              }}
              onSelectFiltered={() => setSelectedRecentIds(filteredRecentSessions.map((session) => session.id))}
              onClearSelection={() => setSelectedRecentIds([])}
              onOpenSession={onOpenRecentSession}
              onOpenSessions={onOpenRecentSessions}
              onEditSession={onEditRecentSession}
              onRevealSession={onRevealRecentSession}
              selectedSessions={selectedRecentSessions}
              onSetSelectedSessions={setSelectedRecentIds}
              onOpenSettings={onOpenSettings}
            />
          )}
        />

        <details className="text-[11px] text-[var(--taomni-text-muted)]">
          <summary className="cursor-pointer font-semibold text-[var(--taomni-text)]">{t("welcome.tipsHeading")}</summary>
          <ul className="list-disc pl-5 space-y-0.5">
            <li
              dangerouslySetInnerHTML={{
                __html: t("welcome.tipQuickConnect", {
                  example: '<span class="taomni-mono px-1 border rounded" style="background: var(--taomni-input-bg); border-color: var(--taomni-divider);">ssh user@host:22</span>',
                }),
              }}
            />
            <li>{t("welcome.tipRightClick")}</li>
            <li>{t("welcome.tipDrag")}</li>
          </ul>
        </details>

        <div
          data-testid="welcome-version-footer"
          className="flex items-center justify-between gap-2 text-[11px] taomni-mono"
          style={{

            color: "var(--taomni-text-muted)",
          }}
        >
          <span className="inline-flex items-center gap-2"><span data-testid="welcome-brand-mark">T</span><span>{t("app.welcomeTitle")}</span></span>
          <span data-testid="welcome-version">{t("welcome.versionLabel", { version: __APP_VERSION__ })} · v{__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  );
}, (previous, next) => previous.active === false && next.active === false);

export { type WelcomeRestoreProp } from "./welcome/types";
