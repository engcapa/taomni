import { isWslExecutable } from "../../../types/wsl";
import { Braces, GitBranch, KeyRound, Network as NetworkIcon, Package, Server, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCustomDropTarget, type CustomDragData } from "../../../lib/customDnD";
import type { Tab } from "../../../types";
import { type TabItemProps } from "./model";
import { TAB_DRAG_MIME } from "./scroll";
import { ExplorerTabIcon } from "../../explorer/ExplorerTabIcon";
import { ExplorerFileIcon } from "../../explorer/ExplorerFileIcon";
import { SessionProtocolIcon } from "../../session/SessionProtocolIcon";
import { ViewerDirtyIndicator } from "../../viewer/ViewerDirtyIndicator";

export { dbEngineColor } from "../../session/SessionProtocolIcon";

export function TabIcon({ tab }: { tab: Tab; }) {
  switch (tab.type) {
    case "terminal": {
      const localProtocol = isWslExecutable(tab.localShell?.id) ? "WSL" : "LocalShell";
      const protocol = tab.ssh ? "SSH" : tab.commandTerminal?.kind ?? localProtocol;
      return <SessionProtocolIcon protocol={protocol} className="size-3" />;
    }
    case "mail":
    case "mail-unified":
      return <SessionProtocolIcon protocol="Mail" className="size-3" />;
    case "database":
      return <SessionProtocolIcon database protocol={tab.db?.engine ?? "database"} className="size-3" />;
    case "redis":
      return <SessionProtocolIcon database protocol={tab.db?.engine ?? "Redis"} className="size-3" />;
    case "hbase-shell":
      return <SessionProtocolIcon protocol="HBaseShell" className="size-3" />;
    case "sftp":
      return <SessionProtocolIcon protocol="SFTP" className="size-3" />;
    case "rdp":
      return <SessionProtocolIcon protocol="RDP" className="size-3" />;
    case "vnc":
      return <SessionProtocolIcon protocol="VNC" className="size-3" />;
    case "nettools":
      return <NetworkIcon className="w-3 h-3" style={{ color: "var(--taomni-accent)" }} />;
    case "sockscap":
      return <NetworkIcon className="w-3 h-3" style={{ color: "var(--taomni-success-text)" }} />;
    case "proxy-test":
      return <NetworkIcon className="w-3 h-3" style={{ color: "var(--taomni-text-muted)" }} />;
    case "git":
      return <GitBranch className="w-3 h-3" style={{ color: "var(--taomni-danger-text)" }} />;
    case "code-workspace":
      return <Braces className="w-3 h-3" style={{ color: "var(--taomni-accent)" }} />;
    case "mfa":
      return <KeyRound className="w-3 h-3" style={{ color: "var(--taomni-warning-text)" }} />;
    case "servers":
      return <Server className="w-3 h-3" style={{ color: "var(--taomni-accent)" }} />;
    case "plugin":
      return <Package className="w-3 h-3" />;
    case "file-browser":
      return <ExplorerTabIcon />;
    case "file-viewer":
      return <ExplorerFileIcon name={tab.fileViewer?.path ?? tab.title} className="w-4 h-4" />;
    default:
      return <SessionProtocolIcon protocol={tab.type} className="size-3" />;
  }
}

export function IconBtn({
  icon,
  title,
  onClick,
  disabled,
  active,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: (event: React.MouseEvent) => void;
  disabled?: boolean;
  active?: boolean;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      title={title}
      aria-label={title}
      data-active={active || undefined}
      className="w-6 h-6 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-default"
      style={active ? { background: "var(--taomni-selected)", color: "var(--taomni-accent)" } : undefined}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {icon}
    </button>
  );
}

export function TabItem(props: TabItemProps) {
  const {
    tab,
    translate: t,
    active,
    multiExecActive,
    multiExecSelected,
    dragging,
    draggedId,
    dropSide,
    editing,
    draftTitle,
    onElementChange,
    onStartDrag,
    onDragOverTab,
    onDragLeaveTab,
    onDropOnTab,
    onActivate,
    onMouseDown,
    onContextMenu,
    onDraftTitleChange,
    onCommitRename,
    onCancelRename,
    onStartRename,
    onShowDetails,
    onHideDetails,
    onToggleMultiExecTab,
    onRemove,
  } = props;

  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onElementChange(tab.id, ref.current);
    return () => onElementChange(tab.id, null);
  }, [onElementChange, tab.id]);

  useCustomDropTarget<HTMLDivElement>(ref, {
    accepts: (data: CustomDragData) => data.mime === TAB_DRAG_MIME && draggedId !== null,
    onDragOver: (detail) => {
      const el = ref.current;
      if (!el) return;
      onDragOverTab(tab, el.getBoundingClientRect(), detail.clientX);
    },
    onDragLeave: () => onDragLeaveTab(tab),
    onDrop: (detail) => {
      const el = ref.current;
      if (!el) return;
      onDropOnTab(tab, el.getBoundingClientRect(), detail.clientX);
    },
  });

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-testid="tab-item"
      data-tab-id={tab.id}
      data-tab-title={tab.title}
      data-tab-type={tab.type}
      data-multiexec-selected={multiExecSelected || undefined}
      data-dragging={dragging || undefined}
      data-drop-side={dropSide}
      className="taomni-tab relative"
      data-active={active}
      onClick={() => onActivate(tab)}
      onKeyDown={(event) => { if (!editing && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onActivate(tab); } }}
      onMouseDown={(e) => {
        if (editing) return;
        // Activate on the trusted press as well as click. Some packaged
        // WebViews can lose the compatibility click while the pointer drag
        // helper is arming, leaving a clicked tab mounted but inactive.
        if (e.button === 0) onActivate(tab);
        onMouseDown(e, tab);
      }}
      onPointerDown={(e) => {
        if (editing) return;
        // WebKit can deliver the pointer press without a compatible mouse
        // activation when the tab drag helper is armed. Activate on the
        // pointer itself so a terminal/viewer tab never remains visually
        // selected while its content stays in the background.
        if (e.button === 0) onActivate(tab);
        const el = ref.current;
        if (!el) return;
        onStartDrag(e, tab, el);
      }}
      onContextMenu={(e) => onContextMenu(e, tab)}
    >
      {multiExecActive && tab.type === "terminal" && (
        <input
          type="checkbox"
          data-testid="tab-multiexec-checkbox"
          checked={multiExecSelected}
          aria-label={`${t("multiExec.title")}: ${tab.title}`}
          title={multiExecSelected ? t("tabs.multiExecRemove") : t("tabs.multiExecAdd")}
          className="taomni-checkbox h-3.5 w-3.5 shrink-0"
          onChange={() => onToggleMultiExecTab(tab.id)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}
      {tab.fileViewer && <ViewerDirtyIndicator path={tab.fileViewer.path} />}
      <div className="relative flex-shrink-0">
        <TabIcon tab={tab} />
        {tab.hasNewOutput && (
          <span
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--taomni-success-icon)] pointer-events-none"
            aria-label={t("tabs.newOutput")}
          />
        )}
      </div>
      <span
        data-testid="tab-title"
        className="truncate max-w-[180px]"
        onMouseEnter={() => onShowDetails(tab.id)}
        onMouseLeave={() => onHideDetails(tab.id)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onStartRename(tab);
        }}
      >
        {editing ? (
          <input
            data-testid="tab-title-input"
            autoFocus
            type="text"
            value={draftTitle}
            onChange={(e) => onDraftTitleChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelRename();
              }
              e.stopPropagation();
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={onCommitRename}
            className="bg-transparent border-b border-[var(--taomni-accent)] focus-visible:keyboard-outline text-ui-body leading-none w-[160px] px-0"
            style={{ color: "inherit", font: "inherit" }}
          />
        ) : (
          tab.title
        )}
      </span>
      {tab.closable && (
        <X
          data-testid="tab-close"
          className="w-3 h-3 ml-1 opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(tab.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          // Activating the tab on mousedown can restore its sidebar layout
          // and move this close target before the release/click arrives.
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
