import { useEffect, useRef } from "react";
import { File, PanelBottom } from "lucide-react";

export interface TabSwitcherEntry {
  key: string;
  title: string;
  subtitle: string;
  dirty: boolean;
  active: boolean;
  /** Owning leaf identity — commit activates THIS leaf, not the active one (§8.18.5). */
  leafId: string | null;
  pinned?: boolean;
  preview?: boolean;
}

/** Open tool window entry sharing the switcher index space (§8.17.5 step 4). */
export interface TabSwitcherToolWindow {
  id: string;
  label: string;
  /** Whether the dock currently shows this tool window. */
  open?: boolean;
}

interface TabSwitcherProps {
  open: boolean;
  entries: TabSwitcherEntry[];
  /** Rendered below editor entries; indices continue after `entries`. */
  toolWindows?: TabSwitcherToolWindow[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onCommit: (index: number) => void;
  onCancel: () => void;
}

/**
 * IDEA-style Ctrl+Tab Switcher surface (§8.16.5 N2.6, §8.18.5 P0-C4).
 * Key handling (hold-to-cycle, release-to-commit, arrows between/within the
 * columns, Esc cancel, Backspace close) lives in the workspace tab; this
 * component only renders the columns and forwards pointer interactions. Preview (hover) never mutates the MRU order.
 * Renders with tool windows alone when no editor entries exist.
 */
export function TabSwitcher({
  open,
  entries,
  toolWindows = [],
  selectedIndex,
  onHover,
  onCommit,
  onCancel,
}: TabSwitcherProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-switcher-selected="true"]')
      ?.scrollIntoView?.({
        block: "nearest",
      });
  }, [open, selectedIndex]);

  if (!open || (entries.length === 0 && toolWindows.length === 0)) return null;

  const selectedEntry = selectedIndex < entries.length ? entries[selectedIndex] ?? null : null;
  const selectedTool = selectedIndex >= entries.length ? toolWindows[selectedIndex - entries.length] ?? null : null;

  // IDEA Switcher layout: tool windows on the left, files on the right, the
  // selected file path underneath. Left/Right move between the columns.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Switcher"
      data-testid="workspace-tab-switcher"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="flex w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] shadow-2xl text-[var(--taomni-code-text)]">
        <div ref={listRef} className="flex max-h-[50vh] min-h-0">
          {toolWindows.length > 0 && (
            <div
              role="listbox"
              aria-label="Tool windows"
              data-testid="workspace-tab-switcher-tool-windows"
              className="w-[200px] shrink-0 overflow-y-auto border-r border-[var(--taomni-code-border)] py-1"
            >
              {toolWindows.map((toolWindow, toolIndex) => {
                const index = entries.length + toolIndex;
                const selected = index === selectedIndex;
                return (
                  <div
                    key={`tool:${toolWindow.id}`}
                    role="option"
                    aria-selected={selected}
                    data-switcher-index={index}
                    data-switcher-selected={selected ? "true" : undefined}
                    data-testid={`workspace-tab-switcher-tool-${toolWindow.id}`}
                    className={`flex items-center gap-2 px-3 py-1 ${
                      selected
                        ? "bg-[var(--taomni-accent)] text-white"
                        : "text-[var(--taomni-code-text)]"
                    }`}
                    onMouseEnter={() => onHover(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onCommit(index);
                    }}
                  >
                    <PanelBottom className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{toolWindow.label}</span>
                    {toolWindow.open && (
                      <span className="shrink-0 text-[9px] opacity-70">open</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div
            role="listbox"
            aria-label="Recent files"
            data-testid="workspace-tab-switcher-files"
            className="min-w-0 flex-1 overflow-y-auto py-1"
          >
            {entries.map((entry, index) => {
              const selected = index === selectedIndex;
              return (
                <div
                  key={entry.key}
                  role="option"
                  aria-selected={selected}
                  data-switcher-index={index}
                  data-switcher-selected={selected ? "true" : undefined}
                  data-testid={`workspace-tab-switcher-item-${entry.key}`}
                  className={`flex items-center gap-2 px-3 py-1 ${
                    selected
                      ? "bg-[var(--taomni-accent)] text-white"
                      : "text-[var(--taomni-code-text)]"
                  }`}
                  onMouseEnter={() => onHover(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onCommit(index);
                  }}
                >
                  <File className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {entry.pinned && <span className="mr-1" title="Pinned">📌</span>}
                    {entry.title}
                    {entry.dirty && <span className="ml-1">*</span>}
                  </span>
                </div>
              );
            })}
            {entries.length === 0 && (
              <div className="px-3 py-1 text-[var(--taomni-code-muted)]">No open files</div>
            )}
          </div>
        </div>
        <div
          data-testid="workspace-tab-switcher-path"
          className="min-w-0 truncate border-t border-[var(--taomni-code-border)] px-3 py-1 text-[10px] text-[var(--taomni-code-muted)]"
          title={selectedEntry?.subtitle ?? selectedTool?.label ?? ""}
        >
          {selectedEntry?.subtitle ?? (selectedTool ? `${selectedTool.label} tool window` : "")}
        </div>
      </div>
    </div>
  );
}

/**
 * IDEA Switcher arrow keys over the shared index space (files first, then
 * tool windows): Up/Down stay in the current column, Left moves from the files
 * to the tool-window column, Right back, keeping the row where possible.
 */
export function switcherArrowIndex(
  index: number,
  key: "arrowup" | "arrowdown" | "arrowleft" | "arrowright",
  fileCount: number,
  toolCount: number,
): number {
  const inTools = index >= fileCount;
  const row = inTools ? index - fileCount : index;
  if (key === "arrowleft") {
    if (inTools || toolCount === 0) return index;
    return fileCount + Math.min(row, toolCount - 1);
  }
  if (key === "arrowright") {
    if (!inTools || fileCount === 0) return index;
    return Math.min(row, fileCount - 1);
  }
  const size = inTools ? toolCount : fileCount;
  if (size === 0) return index;
  const nextRow = Math.max(0, Math.min(size - 1, row + (key === "arrowdown" ? 1 : -1)));
  return inTools ? fileCount + nextRow : nextRow;
}
