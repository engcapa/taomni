import { Braces, Database as DatabaseIcon, FileText, Folder, GitBranch, KeyRound, Monitor, Network as NetworkIcon, Terminal as TerminalIcon, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCustomDropTarget, type CustomDragData } from "../../../lib/customDnD";
import type { Tab } from "../../../types";
import { type TabItemProps } from "./model";
import { TAB_DRAG_MIME } from "./scroll";

export function dbEngineColor(engine?: string): string {
  switch (engine) {
    case "MySQL":
      return "#00758f";
    case "PostgreSQL":
      return "#336791";
    case "PanWeiDB":
      return "#0b8f6a";
    case "Oracle":
      return "#c74634";
    case "SQLServer":
      return "#cc2927";
    case "StarRocks":
      return "#0f8f8c";
    case "ClickHouse":
      return "#e6a817";
    case "Presto":
      return "#5a4fcf";
    case "Redis":
      return "#d82c20";
    case "HBaseShell":
      return "#1d7f8c";
    default:
      return "#2b5d8b";
  }
}

export function TabIcon({ tab }: { tab: Tab; }) {
  if (tab.type === "terminal" && tab.ssh) {
    return <TerminalIcon className="w-3 h-3" style={{ color: "#2b5d8b" }} />;
  }
  switch (tab.type) {
    case "terminal":
      return <TerminalIcon className="w-3 h-3" style={{ color: "#62d36f" }} />;
    case "database":
    case "redis":
      return <DatabaseIcon className="w-3 h-3" style={{ color: dbEngineColor(tab.db?.engine) }} />;
    case "hbase-shell":
      return <DatabaseIcon className="w-3 h-3" style={{ color: dbEngineColor("HBaseShell") }} />;
    case "sftp":
      return <Folder className="w-3 h-3" style={{ color: "#3b7ac2" }} />;
    case "rdp":
    case "vnc":
      return <Monitor className="w-3 h-3" style={{ color: "#a04b9c" }} />;
    case "nettools":
      return <NetworkIcon className="w-3 h-3" style={{ color: "#236a98" }} />;
    case "sockscap":
      return <NetworkIcon className="w-3 h-3" style={{ color: "#0d9488" }} />;
    case "proxy-test":
      return <NetworkIcon className="w-3 h-3" style={{ color: "#6b7280" }} />;
    case "git":
      return <GitBranch className="w-3 h-3" style={{ color: "#e05a47" }} />;
    case "code-workspace":
      return <Braces className="w-3 h-3" style={{ color: "#2878d4" }} />;
    case "mfa":
      return <KeyRound className="w-3 h-3" style={{ color: "#c98a00" }} />;
    case "file-browser":
      return <FileText className="w-3 h-3" style={{ color: "var(--taomni-text-muted)" }} />;
    default:
      return <TerminalIcon className="w-3 h-3" style={{ color: "#2b5d8b" }} />;
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
        onMouseDown(e, tab);
      }}
      onPointerDown={(e) => {
        if (editing) return;
        const el = ref.current;
        if (!el) return;
        onStartDrag(e, tab, el);
      }}
      onContextMenu={(e) => onContextMenu(e, tab)}
    >
      {multiExecActive && tab.type === "terminal" && (
        <button
          type="button"
          title={multiExecSelected ? t("tabs.multiExecRemove") : t("tabs.multiExecAdd")}
          className="absolute -top-0.5 -left-0.5 w-3 h-3 rounded-full border flex items-center justify-center z-10 flex-shrink-0"
          style={{
            background: multiExecSelected ? "var(--taomni-accent)" : "var(--taomni-chrome-bg)",
            borderColor: multiExecSelected ? "var(--taomni-accent)" : "var(--taomni-divider)",
            fontSize: 7,
            color: multiExecSelected ? "#fff" : "var(--taomni-text-muted)",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleMultiExecTab(tab.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {multiExecSelected ? "✓" : ""}
        </button>
      )}
      <div className="relative flex-shrink-0">
        <TabIcon tab={tab} />
        {tab.hasNewOutput && (
          <span
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 pointer-events-none"
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
            className="bg-transparent border-b border-[var(--taomni-accent)] outline-none text-[12px] leading-none w-[160px] px-0"
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
        />
      )}
    </div>
  );
}
