import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import { ContextMenu } from "../ContextMenu";
import { useAppDialogs } from "../../lib/appDialogs";
import { useT } from "../../lib/i18n";
import {
  DEFAULT_WORKSPACE_ID,
  useWorkspacePlatformStore,
  type PlatformWorkspace,
} from "../../stores/workspacePlatformStore";

export interface WorkspaceSwitcherProps {
  onAddFolder: () => void;
}

/**
 * Workspace switcher at the top of the Workspaces left sidebar (AC-05).
 * The default workspace always exists, carries the DEFAULT badge, and cannot
 * be deleted.
 */
export function WorkspaceSwitcher({ onAddFolder }: WorkspaceSwitcherProps) {
  const t = useT();
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspacePlatformStore((s) => s.setActiveWorkspace);
  const createWorkspace = useWorkspacePlatformStore((s) => s.createWorkspace);
  const renameWorkspace = useWorkspacePlatformStore((s) => s.renameWorkspace);
  const deleteWorkspace = useWorkspacePlatformStore((s) => s.deleteWorkspace);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dialogs = useAppDialogs();
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];

  if (!active) return null;

  const workspaceMenu = (workspace: PlatformWorkspace) => workspace.id === DEFAULT_WORKSPACE_ID
    ? [{
        label: t("platform.addFolderToWorkspace"),
        testId: "workspace-switcher-menu-add-folder",
        onClick: onAddFolder,
      }]
    : [
        {
          label: t("platform.addFolderToWorkspace"),
          testId: "workspace-switcher-menu-add-folder",
          onClick: onAddFolder,
        },
        {
          label: t("platform.rename"),
          testId: "workspace-switcher-menu-rename",
          onClick: () => {
            void dialogs.prompt({
              title: t("platform.rename"),
              label: t("platform.workspaceName"),
              initialValue: workspace.name,
            }).then((next) => {
              if (next?.trim()) renameWorkspace(workspace.id, next);
            });
          },
        },
        { label: "", separator: true, onClick: () => undefined },
        {
          label: t("platform.deleteWorkspace"),
          testId: "workspace-switcher-menu-delete",
          danger: true,
          onClick: () => {
            if (!deleteWorkspace(workspace.id)) {
              window.alert(t("platform.defaultWorkspaceLocked"));
            }
          },
        },
      ];

  return (
    <div className="shrink-0 px-1.5 pb-1 pt-1.5" data-testid="workspace-switcher" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--taomni-text-muted)]">
          {t("platform.workspaceSwitcher")}
        </span>
        <button
          type="button"
          data-testid="workspace-create-button"
          className="inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-semibold"
          style={{ color: "var(--taomni-accent)" }}
          onClick={() => {
            void dialogs.prompt({
              title: t("platform.newWorkspace"),
              label: t("platform.workspaceName"),
              initialValue: "Workspace",
            }).then((name) => {
              if (name?.trim()) createWorkspace({ name });
            });
          }}
        >
          <Plus className="w-3 h-3" />
          {t("platform.newWorkspace")}
        </button>
      </div>
      <button
        type="button"
        data-testid="workspace-switcher-button"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={t("platform.workspaceSwitcher")}
        className="mt-1 flex w-full items-center justify-between gap-1 rounded border px-1.5 py-1 text-left hover:bg-[var(--taomni-hover)]"
        style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-card-bg)" }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 2 });
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: active.isDefault ? "var(--taomni-success)" : "var(--taomni-accent)" }}
          />
          <span className="truncate text-[var(--taomni-text)]" style={{ fontSize: "var(--taomni-ui-font-size)" }}>
            {active.name}
          </span>
          {active.isDefault && (
            <span
              data-testid="workspace-default-badge"
              className="shrink-0 rounded px-1 text-[9px] font-semibold"
              style={{ border: "1px solid var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
            >
              {t("platform.workspaceDefaultBadge")}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
          <span data-testid="workspace-switcher-root-count">{active.rootFolders.length}</span>
          <ChevronDown className="h-3 w-3" />
        </span>
      </button>
      {menu && (
        <ContextMenu
          testId="workspace-switcher-menu"
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...workspaces.map((workspace) => ({
              label: workspace.isDefault ? `${workspace.name} · ${t("platform.workspaceDefaultBadge")}` : workspace.name,
              testId: `workspace-switcher-option-${workspace.id}`,
              checked: workspace.id === active.id,
              onClick: () => setActiveWorkspace(workspace.id),
            })),
            { label: "", separator: true, onClick: () => undefined },
            {
              label: t("platform.newWorkspace"),
              testId: "workspace-switcher-new",
              onClick: () => {
                const name = window.prompt(t("platform.workspaceName"), "Workspace");
                if (name?.trim()) createWorkspace({ name });
              },
            },
            {
              label: t("platform.addFolderToWorkspace"),
              testId: "workspace-switcher-add-folder",
              onClick: onAddFolder,
            },
            { label: "", separator: true, onClick: () => undefined },
            ...workspaceMenu(active),
          ]}
        />
      )}
    </div>
  );
}
