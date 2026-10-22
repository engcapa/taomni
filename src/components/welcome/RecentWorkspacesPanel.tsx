import { Plus, FolderOpen, Folder, Search, X, Copy, Trash2, ListTree } from "lucide-react";
import { writeText } from "../../lib/clipboard";
import { useAppStore } from "../../stores/appStore";
import type { RecentWorkspace } from "../../types";
import { type TranslateFn } from "../../lib/i18n";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import { formatRecentSessionTime } from "./sessionModel";


export function RecentWorkspacesPanel({
  translate: t,
  workspaces,
  filteredWorkspaces,
  query,
  onQueryChange,
  onClearFilter,
  onOpenWorkspace,
  onRemoveWorkspace,
  onClearWorkspaces,
  onRevealWorkspace,
  onOpenNewWorkspace,
}: {
  translate: TranslateFn;
  workspaces: RecentWorkspace[];
  filteredWorkspaces: RecentWorkspace[];
  query: string;
  onQueryChange: (value: string) => void;
  onClearFilter: () => void;
  onOpenWorkspace?: (workspace: RecentWorkspace) => void;
  onRemoveWorkspace?: (workspace: RecentWorkspace) => void;
  onClearWorkspaces?: () => void;
  onRevealWorkspace?: (workspace: RecentWorkspace) => void;
  onOpenNewWorkspace?: () => void;
}) {
  const hasFilter = query.trim().length > 0;
  const ctx = useContextMenu();
  const clearConfirm = useConfirmDialog();
  const { setStatusMessage } = useAppStore();

  const copyWorkspacePath = (workspace: RecentWorkspace) => {
    const path = recentWorkspacePrimaryPath(workspace);
    if (!path) return;
    void writeText(path)
      .then(() => setStatusMessage(t("welcome.recentWorkspacesPathCopied")))
      .catch((error) => setStatusMessage(t("welcome.recentWorkspacesPathCopyFailed", { error: String(error) })));
  };

  const confirmClearWorkspaces = async () => {
    if (!onClearWorkspaces || workspaces.length === 0) return;
    const confirmed = await clearConfirm.confirm({
      title: t("welcome.recentWorkspacesClearTitle"),
      message: t("welcome.recentWorkspacesClearMessage"),
      confirmLabel: t("welcome.recentWorkspacesClearConfirm"),
      danger: true,
    });
    if (confirmed) onClearWorkspaces();
  };

  return (
    <section
      data-testid="welcome-recent-workspaces"
      className="min-w-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-[min(100%,240px)] flex-[1_1_240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <input
            data-testid="welcome-recent-workspace-filter"
            className="taomni-input h-8 w-full"
            style={{ paddingLeft: "2rem" }}
            type="search"
            aria-label={t("welcome.recentWorkspacesSearch")}
            placeholder={t("welcome.recentWorkspacesSearch")}
            value={query}
            disabled={workspaces.length === 0}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <button
          data-testid="welcome-recent-workspace-clear-filter"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center justify-center gap-1.5"
          type="button"
          disabled={!hasFilter}
          onClick={onClearFilter}
        >
          <X className="w-3.5 h-3.5" />
          <span>{t("welcome.recentWorkspacesClearFilter")}</span>
        </button>
        <div className="h-6 w-px" style={{ background: "var(--taomni-divider)" }} />
        <button
          data-testid="welcome-recent-workspace-open-new"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!onOpenNewWorkspace}
          onClick={onOpenNewWorkspace}
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t("welcome.recentWorkspacesOpenNew")}</span>
        </button>
        <button
          data-testid="welcome-recent-workspace-clear-all"
          className="taomni-btn h-8 max-w-full px-3 inline-flex items-center gap-1.5"
          type="button"
          disabled={!onClearWorkspaces || workspaces.length === 0}
          onClick={() => void confirmClearWorkspaces()}
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>{t("welcome.recentWorkspacesClearAll")}</span>
        </button>
      </div>

      <div className="mt-3 max-h-[220px] overflow-auto">
        {workspaces.length === 0 ? (
          <div
            data-testid="welcome-recent-workspace-empty"
            className="py-4 text-[12px] text-[var(--taomni-text-muted)]"
          >
            {t("welcome.recentWorkspacesEmpty")}
          </div>
        ) : filteredWorkspaces.length === 0 ? (
          <div
            data-testid="welcome-recent-workspace-no-matches"
            className="py-4 text-[12px] text-[var(--taomni-text-muted)]"
          >
            {t("welcome.recentWorkspacesNoMatches")}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredWorkspaces.map((workspace) => {
              const primaryPath = recentWorkspacePrimaryPath(workspace);
              const meta = recentWorkspaceMeta(workspace, t);
              return (
                <div
                  key={workspace.id}
                  data-testid="welcome-recent-workspace-row"
                  data-workspace-id={workspace.id}
                  data-workspace-name={workspace.name}
                  data-workspace-path={primaryPath}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded border px-2 py-1.5"
                  style={{
                    borderColor: "var(--taomni-divider)",
                    background: "var(--taomni-input-bg)",
                  }}
                  role={onOpenWorkspace ? "button" : undefined}
                  tabIndex={onOpenWorkspace ? 0 : undefined}
                  onClick={() => onOpenWorkspace?.(workspace)}
                  onKeyDown={(event) => {
                    if (!onOpenWorkspace) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenWorkspace(workspace);
                    }
                  }}
                  onContextMenu={(event) => {
                    ctx.show(event, recentWorkspaceMenuItems({
                      t,
                      workspace,
                      onOpenWorkspace,
                      onRevealWorkspace,
                      onRemoveWorkspace,
                      onCopyPath: copyWorkspacePath,
                    }));
                  }}
                >
                  <div className="min-w-0 text-left">
                    <div className="min-w-0 flex items-center gap-2">
                      <Folder className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                      <span className="min-w-0 truncate text-[12px] font-medium text-[var(--taomni-accent)]">
                        {workspace.name}
                      </span>
                      <span className="shrink-0 text-[10px] taomni-mono px-1.5 py-0.5 rounded border text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                        {workspace.isGitRepo ? t("welcome.recentWorkspacesGit") : t("welcome.recentWorkspacesFolder")}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-[var(--taomni-text-muted)]">
                      {primaryPath} · {meta} · {t("welcome.recentWorkspacesUpdated", { time: formatRecentSessionTime(workspace.lastOpenedAt, t) })}
                    </div>
                  </div>
                  <button
                    data-testid="welcome-recent-workspace-copy-path"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    title={t("welcome.recentWorkspacesCopyPath")}
                    aria-label={t("welcome.recentWorkspacesCopyPath")}
                    onClick={(event) => {
                      event.stopPropagation();
                      copyWorkspacePath(workspace);
                    }}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    data-testid="welcome-recent-workspace-reveal"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    disabled={!onRevealWorkspace}
                    title={t("welcome.recentWorkspacesReveal")}
                    aria-label={t("welcome.recentWorkspacesRevealAria", { name: workspace.name })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRevealWorkspace?.(workspace);
                    }}
                  >
                    <ListTree className="w-3.5 h-3.5" />
                  </button>
                  <button
                    data-testid="welcome-recent-workspace-remove"
                    className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
                    type="button"
                    disabled={!onRemoveWorkspace}
                    title={t("welcome.recentWorkspacesRemove")}
                    aria-label={t("welcome.recentWorkspacesRemoveAria", { name: workspace.name })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveWorkspace?.(workspace);
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {ctx.render}
      {clearConfirm.render}
    </section>
  );
}


export function recentWorkspacePrimaryPath(workspace: RecentWorkspace): string {
  return workspace.roots[0]?.path ?? workspace.looseFiles[0]?.path ?? "";
}


export function recentWorkspaceMeta(workspace: RecentWorkspace, t: TranslateFn): string {
  const parts = [
    workspace.roots.length > 0 ? t("welcome.recentWorkspacesRoots", { count: workspace.roots.length }) : "",
    workspace.looseFiles.length > 0 ? t("welcome.recentWorkspacesLooseFiles", { count: workspace.looseFiles.length }) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : t("welcome.recentWorkspacesNoRoots");
}


export function recentWorkspaceMenuItems({
  t,
  workspace,
  onOpenWorkspace,
  onRevealWorkspace,
  onRemoveWorkspace,
  onCopyPath,
}: {
  t: TranslateFn;
  workspace: RecentWorkspace;
  onOpenWorkspace?: (workspace: RecentWorkspace) => void;
  onRevealWorkspace?: (workspace: RecentWorkspace) => void;
  onRemoveWorkspace?: (workspace: RecentWorkspace) => void;
  onCopyPath: (workspace: RecentWorkspace) => void;
}): MenuItem[] {
  return [
    {
      label: t("welcome.recentWorkspacesOpen"),
      testId: "context-menu-item-open-workspace",
      icon: <FolderOpen className="w-3 h-3" />,
      disabled: !onOpenWorkspace,
      onClick: () => onOpenWorkspace?.(workspace),
    },
    {
      label: t("welcome.recentWorkspacesReveal"),
      testId: "context-menu-item-reveal-workspace",
      icon: <ListTree className="w-3 h-3" />,
      disabled: !onRevealWorkspace,
      onClick: () => onRevealWorkspace?.(workspace),
    },
    {
      label: t("welcome.recentWorkspacesCopyPath"),
      testId: "context-menu-item-copy-workspace-path",
      icon: <Copy className="w-3 h-3" />,
      disabled: !recentWorkspacePrimaryPath(workspace),
      onClick: () => onCopyPath(workspace),
    },
    { label: "", separator: true },
    {
      label: t("welcome.recentWorkspacesRemove"),
      testId: "context-menu-item-remove-workspace",
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      disabled: !onRemoveWorkspace,
      onClick: () => onRemoveWorkspace?.(workspace),
    },
  ];
}
