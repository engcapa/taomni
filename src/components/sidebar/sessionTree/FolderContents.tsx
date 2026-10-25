import { readSessionBookmark } from "../../../lib/sessionBookmark";
import { useRef } from "react";
import { Terminal as TerminalIcon, Monitor, Folder, Wifi, ChevronRight, ChevronDown, FolderOpen, FileText, Database, Globe, Server, Mail } from "lucide-react";
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
          <ChevronDown className="w-3 h-3 text-slate-500" />
        ) : (
          <ChevronRight className="w-3 h-3 text-slate-500" />
        )}
        {open || isRoot ? (
          <FolderOpen className="w-3.5 h-3.5 text-amber-600" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-600" />
        )}
        <span className="flex-1 font-medium truncate">{node.name}</span>
        {count !== undefined && hasChildren && (
          <span className="text-slate-500" style={{ fontSize: "calc(var(--taomni-ui-font-size) - 2px)" }}>({count})</span>
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
        className="px-1 rounded"
        style={{ fontSize: "calc(var(--taomni-ui-font-size) - 2px)", background: "#e1ecfa", color: "#1e3a5f" }}
      >
        {typeLabel}
      </span>
    </div>
  );
}


export function sessionIcon(type: string) {
  switch (type) {
    case "SSH":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />;
    case "RDP":
      return <Monitor className="w-3.5 h-3.5" style={{ color: "#a04b9c" }} />;
    case "VNC":
      return <Monitor className="w-3.5 h-3.5" style={{ color: "#c97a23" }} />;
    case "SFTP":
    case "FTP":
      return <Folder className="w-3.5 h-3.5" style={{ color: "#3b7ac2" }} />;
    case "Rlogin":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#5b8a4a" }} />;
    case "Mosh":
      return <Server className="w-3.5 h-3.5" style={{ color: "#7a3d9d" }} />;
    case "Browser":
      return <Globe className="w-3.5 h-3.5" style={{ color: "#1e5fa8" }} />;
    case "Serial":
      return <Wifi className="w-3.5 h-3.5" style={{ color: "#236a98" }} />;
    case "WSL":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#0078d4" }} />;
    case "LocalShell":
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#62d36f" }} />;
    case "MySQL":
      return <Database className="w-3.5 h-3.5" style={{ color: "#00758f" }} />;
    case "PostgreSQL":
      return <Database className="w-3.5 h-3.5" style={{ color: "#336791" }} />;
    case "PanWeiDB":
      return <Database className="w-3.5 h-3.5" style={{ color: "#0b8f6a" }} />;
    case "Oracle":
      return <Database className="w-3.5 h-3.5" style={{ color: "#c74634" }} />;
    case "SQLServer":
      return <Database className="w-3.5 h-3.5" style={{ color: "#cc2927" }} />;
    case "StarRocks":
      return <Database className="w-3.5 h-3.5" style={{ color: "#0f8f8c" }} />;
    case "ClickHouse":
      return <Database className="w-3.5 h-3.5" style={{ color: "#e6a817" }} />;
    case "Redis":
      return <Database className="w-3.5 h-3.5" style={{ color: "#d82c20" }} />;
    case "Mail":
      return <Mail className="w-3.5 h-3.5" style={{ color: "#256f6a" }} />;
    case "File":
      return <FileText className="w-3.5 h-3.5" style={{ color: "var(--taomni-text-muted)" }} />;
    default:
      return <TerminalIcon className="w-3.5 h-3.5" style={{ color: "#2b5d8b" }} />;
  }
}
