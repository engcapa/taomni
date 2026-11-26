import { showAgentsComingSoon } from "../agents/comingSoon";
import { Boxes, FileText, KeyRound, MonitorSmartphone, Search, Server, Settings, Terminal, Wrench } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ModalSurface } from "../ui/ModalSurface";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

type ResultKind = "workspace" | "file" | "session" | "tool";

interface CommandResult {
  id: string;
  kind: ResultKind;
  title: string;
  detail: string;
  icon: ReactNode;
  run: () => void;
}

/**
 * `Ctrl+K` command palette (TASK-09).
 *
 * Searches workspaces, the files open in workspace tabs, global sessions and
 * shell actions; Enter runs the top (or selected) result. Workspace sessions
 * are opened as isolated workspace instances, never in Sessions mode.
 */
export function GlobalCommandModal() {
  const open = useWorkspaceUiStore((s) => s.globalSearchOpen);
  return open ? <OpenGlobalCommandModal /> : null;
}

// Keep the search index and its data subscriptions with the visible dialog.
// Opening takes fresh store snapshots; closing releases listeners and focus work.
function OpenGlobalCommandModal() {
  const t = useT();
  const close = useWorkspaceUiStore((s) => s.closeGlobalSearch);
  const openSessionPicker = useWorkspaceUiStore((s) => s.openSessionPicker);
  const workspaces = useWorkspacePlatformStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspacePlatformStore((s) => s.setActiveWorkspace);
  const openSessionInWorkspace = useWorkspacePlatformStore((s) => s.openSessionInWorkspace);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const toggleFloatingMfa = useAppStore((s) => s.toggleFloatingMfa);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo<CommandResult[]>(() => {
    const list: CommandResult[] = [];

    list.push({
      id: "mode-home",
      kind: "tool",
      title: t("platform.home"),
      detail: t("platform.commandTool"),
      icon: <Boxes className="h-3.5 w-3.5" />,
      run: () => setActiveSideTab("home"),
    });
    list.push({
      id: "mode-sessions",
      kind: "tool",
      title: t("platform.sessions"),
      detail: t("platform.commandTool"),
      icon: <Terminal className="h-3.5 w-3.5" />,
      run: () => setActiveSideTab("sessions"),
    });
    list.push({
      id: "mode-agents",
      kind: "tool",
      title: t("platform.agentsTitle"),
      detail: t("platform.commandTool"),
      icon: <Wrench className="h-3.5 w-3.5" />,
      run: showAgentsComingSoon,
    });
    list.push({
      id: "open-any-session",
      kind: "tool",
      title: t("platform.openAnySession"),
      detail: "Ctrl+Alt+O",
      icon: <Search className="h-3.5 w-3.5" />,
      run: () => openSessionPicker(activeWorkspaceId),
    });
    list.push({
      id: "floating-mfa",
      kind: "tool",
      title: t("platform.mfaTitle"),
      detail: t("platform.commandTool"),
      icon: <KeyRound className="h-3.5 w-3.5" />,
      run: () => toggleFloatingMfa(),
    });
    list.push({
      id: "settings",
      kind: "tool",
      title: t("platform.settings"),
      detail: t("platform.commandTool"),
      icon: <Settings className="h-3.5 w-3.5" />,
      run: () => window.dispatchEvent(new CustomEvent("taomni:command", { detail: "settings" })),
    });
    list.push({
      id: "servers",
      kind: "tool",
      title: t("servers.dialogTitle"),
      detail: t("platform.commandTool"),
      icon: <Server className="h-3.5 w-3.5" />,
      run: () => window.dispatchEvent(new CustomEvent("taomni:command", { detail: "servers" })),
    });

    for (const workspace of workspaces) {
      list.push({
        id: `ws-${workspace.id}`,
        kind: "workspace",
        title: workspace.name,
        detail: `${workspace.rootFolders.length} roots · ${workspace.openTabs.length} tabs`,
        icon: <Boxes className="h-3.5 w-3.5" />,
        run: () => {
          setActiveWorkspace(workspace.id);
          setActiveSideTab("workspaces");
          setSidebarCollapsed(false);
        },
      });
      for (const tab of workspace.openTabs) {
        if (tab.kind !== "file" && tab.kind !== "git") continue;
        list.push({
          id: `file-${workspace.id}-${tab.id}`,
          kind: "file",
          title: tab.filePath ?? tab.title,
          detail: workspace.name,
          icon: <FileText className="h-3.5 w-3.5" />,
          run: () => {
            setActiveWorkspace(workspace.id);
            setActiveSideTab("workspaces");
            useWorkspacePlatformStore.getState().setActiveWorkspaceTab(workspace.id, tab.id);
          },
        });
      }
    }

    for (const session of sessions) {
      list.push({
        id: `session-${session.id}`,
        kind: "session",
        title: session.name || session.host,
        detail: `${session.session_type} · ${session.username ? `${session.username}@` : ""}${session.host}`,
        icon: <MonitorSmartphone className="h-3.5 w-3.5" />,
        run: () => {
          openSessionInWorkspace(activeWorkspaceId, session);
          setActiveSideTab("workspaces");
          setSidebarCollapsed(false);
        },
      });
    }

    const needle = query.trim().toLowerCase();
    if (!needle) return list.slice(0, 40);
    return list
      .filter((entry) => entry.title.toLowerCase().includes(needle) || entry.detail.toLowerCase().includes(needle))
      .slice(0, 40);
  }, [
    activeWorkspaceId,
    openSessionPicker,
    openSessionInWorkspace,
    query,
    sessions,
    setActiveSideTab,
    setActiveWorkspace,
    setSidebarCollapsed,
    t,
    toggleFloatingMfa,
    workspaces,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const runResult = (result: CommandResult | undefined) => {
    if (!result) return;
    result.run();
    close();
  };

  return createPortal(
    <ModalSurface
      dismissOnBackdrop
      initialFocus='[data-testid="global-search-input"]'
      onCancel={close}
      data-testid="global-search-modal"
      aria-label={t("platform.globalSearchTitle")}
      className="mx-auto mt-[10vh] mb-auto p-0 open:flex max-h-[70vh] w-[640px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border shadow-2xl backdrop:bg-[var(--taomni-overlay)]"
      style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-panel-bg)", color: "var(--taomni-text)" }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((index) => Math.min(results.length - 1, index + 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((index) => Math.max(0, index - 1));
        } else if (event.key === "Enter") {
          event.preventDefault();
          runResult(results[activeIndex]);
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--taomni-divider)" }}>
        <Search className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--taomni-text-muted)" }} />
        <input
          data-testid="global-search-input"
          className="taomni-input h-7 min-w-0 flex-1"
          aria-label={t("platform.globalSearchTitle")}
          placeholder={t("platform.globalSearchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="shrink-0 rounded px-1 text-ui-caption" style={{ border: "1px solid var(--taomni-divider)", color: "var(--taomni-text-muted)" }}>Ctrl+K</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5" data-testid="global-search-results">
        {results.length === 0 && (
          <div className="px-2 py-3 text-ui-body" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.globalSearchEmpty")}</div>
        )}
        {results.map((result, index) => (
          <button
            key={result.id}
            type="button"
            data-testid="global-search-result"
            data-kind={result.kind}
            data-result-id={result.id}
            aria-selected={index === activeIndex}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--taomni-hover)]"
            style={{ background: index === activeIndex ? "var(--taomni-selected)" : "transparent" }}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => runResult(result)}
          >
            <span className="shrink-0" style={{ color: "var(--taomni-text-muted)" }}>{result.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui-body">{result.title}</span>
              <span className="block truncate text-ui-caption" style={{ color: "var(--taomni-text-muted)" }}>{result.detail}</span>
            </span>
            <span className="shrink-0 text-ui-caption uppercase" style={{ color: "var(--taomni-text-muted)" }}>{result.kind}</span>
          </button>
        ))}
      </div>
    </ModalSurface>,
    document.body,
  );
}
