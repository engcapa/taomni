import { MessageCircle, Plus } from "lucide-react";
import { useState } from "react";
import { useT } from "../lib/i18n";
import { openLocalShellAsAdministrator, type LocalDirectoryShortcut, type SessionConfig } from "../lib/ipc";
import { sftpLocalHome } from "../lib/sftp";
import { useAppStore } from "../stores/appStore";
import type { RecentWorkspace } from "../types";
import { ActionCard, LocalTerminalCard, MailSessionsCard, WslCard } from "./welcome/LaunchCards";
import { LocalDirectoriesPanel } from "./welcome/LocalDirectoriesPanel";
import { RecentSessionsPanel } from "./welcome/RecentSessionsPanel";
import { RecentWorkspacesPanel } from "./welcome/RecentWorkspacesPanel";
import { RestoreLastSessionRow } from "./welcome/RestoreLastSessionRow";
import { localShellSelectionFromOption } from "./welcome/sessionModel";
import { type WelcomeHistoryTab, type WelcomePanelProps } from "./welcome/types";
import { useWelcomeHistory } from "./welcome/useWelcomeHistory";
import { useWelcomeShells } from "./welcome/useWelcomeShells";
import { WelcomeHistoryPanel } from "./welcome/WelcomeHistoryPanel";

const EMPTY_RECENT_SESSIONS: SessionConfig[] = [];

const EMPTY_RECENT_WORKSPACES: RecentWorkspace[] = [];

export function WelcomePanel({
  restore,
  onStartLocalTerminal,
  onNewSession,
  onOpenLocalPath,
  onOpenLanChat,
  recentSessions = EMPTY_RECENT_SESSIONS,
  recentWorkspaces = EMPTY_RECENT_WORKSPACES,
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
  const { setStatusMessage } = useAppStore();
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
      <div className="w-full max-w-[1320px] mx-auto px-6 sm:px-8 lg:px-10 py-8">
        <div className="flex items-center gap-3 mb-5">
          <div
            data-testid="welcome-brand-mark"
            className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold text-xl"
            style={{ background: "linear-gradient(135deg, #1e5fa8, #62d36f)" }}
          >
            T
          </div>
          <div>
            <div className="text-xl font-semibold">{t("app.welcomeTitle")}</div>
            <div className="text-[12px] text-[var(--taomni-text-muted)]">
              {t("app.tagline")}
            </div>
            <div
              data-testid="welcome-version"
              className="text-[11px] mt-0.5 taomni-mono"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              {t("welcome.versionLabel", { version: __APP_VERSION__ })}
            </div>
          </div>
        </div>

        <div
          className="grid gap-4 items-stretch"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}
        >
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
          <ActionCard
            testId="welcome-new-session"
            icon={<Plus className="w-5 h-5" />}
            title={t("welcome.newSessionTitle")}
            desc={t("welcome.newSessionDesc")}
            kbd="Ctrl+Shift+N"
            onClick={() => onNewSession()}
          />
          {onOpenLanChat ? (
            <ActionCard
              testId="welcome-open-lanchat"
              icon={<MessageCircle className="w-5 h-5" />}
              title={t("welcome.lanChatTitle")}
              desc={t("welcome.lanChatDesc")}
              kbd=""
              onClick={onOpenLanChat}
            />
          ) : null}
          {mailSessions.length > 0 ? (
            <MailSessionsCard
              translate={t}
              sessions={mailSessions}
              onOpen={onOpenMailSession}
            />
          ) : null}
        </div>
        {restore ? (
          <RestoreLastSessionRow restore={restore} translate={t} />
        ) : null}

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

        <div className="mt-7 text-[12px] text-[var(--taomni-text-muted)]">
          <div className="font-semibold text-[var(--taomni-text)] mb-1">{t("welcome.tipsHeading")}</div>
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
        </div>

        <div
          data-testid="welcome-version-footer"
          className="mt-7 pt-3 flex items-center justify-between text-[11px] taomni-mono"
          style={{
            borderTop: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text-muted)",
          }}
        >
          <span>{t("app.name")}</span>
          <span>v{__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  );
}

export { type WelcomeRestoreProp } from "./welcome/types";
