import { readSessionBookmark } from "../../../lib/sessionBookmark";
import { useRef } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen } from "lucide-react";
import { SessionProtocolIcon } from "../../session/SessionProtocolIcon";
import type { SessionConfig } from "../../../lib/ipc";
import { useCustomDropTarget, type CustomDragData } from "../../../lib/customDnD";
import { sessionTypeLabel } from "../../../lib/terminalProfile";
import { normalizeGroupPath } from "../../../lib/sessionPaths";
import { type FolderNode, folderKey, countNodeSessions, SESSION_DRAG_MIME, type SessionDragPayload } from "./model";


export function FolderContents({
  node,
  expanded,
  searchQuery,
  selectedSessionIds,
  dragOverGroup,
  onToggle,
  onFolderContextMenu,
  onSessionContextMenu,
  onDropSession,
  onDragOverFolder,
  onDragLeave,
  onSessionClick,
  onSessionPointerDown,
  onConnectSession,
}: {
  node: FolderNode;
  expanded: Record<string, boolean>;
  searchQuery: string;
  selectedSessionIds: ReadonlySet<string>;
  dragOverGroup: string | null;
  onToggle: (key: string) => void;
  onFolderContextMenu: (event: React.MouseEvent, path: string | null) => void;
  onSessionContextMenu: (event: React.MouseEvent, session: SessionConfig) => void;
  onDropSession: (groupPath: string | null, sessionIds: string[]) => void;
  onDragOverFolder: (groupPath: string | null) => void;
  onDragLeave: () => void;
  onSessionClick: (event: React.MouseEvent, session: SessionConfig) => void;
  onSessionPointerDown: (event: React.PointerEvent<HTMLDivElement>, session: SessionConfig) => void;
  onConnectSession?: (session: SessionConfig) => void;
}) {
  return (
    <>
      {node.folders.map((folder) => {
        const key = folderKey(folder.path);
        const isOpen = searchQuery ? true : !!expanded[key];

        return (
          <TreeFolder
            key={key}
            node={folder}
            count={countNodeSessions(folder)}
            open={isOpen}
            onToggle={() => onToggle(key)}
            onContextMenu={(event) => onFolderContextMenu(event, folder.path)}
            onDropSession={(sessionIds) => onDropSession(folder.path, sessionIds)}
            onDragOverFolder={() => onDragOverFolder(folder.path)}
            onDragLeave={onDragLeave}
            dragOver={dragOverGroup === key}
          >
            <FolderContents
              node={folder}
              expanded={expanded}
              searchQuery={searchQuery}
              selectedSessionIds={selectedSessionIds}
              dragOverGroup={dragOverGroup}
              onToggle={onToggle}
              onFolderContextMenu={onFolderContextMenu}
              onSessionContextMenu={onSessionContextMenu}
              onDropSession={onDropSession}
              onDragOverFolder={onDragOverFolder}
              onDragLeave={onDragLeave}
              onSessionClick={onSessionClick}
              onSessionPointerDown={onSessionPointerDown}
              onConnectSession={onConnectSession}
            />
          </TreeFolder>
        );
      })}

      {node.sessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          selected={selectedSessionIds.has(session.id)}
          onClick={(event) => onSessionClick(event, session)}
          onPointerDown={(event) => onSessionPointerDown(event, session)}
          onDoubleClick={() => onConnectSession?.(session)}
          onContextMenu={(event) => onSessionContextMenu(event, session)}
        />
      ))}
    </>
  );
}


export function TreeFolder({
  node,
  count,
  open,
  onToggle,
  children,
  onContextMenu,
  onDropSession,
  onDragOverFolder,
  onDragLeave,
  dragOver,
}: {
  node: FolderNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
  onContextMenu?: (event: React.MouseEvent) => void;
  onDropSession?: (sessionIds: string[]) => void;
  onDragOverFolder?: () => void;
  onDragLeave?: () => void;
  dragOver?: boolean;
}) {
  const isRoot = node.path === null;
  const hasChildren = node.folders.length > 0 || node.sessions.length > 0;
  const headerRef = useRef<HTMLDivElement>(null);

  useCustomDropTarget<HTMLDivElement>(headerRef, {
    accepts: (data: CustomDragData) =>
      data.mime === SESSION_DRAG_MIME && !!onDropSession,
    onDragEnter: () => onDragOverFolder?.(),
    onDragOver: () => onDragOverFolder?.(),
    onDragLeave: () => onDragLeave?.(),
    onDrop: (detail) => {
      const payload = detail.data.payload as SessionDragPayload | null;
      if (payload?.sessionIds?.length) onDropSession?.(payload.sessionIds);
    },
  });

  return (
    <div>
      <div
        ref={headerRef}
        className="taomni-tree-row"
        data-testid="session-tree-folder"
        data-folder-path={node.path ?? ""}
        data-drag-over={dragOver}
        style={dragOver ? { background: "var(--taomni-selected)" } : undefined}
        onClick={onToggle}
        onContextMenu={onContextMenu}
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-[var(--taomni-text-muted)]" />
        ) : (
          <ChevronRight className="w-3 h-3 text-[var(--taomni-text-muted)]" />
        )}
        {open || isRoot ? (
          <FolderOpen className="w-3.5 h-3.5 text-ui-warning" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-ui-warning" />
        )}
        <span className="flex-1 font-medium truncate">{node.name}</span>
        {count !== undefined && hasChildren && (
          <span className="text-[var(--taomni-text-muted)]" style={{ fontSize: "calc(var(--taomni-ui-font-size) - 2px)" }}>({count})</span>
        )}
      </div>
      {open && <div className="pl-4">{children}</div>}
    </div>
  );
}


export function SessionItem({
  session,
  selected,
  onClick,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
}: {
  session: SessionConfig;
  selected: boolean;
  onClick: (event: React.MouseEvent) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const typeLabel = sessionTypeLabel(session.session_type, session.options_json);
  const customIcon = readSessionBookmark(session.options_json).customIcon;
  const icon = customIcon ? <span className="w-3.5 text-center" aria-label="Custom session icon">{customIcon}</span> : sessionIcon(typeLabel);
  return (
    <div
      data-testid="session-tree-item"
      data-session-id={session.id}
      data-session-name={session.name}
      data-session-type={typeLabel}
      data-group-path={normalizeGroupPath(session.group_path) ?? ""}
      className="taomni-tree-row group"
      data-selected={selected}
      aria-selected={selected}
      style={selected ? { background: "var(--taomni-selected)" } : undefined}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={(event) => {
        // Rapid range/toggle selections can form a native double-click.
        // Keep modifier clicks in selection mode instead of connecting.
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        onDoubleClick();
      }}
      onContextMenu={onContextMenu}
    >
      <span className="w-3" />
      {icon}
      <span className="flex-1 truncate">
        {session.name}
        {session.username && session.host && (
          <span className="text-[var(--taomni-text-muted)]">
            {" "}({session.username}@{session.host})
          </span>
        )}
      </span>
      <span
        className="rounded bg-[var(--taomni-info-bg)] px-1 text-ui-caption text-[var(--taomni-info-text)]"
        data-testid="session-protocol-label"
      >
        {typeLabel}
      </span>
    </div>
  );
}


export function sessionIcon(type: string) {
  return <SessionProtocolIcon protocol={type} className="size-3.5" />;
}
