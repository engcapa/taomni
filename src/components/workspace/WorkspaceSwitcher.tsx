import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderOpen, Plus } from "lucide-react";
import { useT } from "../../lib/i18n";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

/**
 * Workspace switcher at the top of the Workspaces sidebar (v6.1 AC-05):
 * selects the active platform workspace, creates new ones, and offers the
 * add-folder shortcut. The default workspace is always listed and badged.
 */
export function WorkspaceSwitcher({ onAddFolder, onCreateWorkspace }: { onAddFolder: () => void; onCreateWorkspace: () => void }) {
  const t = useT();
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspacePlatformStore((s) => s.setActiveWorkspace);
  const active = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? workspaces[0];
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="shrink-0 border-b px-2 py-2" style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-sidebar-bg)" }}>
      <div className="mb-1 flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--taomni-text-muted)" }}>
        <span>{t("workspace.switcherTitle")}</span>
        <span className="tabular-nums">{workspaces.length}</span>
      </div>
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          data-testid="workspace-switcher"
          aria-haspopup="menu"
          aria-expanded={open}
          title={active?.name ?? ""}
          className="flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-[12px]"
          style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
          onClick={() => setOpen((value) => !value)}
        >
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: active?.isDefault ? "#2ea043" : "#8957e5" }}
          />
          <span className="min-w-0 flex-1 truncate font-medium">{active?.name ?? "—"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </button>
        {open && (
          <div
            role="menu"
            data-testid="workspace-switcher-menu"
            className="absolute left-0 right-0 top-full z-40 mt-1 rounded border py-1 shadow-lg"
            style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)" }}
          >
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
                data-testid={`workspace-switcher-item-${workspace.id}`}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
                style={{ color: "var(--taomni-text)" }}
                onClick={() => {
                  setActiveWorkspace(workspace.id);
                  setOpen(false);
                }}
              >
                <span className="w-4 shrink-0">
                  {workspace.id === activeWorkspaceId ? <Check className="h-3.5 w-3.5" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {workspace.isDefault && (
                  <span
                    data-testid="workspace-switcher-default-badge"
                    className="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
                    style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
                  >
                    {workspace.id === DEFAULT_WORKSPACE_ID ? t("workspace.defaultBadge") : t("workspace.defaultBadge")}
                  </span>
                )}
                <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--taomni-text-muted)" }}>
                  {workspace.rootFolders.length}
                </span>
              </button>
            ))}
            <div className="my-1 h-px" style={{ background: "var(--taomni-divider)" }} />
            <button
              type="button"
              role="menuitem"
              data-testid="workspace-switcher-new"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
              style={{ color: "var(--taomni-text)" }}
              onClick={() => {
                setOpen(false);
                onCreateWorkspace();
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("workspace.newWorkspace")}
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="workspace-switcher-add-folder"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
              style={{ color: "var(--taomni-text)" }}
              onClick={() => {
                setOpen(false);
                onAddFolder();
              }}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("workspace.addFolder")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
