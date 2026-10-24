import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, FolderPlus, GitBranch, MonitorSmartphone, Plus, Search, Terminal } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspacePlatformStore, type WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";

const PROTOCOL_BADGES: Record<string, string> = {
  terminal: "TERM",
  sftp: "SFTP",
  database: "DB",
  redis: "DB",
  "hbase-shell": "DB",
  rdp: "RDP",
  vnc: "VNC",
};

function badgeFor(tab: WorkspaceIsolatedTab): string | null {
  if (tab.kind === "git") return "GIT";
  if (tab.kind === "file") return "FILE";
  return PROTOCOL_BADGES[tab.kind] ?? null;
}

/**
 * Workspace tab strip for the shared ControlBar (v6.1 AC-07): the active
 * platform workspace's isolated tabs (editor / GIT / sessions) plus the `+`
 * menu that opens local terminals, any global session, or new files. Never
 * renders appStore tabs — the two runtimes stay isolated.
 */
export function WorkspaceTabStrip() {
  const t = useT();
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const workspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? workspaces[0];
  const setActiveWorkspaceTab = useWorkspacePlatformStore((s) => s.setActiveWorkspaceTab);
  const closeWorkspaceTab = useWorkspacePlatformStore((s) => s.closeWorkspaceTab);
  const openLocalTerminalInWorkspace = useWorkspacePlatformStore((s) => s.openLocalTerminalInWorkspace);
  const setSessionPickerOpen = useWorkspacePlatformStore((s) => s.setSessionPickerOpen);
  const pinnedSessionIds = workspace?.pinnedSessionIds ?? [];

  if (!workspace) return null;
  const activeTabId = workspace.activeTabId || "";

  return (
    <div data-testid="workspace-tab-strip" className="flex h-full min-w-0 flex-1 items-stretch">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        <button
          type="button"
          data-testid="workspace-tab-editor"
          data-tab-kind="editor"
          data-active={activeTabId === "" || undefined}
          title={workspace.name}
          className="flex h-full min-w-[92px] max-w-[185px] shrink-0 items-center gap-1.5 border-r px-2 text-[12px]"
          style={{
            borderColor: "var(--taomni-divider)",
            color: activeTabId === "" ? "var(--taomni-text)" : "var(--taomni-text-muted)",
            background: activeTabId === "" ? "var(--taomni-panel-bg)" : undefined,
          }}
          onClick={() => setActiveWorkspaceTab(workspace.id, "")}
        >
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{t("workspace.editorTab")}</span>
        </button>
        {workspace.openTabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-testid="workspace-tab-item"
              data-tab-kind={tab.kind}
              data-active={active || undefined}
              className="group flex h-full min-w-[92px] max-w-[185px] shrink-0 items-center gap-1.5 border-r px-2 text-[12px]"
              style={{
                borderColor: "var(--taomni-divider)",
                color: active ? "var(--taomni-text)" : "var(--taomni-text-muted)",
                background: active ? "var(--taomni-panel-bg)" : undefined,
              }}
            >
              <button
                type="button"
                data-testid={`workspace-tab-activate-${tab.id}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={tab.title}
                onClick={() => setActiveWorkspaceTab(workspace.id, tab.id)}
              >
                {tab.kind === "git" ? <GitBranch className="h-3.5 w-3.5 shrink-0" /> : null}
                {tab.kind === "terminal" ? <Terminal className="h-3.5 w-3.5 shrink-0" /> : null}
                {tab.kind === "sftp" ? <FolderPlus className="h-3.5 w-3.5 shrink-0" /> : null}
                {["database", "redis", "hbase-shell"].includes(tab.kind) ? <Search className="h-3.5 w-3.5 shrink-0" /> : null}
                {["rdp", "vnc"].includes(tab.kind) ? <MonitorSmartphone className="h-3.5 w-3.5 shrink-0" /> : null}
                {tab.kind === "file" ? <FileText className="h-3.5 w-3.5 shrink-0" /> : null}
                {badgeFor(tab) && (
                  <span
                    className="shrink-0 rounded px-1 text-[9px] font-semibold"
                    style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
                  >
                    {badgeFor(tab)}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              </button>
              {tab.closable && (
                <button
                  type="button"
                  data-testid={`workspace-tab-close-${tab.id}`}
                  title={t("workspace.closeTab")}
                  className="shrink-0 rounded px-0.5 opacity-60 hover:bg-[var(--taomni-hover)] hover:opacity-100"
                  onClick={() => closeWorkspaceTab(workspace.id, tab.id)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <WorkspacePlusMenu
        workspaceId={workspace.id}
        pinnedSessionIds={pinnedSessionIds}
        onNewLocalTerminal={() => openLocalTerminalInWorkspace(workspace.id)}
        onOpenPicker={() => setSessionPickerOpen(true)}
      />
    </div>
  );
}

function WorkspacePlusMenu({
  workspaceId,
  pinnedSessionIds,
  onNewLocalTerminal,
  onOpenPicker,
}: {
  workspaceId: string;
  pinnedSessionIds: string[];
  onNewLocalTerminal: () => void;
  onOpenPicker: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const rect = open ? anchorRef.current?.getBoundingClientRect() : null;
  return (
    <div ref={anchorRef} className="flex shrink-0 items-stretch self-stretch" data-testid="workspace-open-session-menu">
      <button
        type="button"
        data-testid="workspace-open-session-plus"
        title={t("workspace.openAnySessionHint")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-full w-7 items-center justify-center hover:bg-[var(--taomni-hover)]"
        style={{ color: "var(--taomni-text)" }}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus className="h-4 w-4" />
      </button>
      {open && rect && createPortal(
        <div
          ref={menuRef}
          role="menu"
          data-testid="workspace-open-session-plus-menu"
          className="fixed z-[9999] min-w-56 rounded border py-1 shadow-lg"
          style={{
            top: rect.bottom + 4,
            left: Math.max(8, rect.left),
            background: "var(--taomni-panel-bg)",
            borderColor: "var(--taomni-divider)",
            color: "var(--taomni-text)",
          }}
        >
          <MenuRow testId="workspace-plus-new-terminal" icon={<Terminal className="h-3.5 w-3.5" />} label={t("workspace.newLocalTerminal")} onClick={() => { setOpen(false); onNewLocalTerminal(); }} />
          <MenuRow testId="workspace-plus-open-session" icon={<Search className="h-3.5 w-3.5" />} label={`${t("workspace.openAnySession")} (Ctrl+Alt+O)`} onClick={() => { setOpen(false); onOpenPicker(); }} />
          {pinnedSessionIds.length > 0 && (
            <div className="mt-1 border-t px-3 py-1 text-[10px] uppercase" style={{ borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}>
              ★ {t("workspace.pinnedSessions")}
            </div>
          )}
          {pinnedSessionIds.map((sessionId) => (
            <PinnedMenuRow key={sessionId} workspaceId={workspaceId} sessionId={sessionId} onDone={() => setOpen(false)} />
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function PinnedMenuRow({ workspaceId, sessionId, onDone }: { workspaceId: string; sessionId: string; onDone: () => void }) {
  const session = useSessionStore((s) => s.sessions.find((entry) => entry.id === sessionId));
  const label = session?.name || session?.host || sessionId;
  return (
    <MenuRow
      testId={`workspace-plus-pinned-${sessionId}`}
      icon={<span className="text-[10px]">★</span>}
      label={label}
      onClick={() => {
        // The layout layer resolves auth and launches the isolated tab; the
        // event keeps the strip decoupled from the connection machinery.
        window.dispatchEvent(new CustomEvent("taomni:workspace-open-session", { detail: { workspaceId, sessionId } }));
        onDone();
      }}
    />
  );
}

function MenuRow({ testId, icon, label, onClick }: { testId: string; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
      onClick={onClick}
    >
      <span className="shrink-0" style={{ color: "var(--taomni-text-muted)" }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
