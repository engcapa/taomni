import { Copy, Edit3, Folder, FolderOpen, Play, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { openBinaryFile, openTextFile } from "../../lib/fileHelpers";
import { useT } from "../../lib/i18n";
import type { SessionConfig } from "../../lib/ipc";
import { getHomeDir } from "../../lib/ipc";
import { parseCsvSessions, parseMobaXtermSessions, parseTaomniSessions } from "../../lib/sessionImportExport";
import { SESSION_ROOT_LABEL, folderOptionLabel } from "../../lib/sessionPaths";
import type { SessionTerminalAppearancePatch } from "../../lib/sessionTerminalTheme";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { ExternalVaultUnlockDialog } from "../session/ExternalVaultUnlockDialog";
import { buildSessionConnectionCommandMenuItem } from "../session/SessionConnectionCommandMenu";
import { SessionImportPreview } from "../session/SessionImportPreview";
import { buildSessionTerminalThemeMenuItem } from "../session/SessionTerminalThemeMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { FolderNameDialog } from "./FolderNameDialog";
import { createFolderContextMenu } from "./sessionTree/createFolderContextMenu";
import { createSessionExports } from "./sessionTree/createSessionExports";
import { createSessionImportSources } from "./sessionTree/createSessionImportSources";
import { FolderContents, TreeFolder } from "./sessionTree/FolderContents";
import { countNodeSessions, folderKey, sessionsInFolder, uniqueSessionsById } from "./sessionTree/model";
import { useExternalSessionSecrets } from "./sessionTree/useExternalSessionSecrets";
import { useSessionFolders } from "./sessionTree/useSessionFolders";
import { useSessionImportPreview } from "./sessionTree/useSessionImportPreview";
import { useSessionTreeNavigation } from "./sessionTree/useSessionTreeNavigation";

interface SessionTreeProps {
  onNewSession?: (groupPath?: string | null) => void;
  onConnectSession?: (session: SessionConfig) => void;
  onEditSession?: (session: SessionConfig) => void;
}

export function SessionTree({ onNewSession, onConnectSession, onEditSession }: SessionTreeProps) {
  const t = useT();
  const {
    sessions,
    groups,
    searchQuery,
    selectedSessionId,
    selectedSessionIds,
    loadSessions,
    removeSessions,
    duplicateSessions,
    moveSessionsToGroup,
    updateSessionsTerminalAppearance,
    createFolderPath,
    renameFolderPath,
    deleteFolderPath,
    importSessions,
    setSelectedSession,
    setSelectedSessionIds,
    toggleSessionSelection,
    loading,
  } = useSessionStore();
  const { setStatusMessage } = useAppStore();
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const {
    expandPath,
    effectiveSelectedSessionIds,
    selectSingleSession,
    folderPaths,
    tree,
    expanded,
    toggle,
    handleSessionClick,
    handleSessionPointerDown,
    filteredSessions,
  } = useSessionTreeNavigation({
    selectedSessionId,
    sessions,
    searchQuery,
    groups,
    selectedSessionIds,
    setSelectedSession,
    setSelectedSessionIds,
    toggleSessionSelection,
    t,
    setDragOverGroup,
  });
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title?: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const ctx = useContextMenu();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const reportWarnings = (warnings: string[]) => {
    if (warnings.length === 0) return;
    const shown = warnings.slice(0, 8);
    const more = warnings.length > shown.length ? t("sessionTree.warningsMore", { count: warnings.length - shown.length, plural: warnings.length - shown.length === 1 ? "" : "s" }) : "";
    window.alert(`${shown.join("\n")}${more}`);
  };

  const reportFileError = (error: unknown) => {
    window.alert(error instanceof Error ? error.message : String(error));
  };

  const handleDrop = (groupPath: string | null, sessionIds: string[]) => {
    setDragOverGroup(null);
    if (sessionIds.length === 0) return;
    void moveSessionsToGroup(sessionIds, groupPath).catch(reportFileError);
    expandPath(groupPath);
  };

  const handleDragOver = (groupPath: string | null) => {
    setDragOverGroup(folderKey(groupPath));
  };
  const { createFolder, renameFolder, deleteFolder, handleFolderDialogSubmit, folderDialog, setFolderDialog } = useSessionFolders({
    createFolderPath,
    expandPath,
    setStatusMessage,
    t,
    renameFolderPath,
    sessions,
    setConfirmPrompt,
    deleteFolderPath,
  });
  const exports = createSessionExports({
    sessions,
    reportFileError,
    setStatusMessage,
    t,
    reportWarnings,
  });

  const importJson = (folderPath: string | null) => {
    openTextFile(".json,.taomni-sessions.json,.newmob-sessions.json,application/json").then((text) => {
      if (!text) return;
      const result = parseTaomniSessions(text, { targetFolder: folderPath, existingSessions: sessions });
      importPreview.queueImportPreview(result, folderPath, "Taomni");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importMoba = (folderPath: string | null) => {
    openBinaryFile(".mxtsessions,.moba,text/plain,application/octet-stream").then(async (bytes) => {
      if (!bytes) return;
      const homeDir = await getHomeDir().catch(() => null);
      const result = parseMobaXtermSessions(bytes, { targetFolder: folderPath, existingSessions: sessions, homeDir });
      importPreview.queueImportPreview(result, folderPath, "MobaXterm");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };

  const importCsv = (folderPath: string | null) => {
    openTextFile(".csv,text/csv").then((text) => {
      if (!text) return;
      const result = parseCsvSessions(text, { targetFolder: folderPath, existingSessions: sessions });
      importPreview.queueImportPreview(result, folderPath, "CSV");
    }).catch((error) => {
      window.alert(error instanceof Error ? error.message : String(error));
    });
  };
  const { enrichTabbyResult, enrichSecureCrtResult, externalVaultPrompt } = useExternalSessionSecrets({
    t,
  });
  const importPreview = useSessionImportPreview({
    enrichTabbyResult,
    enrichSecureCrtResult,
    importSessions,
    expandPath,
    t,
    setStatusMessage,
    reportWarnings,
  });


  const executeFolder = (folderPath: string | null) => {
    const folderSessions = sessionsInFolder(sessions, folderPath);
    connectSessions(folderSessions, t("sessionTree.fromFolder", { label: folderOptionLabel(folderPath) }));
  };

  const connectSessions = (targetSessions: readonly SessionConfig[], sourceLabel: string) => {
    const uniqueSessions = uniqueSessionsById(targetSessions);
    for (const session of uniqueSessions) {
      onConnectSession?.(session);
    }
    setStatusMessage(t("sessionTree.sessionsStarted", { count: uniqueSessions.length, plural: uniqueSessions.length === 1 ? "" : "s", source: sourceLabel }));
  };
  const importSources = createSessionImportSources({
    sessions,
    queueImportPreview: importPreview.queueImportPreview,
    setStatusMessage,
    t,
  });
  const { folderContextMenu } = createFolderContextMenu({
    sessions,
    t,
    importMoba,
    importSources,
    importCsv,
    exports,
    ctx,
    onNewSession,
    createFolder,
    renameFolder,
    deleteFolder,
    importJson,
    onConnectSession,
    executeFolder,
  });

  const sessionContextMenu = (e: React.MouseEvent, session: SessionConfig) => {
    const selectedContextSessions = effectiveSelectedSessionIds.has(session.id)
      ? sessions.filter((candidate) => effectiveSelectedSessionIds.has(candidate.id))
      : [session];
    // Right-clicking an item outside the current selection narrows to just it.
    // Right-clicking one already selected preserves the whole multi-selection.
    if (!effectiveSelectedSessionIds.has(session.id)) {
      selectSingleSession(session);
    }
    const targetIds = selectedContextSessions.map((candidate) => candidate.id);
    const hasMultiSelection = selectedContextSessions.length > 1;
    const setTerminalAppearance = async (
      patch: SessionTerminalAppearancePatch,
      targetSessions: readonly SessionConfig[],
    ) => {
      const updatedCount = await updateSessionsTerminalAppearance(
        targetSessions.map((candidate) => candidate.id),
        patch,
      );
      setStatusMessage(t("sessionTree.terminalAppearanceUpdated", { count: updatedCount }));
    };
    const moveChildren: MenuItem[] = [
      { label: SESSION_ROOT_LABEL, icon: <FolderOpen className="w-3 h-3" />, onClick: () => void moveSessionsToGroup(targetIds, null) },
      ...folderPaths.map((path) => ({
        label: folderOptionLabel(path),
        icon: <Folder className="w-3 h-3" />,
        onClick: () => {
          void moveSessionsToGroup(targetIds, path);
          expandPath(path);
        },
      })),
    ];
    const copyCommandItem = buildSessionConnectionCommandMenuItem({
      session,
      allSessions: sessions,
      t,
      setStatusMessage,
    });

    const items: MenuItem[] = [
      ...(hasMultiSelection ? [
        {
          label: t("sessionTree.contextConnectSelected", { count: selectedContextSessions.length }),
          testId: `context-menu-item-connect-selected-sessions-${selectedContextSessions.length}`,
          icon: <Play className="w-3 h-3" />,
          onClick: () => connectSessions(selectedContextSessions, t("sessionTree.fromSelected")),
          disabled: !onConnectSession,
        },
        { label: "", separator: true },
      ] satisfies MenuItem[] : []),
      { label: t("sessionTree.contextConnect"), icon: <Play className="w-3 h-3" />, onClick: () => onConnectSession?.(session), disabled: !onConnectSession },
      ...(copyCommandItem ? [copyCommandItem] : []),
      { label: t("sessionTree.contextEdit"), icon: <Edit3 className="w-3 h-3" />, onClick: () => onEditSession?.(session), disabled: !onEditSession },
      {
        label: hasMultiSelection ? t("sessionTree.contextDuplicateCount", { count: targetIds.length }) : t("sessionTree.contextDuplicate"),
        testId: hasMultiSelection ? `context-menu-item-duplicate-selected-sessions-${targetIds.length}` : undefined,
        icon: <Copy className="w-3 h-3" />,
        onClick: () => void duplicateSessions(targetIds),
      },
      { label: t("sessionTree.contextMoveToFolder"), icon: <Folder className="w-3 h-3" />, children: moveChildren },
      buildSessionTerminalThemeMenuItem({
        sessions: selectedContextSessions,
        t,
        onSelectAppearance: setTerminalAppearance,
      }),
      { label: "", separator: true },
      {
        label: hasMultiSelection ? t("sessionTree.contextDeleteCount", { count: targetIds.length }) : t("sessionTree.contextDelete"),
        testId: hasMultiSelection ? `context-menu-item-delete-selected-sessions-${targetIds.length}` : undefined,
        icon: <Trash2 className="w-3 h-3" />,
        danger: true,
        onClick: () => {
          if (hasMultiSelection) {
            setConfirmPrompt({
              title: t("sessionTree.confirmDeleteSelectedTitle"),
              message: t("sessionTree.confirmDeleteSelected", { count: targetIds.length }),
              confirmLabel: t("sessionTree.deleteAction"),
              danger: true,
              onConfirm: () => {
                setConfirmPrompt(null);
                void removeSessions(targetIds);
              },
            });
          } else {
            setConfirmPrompt({
              title: t("sessionTree.confirmDeleteTitle"),
              message: t("sessionTree.confirmDelete", { name: session.name }),
              confirmLabel: t("sessionTree.deleteAction"),
              danger: true,
              onConfirm: () => {
                setConfirmPrompt(null);
                void removeSessions([session.id]);
              },
            });
          }
        },
      },
    ];
    ctx.show(e, items);
  };

  return (
    <>
      {folderDialog && (
        <FolderNameDialog
          parentPath={folderDialog.parentPath}
          initialName={folderDialog.mode === "rename" ? folderDialog.initialName : t("sessionTree.newFolderDefaultName")}
          title={folderDialog.mode === "rename" ? t("sessionTree.folderEditTitle") : t("sessionTree.folderNewTitle")}
          onCancel={() => setFolderDialog(null)}
          onSubmit={handleFolderDialogSubmit}
        />
      )}
      {importPreview.pendingImport && (
        <SessionImportPreview
          source={importPreview.pendingImport.source}
          result={importPreview.pendingImport.result}
          targetFolder={importPreview.pendingImport.folderPath}
          onCancel={() => importPreview.setPendingImport(null)}
          onConfirm={(selectedIds) => void importPreview.confirmPendingImport(selectedIds)}
        />
      )}
      {externalVaultPrompt && (
        <ExternalVaultUnlockDialog
          toolName={externalVaultPrompt.toolName}
          title={externalVaultPrompt.title}
          description={externalVaultPrompt.description}
          passwordLabel={externalVaultPrompt.passwordLabel}
          errorMessage={externalVaultPrompt.errorMessage}
          onSubmit={externalVaultPrompt.onSubmit}
          onSkip={externalVaultPrompt.onSkip}
        />
      )}
      {confirmPrompt && (
        <ConfirmDialog
          title={confirmPrompt.title}
          message={confirmPrompt.message}
          confirmLabel={confirmPrompt.confirmLabel}
          danger={confirmPrompt.danger}
          onCancel={() => setConfirmPrompt(null)}
          onConfirm={confirmPrompt.onConfirm}
        />
      )}
      <div
        data-testid="session-tree"
        className="flex-1 taomni-scroll-y"
        style={{ userSelect: "none", WebkitUserSelect: "none" }}
        onContextMenu={(event) => folderContextMenu(event, null)}
      >
        {ctx.render}
        <TreeFolder
          node={tree}
          count={countNodeSessions(tree)}
          open={expanded.root !== false}
          onToggle={() => toggle("root")}
          onContextMenu={(event) => folderContextMenu(event, null)}
          onDropSession={(sessionIds) => handleDrop(null, sessionIds)}
          onDragOverFolder={() => handleDragOver(null)}
          onDragLeave={() => setDragOverGroup(null)}
          dragOver={dragOverGroup === "root"}
        >
          <FolderContents
            node={tree}
            expanded={expanded}
            searchQuery={searchQuery}
            selectedSessionIds={effectiveSelectedSessionIds}
            dragOverGroup={dragOverGroup}
            onToggle={toggle}
            onFolderContextMenu={folderContextMenu}
            onSessionContextMenu={sessionContextMenu}
            onDropSession={handleDrop}
            onDragOverFolder={handleDragOver}
            onDragLeave={() => setDragOverGroup(null)}
            onSessionClick={handleSessionClick}
            onSessionPointerDown={handleSessionPointerDown}
            onConnectSession={onConnectSession}
          />
          {filteredSessions.length === 0 && !loading && (
            <div className="pl-6 py-2 text-[var(--taomni-text-muted)]" style={{ fontSize: "calc(var(--taomni-ui-font-size) - 1px)" }}>
              {searchQuery ? t("sessionTree.emptyNoMatching") : t("sessionTree.emptyNoSessions")}
            </div>
          )}
        </TreeFolder>

      </div>
    </>
  );
}
