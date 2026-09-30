import { useCallback } from "react";
import { Circle, File } from "lucide-react";
import { QuickPickOverlay } from "./QuickPickOverlay";
import { rankFuzzy } from "./fuzzyMatch";
import type { CodeWorkspaceFileRef } from "../../../types";

export interface RecentFileEntry {
  key: string;
  ref: CodeWorkspaceFileRef;
  title: string;
  subtitle: string;
  open: boolean;
}

export interface RecentToolWindowEntry {
  id: string;
  label: string;
  shortcut?: string;
}

interface RecentFilesPopupProps {
  open: boolean;
  entries: RecentFileEntry[];
  /** Bump while open to advance the selection (repeated Ctrl+E). */
  advanceNonce?: number;
  changedOnly?: boolean;
  onClose: () => void;
  onPick: (entry: RecentFileEntry) => void;
  /** ED-PARITY-014 DEC-014-03: IDEA "Show edited only" (also Ctrl+E while open). */
  onToggleChangedOnly?: () => void;
  /** ED-PARITY-014 DEC-014-03: left column of tool windows (IDEA switcher). */
  toolWindows?: readonly RecentToolWindowEntry[];
  onActivateToolWindow?: (id: string) => void;
  onOpenRecentLocations?: () => void;
}

const MAX_RESULTS = 50;

export function RecentFilesPopup({
  open,
  entries,
  advanceNonce,
  changedOnly = false,
  onClose,
  onPick,
  onToggleChangedOnly,
  toolWindows = [],
  onActivateToolWindow,
  onOpenRecentLocations,
}: RecentFilesPopupProps) {
  const aside = toolWindows.length > 0 || onOpenRecentLocations ? (
    <div data-testid="code-workspace-recent-files-tool-windows" role="list" aria-label="Tool windows">
      {toolWindows.map((toolWindow) => (
        <button
          key={toolWindow.id}
          type="button"
          role="listitem"
          data-testid={`code-workspace-recent-files-tool-window-${toolWindow.id}`}
          className="h-6 w-full min-w-0 flex items-center gap-2 px-3 text-left text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={() => onActivateToolWindow?.(toolWindow.id)}
        >
          <span className="min-w-0 flex-1 truncate">{toolWindow.label}</span>
          {toolWindow.shortcut && <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">{toolWindow.shortcut}</span>}
        </button>
      ))}
      {onOpenRecentLocations && (
        <button
          type="button"
          role="listitem"
          data-testid="code-workspace-recent-files-recent-locations"
          className="mt-1 h-6 w-full min-w-0 flex items-center gap-2 border-t border-[var(--taomni-code-border)] px-3 text-left text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)]"
          onClick={onOpenRecentLocations}
        >
          <span className="min-w-0 flex-1 truncate">Recent Locations</span>
          <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">Ctrl+Shift+E</span>
        </button>
      )}
    </div>
  ) : null;
  const filterItems = useCallback(
    (query: string, all: RecentFileEntry[]) =>
      query.trim()
        ? rankFuzzy(query, all, (entry) => entry.subtitle, MAX_RESULTS)
        // No query: keep most-recent-first order instead of fuzzy ranking.
        : all.slice(0, MAX_RESULTS),
    [],
  );

  return (
    <QuickPickOverlay
      open={open}
      testId="code-workspace-recent-files"
      inputLabel={changedOnly ? "Recently changed files" : "Recent files"}
      placeholder={changedOnly ? "Recently changed files (type to filter)" : "Recent files (type to filter)"}
      items={entries}
      // Preselect the previous file so Ctrl+E, Enter flips back to it.
      initialIndex={entries.length > 1 ? 1 : 0}
      advanceNonce={advanceNonce}
      filterItems={filterItems}
      itemKey={(entry) => entry.key}
      renderItem={(entry) => (
        <>
          <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
          <span className="shrink-0 text-[var(--taomni-code-text)]">{entry.title}</span>
          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
            {entry.subtitle}
          </span>
          {entry.open && (
            <Circle
              aria-label="Open in editor"
              className="h-2 w-2 shrink-0 fill-[var(--taomni-accent)] text-[var(--taomni-accent)]"
            />
          )}
        </>
      )}
      emptyText={(query) =>
        query
          ? "No matching recent files"
          : changedOnly
            ? "No recently changed files"
            : "No recent files yet"
      }
      header={onToggleChangedOnly ? (
        <div className="flex h-7 shrink-0 items-center justify-between border-b border-[var(--taomni-code-border)] px-3 text-[11px]">
          <span className="font-medium text-[var(--taomni-code-text)]">{changedOnly ? "Recently Edited Files" : "Recent Files"}</span>
          <label className="inline-flex items-center gap-1 text-[var(--taomni-code-muted)]">
            <input
              type="checkbox"
              data-testid="code-workspace-recent-files-edited-only"
              data-checked={String(changedOnly)}
              checked={changedOnly}
              onChange={onToggleChangedOnly}
              onMouseDown={(event) => event.preventDefault()}
            />
            Show edited only
            <span className="text-[10px]">Ctrl+E</span>
          </label>
        </div>
      ) : undefined}
      aside={aside}
      footer={(selected) => (
        <>
          {/* IDEA: the full path of the selected file. */}
          <span data-testid="code-workspace-recent-files-path" className="min-w-0 flex-1 truncate" title={selected?.subtitle}>
            {selected?.subtitle ?? ""}
          </span>
          <span className="shrink-0">
            {entries.length} {changedOnly ? "changed" : "recent"} file{entries.length === 1 ? "" : "s"}
          </span>
        </>
      )}
      onClose={onClose}
      onPick={onPick}
    />
  );
}
