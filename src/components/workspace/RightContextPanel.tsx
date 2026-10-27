import { useContextPanelWidth } from "./useContextPanelWidth";
import { Bot, X } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { useChatStore } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { outlineSymbols, useWorkspaceEditorStore } from "../../stores/workspaceEditorStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

/**
 * Right context sidebar (`◨`, AC-01).
 *
 * A collapsible companion surface: the active workspace file's structure or a
 * shortcut into the Tao assistant. It is deliberately narrow so the main canvas
 * keeps the focus, and it hides in Home mode like the left navigator.
 */
export function RightContextPanel() {
  const t = useT();
  const panelWidth = useContextPanelWidth();
  const collapsed = useAppStore((s) => s.rightSidebarCollapsed);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const setDrawerOpen = useChatStore((s) => s.setDrawerOpen);
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((candidate) => candidate.id === s.activeWorkspaceId));
  const documents = useWorkspaceEditorStore((s) => s.documents);
  const [tab, setTab] = useState<"structure" | "ai">("structure");

  if (collapsed) return null;

  const activeTab = workspace?.openTabs.find((candidate) => candidate.id === workspace.activeTabId);
  const document = activeTab ? documents[activeTab.id] : undefined;
  const symbols = document ? outlineSymbols(document.text, 120) : [];

  return (
    <>
    <div data-testid="right-sidebar-resize-handle" role="separator" tabIndex={0} aria-label={t("platform.toggleRightSidebar")} aria-orientation="vertical" aria-valuenow={panelWidth.width} aria-valuemin={220} aria-valuemax={480} className="taomni-platform-resizer" onPointerDown={panelWidth.onPointerDown} onKeyDown={panelWidth.onKeyDown} onDoubleClick={panelWidth.reset} />
    <aside
      data-testid="right-sidebar"
      className="taomni-right-context-frame flex h-full shrink-0 flex-col"
      style={{ width: panelWidth.width, maxWidth: "40vw" }}
    >
      <div className="flex h-[33px] shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: "var(--taomni-divider)" }}>
        <button
          type="button"
          data-testid="right-sidebar-structure-tab"
          aria-pressed={tab === "structure"}
          className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold"
          style={{
            background: tab === "structure" ? "var(--taomni-selected)" : "transparent",
            color: tab === "structure" ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
          }}
          onClick={() => setTab("structure")}
        >
          {t("platform.rightStructure")}
        </button>
        <button
          type="button"
          data-testid="right-sidebar-ai-tab"
          aria-pressed={tab === "ai"}
          className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold"
          style={{
            background: tab === "ai" ? "var(--taomni-selected)" : "transparent",
            color: tab === "ai" ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
          }}
          onClick={() => setTab("ai")}
        >
          {t("platform.rightAi")}
        </button>
        <div className="flex-1" />
        <button type="button" data-testid="right-sidebar-close" aria-label={t("common.close")} className="rounded p-1 hover:bg-[var(--taomni-hover)]" onClick={toggleRightSidebar}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5" data-testid="right-sidebar-content" data-tab={tab}>
        {tab === "structure" ? (
          symbols.length === 0 ? (
            <div className="px-1 py-2 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.structureEmpty")}</div>
          ) : (
            symbols.map((symbol) => (
              <div key={`${symbol.line}-${symbol.label}`} data-testid="right-structure-symbol" data-kind={symbol.kind} className="flex h-[22px] items-center gap-1.5 rounded px-1.5 hover:bg-[var(--taomni-hover)]">
                <span className="w-10 shrink-0 text-[9px] uppercase" style={{ color: "var(--taomni-text-muted)" }}>{symbol.kind}</span>
                <span className="truncate text-[11.5px]">{symbol.label}</span>
              </div>
            ))
          )
        ) : (
          <div className="flex flex-col gap-2 p-1">
            <div className="inline-flex items-center gap-1 text-[11.5px] font-semibold">
              <Bot className="h-3.5 w-3.5" />
              {t("platform.rightAi")}
            </div>
            <div className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>{t("platform.rightSidebarEmpty")}</div>
            <button type="button" data-testid="right-sidebar-open-chat" className="taomni-btn h-7 px-2" onClick={() => setDrawerOpen(true)}>
              {t("platform.openChat")}
            </button>
          </div>
        )}
      </div>
    </aside>
    </>
  );
}
