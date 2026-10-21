import { FolderOpen, Folder, Play, Edit3, Copy, Trash2 } from "lucide-react";
import { type SessionConfig } from "../../lib/ipc";
import { type TranslateFn } from "../../lib/i18n";
import { SESSION_ROOT_LABEL, folderOptionLabel } from "../../lib/sessionPaths";
import type { SessionTerminalAppearancePatch } from "../../lib/sessionTerminalTheme";
import { type MenuItem } from "../ContextMenu";
import { buildSessionTerminalThemeMenuItem } from "../session/SessionTerminalThemeMenu";
import { buildSessionConnectionCommandMenuItem } from "../session/SessionConnectionCommandMenu";
import { uniqueRecentSessionsById } from "./sessionModel";


export function recentSessionMenuItems({
  t,
  session,
  targetSessions,
  allSessions,
  folderPaths,
  setStatusMessage,
  onOpenSession,
  onOpenSessions,
  onEditSession,
  onDuplicateSessions,
  onMoveSessionsToGroup,
  onSetTerminalAppearance,
  onDeleteSessions,
  onConnectMenuSessions,
}: {
  t: TranslateFn;
  session: SessionConfig;
  targetSessions: readonly SessionConfig[];
  allSessions: readonly SessionConfig[];
  folderPaths: string[];
  setStatusMessage: (message: string) => void;
  onOpenSession?: (session: SessionConfig) => void;
  onOpenSessions?: (sessions: SessionConfig[]) => void;
  onEditSession?: (session: SessionConfig) => void;
  onDuplicateSessions: (ids: string[]) => Promise<void>;
  onMoveSessionsToGroup: (ids: string[], groupPath: string | null) => Promise<void>;
  onSetTerminalAppearance: (patch: SessionTerminalAppearancePatch, sessions: readonly SessionConfig[]) => Promise<void>;
  onDeleteSessions: (sessions: readonly SessionConfig[]) => Promise<void>;
  onConnectMenuSessions: (sessions: readonly SessionConfig[], sourceLabel: string) => void;
}): MenuItem[] {
  const uniqueSessions = uniqueRecentSessionsById(targetSessions);
  const targetIds = uniqueSessions.map((candidate) => candidate.id);
  const hasMultiSelection = uniqueSessions.length > 1;
  const moveChildren: MenuItem[] = [
    {
      label: SESSION_ROOT_LABEL,
      icon: <FolderOpen className="w-3 h-3" />,
      onClick: () => void onMoveSessionsToGroup(targetIds, null),
    },
    ...folderPaths.map((path) => ({
      label: folderOptionLabel(path),
      icon: <Folder className="w-3 h-3" />,
      onClick: () => void onMoveSessionsToGroup(targetIds, path),
    })),
  ];
  const copyCommandItem = buildSessionConnectionCommandMenuItem({
    session,
    allSessions,
    t,
    setStatusMessage,
  });

  return [
    ...(hasMultiSelection ? [
      {
        label: t("sessionTree.contextConnectSelected", { count: uniqueSessions.length }),
        testId: `context-menu-item-connect-selected-sessions-${uniqueSessions.length}`,
        icon: <Play className="w-3 h-3" />,
        onClick: () => onConnectMenuSessions(uniqueSessions, t("sessionTree.fromSelected")),
        disabled: !onOpenSessions,
      },
      { label: "", separator: true },
    ] satisfies MenuItem[] : []),
    {
      label: t("sessionTree.contextConnect"),
      icon: <Play className="w-3 h-3" />,
      disabled: !onOpenSession,
      onClick: () => onOpenSession?.(session),
    },
    ...(copyCommandItem ? [copyCommandItem] : []),
    {
      label: t("sessionTree.contextEdit"),
      icon: <Edit3 className="w-3 h-3" />,
      disabled: !onEditSession,
      onClick: () => onEditSession?.(session),
    },
    {
      label: hasMultiSelection
        ? t("sessionTree.contextDuplicateCount", { count: targetIds.length })
        : t("sessionTree.contextDuplicate"),
      testId: hasMultiSelection ? `context-menu-item-duplicate-selected-sessions-${targetIds.length}` : undefined,
      icon: <Copy className="w-3 h-3" />,
      onClick: () => void onDuplicateSessions(targetIds),
    },
    {
      label: t("sessionTree.contextMoveToFolder"),
      icon: <Folder className="w-3 h-3" />,
      children: moveChildren,
    },
    buildSessionTerminalThemeMenuItem({
      sessions: uniqueSessions,
      t,
      onSelectAppearance: onSetTerminalAppearance,
    }),
    { label: "", separator: true },
    {
      label: hasMultiSelection
        ? t("sessionTree.contextDeleteCount", { count: targetIds.length })
        : t("sessionTree.contextDelete"),
      testId: hasMultiSelection ? `context-menu-item-delete-selected-sessions-${targetIds.length}` : undefined,
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      onClick: () => void onDeleteSessions(uniqueSessions),
    },
  ];
}
