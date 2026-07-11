import { useCallback, useEffect, useState } from "react";
import { Command as CommandIcon, File } from "lucide-react";
import { QuickPickOverlay } from "./QuickPickOverlay";
import { rankFuzzy } from "./fuzzyMatch";
import type { WorkspaceCommand } from "./workspaceCommands";

export interface GoToFileItem {
  rootId: string;
  rootName: string;
  path: string;
}

interface SearchEverywhereProps {
  open: boolean;
  items: GoToFileItem[];
  loading: boolean;
  truncated?: boolean;
  commands?: WorkspaceCommand[];
  onClose: () => void;
  onOpenFile: (item: GoToFileItem) => void;
  onRunCommand?: (commandId: string) => void;
}

const MAX_RESULTS = 50;
type SearchMode = "files" | "actions";
type SearchItem =
  | { kind: "file"; value: GoToFileItem }
  | { kind: "action"; value: WorkspaceCommand };

function itemKey(item: SearchItem): string {
  return item.kind === "file"
    ? `file:${item.value.rootId}:${item.value.path}`
    : `action:${item.value.id}`;
}

export function SearchEverywhere({
  open,
  items,
  loading,
  truncated = false,
  commands = [],
  onClose,
  onOpenFile,
  onRunCommand,
}: SearchEverywhereProps) {
  const [mode, setMode] = useState<SearchMode>("files");
  useEffect(() => {
    if (open) setMode("files");
  }, [open]);

  const searchItems: SearchItem[] = mode === "files"
    ? items.map((value) => ({ kind: "file", value }))
    : commands.map((value) => ({ kind: "action", value }));
  const filterItems = useCallback(
    (query: string, all: SearchItem[]) => rankFuzzy(
      query,
      all,
      (item) => item.kind === "file"
        ? `${item.value.rootName}/${item.value.path}`
        : `${item.value.category} ${item.value.title} ${item.value.keywords?.join(" ") ?? ""}`,
      MAX_RESULTS,
    ),
    [],
  );

  return (
    <QuickPickOverlay
      open={open}
      testId="code-workspace-search-everywhere"
      inputLabel={mode === "files" ? "Go to file" : "Search actions"}
      placeholder={mode === "files" ? "Go to file (supports camelCase abbreviations)" : "Search workspace actions"}
      items={searchItems}
      loading={mode === "files" && loading}
      filterItems={filterItems}
      itemKey={itemKey}
      renderItem={(item) => {
        if (item.kind === "action") {
          return (
            <>
              <CommandIcon className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--taomni-code-text)]">{item.value.title}</span>
              <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">{item.value.category}</span>
              {item.value.keybinding && (
                <kbd className="shrink-0 rounded border border-[var(--taomni-code-border)] px-1 text-[10px] text-[var(--taomni-code-muted)]">
                  {item.value.keybinding}
                </kbd>
              )}
            </>
          );
        }
        const name = item.value.path.split("/").pop() ?? item.value.path;
        const dir = item.value.path.slice(0, item.value.path.length - name.length).replace(/\/$/, "");
        return (
          <>
            <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
            <span className="shrink-0 text-[var(--taomni-code-text)]">{name}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
              {item.value.rootName}{dir ? `/${dir}` : ""}
            </span>
          </>
        );
      }}
      emptyText={() =>
        mode === "actions"
          ? commands.length === 0 ? "No available workspace actions" : "No matching actions"
          : loading
            ? "Indexing workspace files..."
            : items.length === 0
              ? "No files in workspace roots"
              : "No matching files"
      }
      header={
        <div className="flex h-8 shrink-0 items-end gap-1 border-b border-[var(--taomni-code-border)] px-2">
          {(["files", "actions"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mode === tab}
              data-active={mode === tab || undefined}
              className="h-7 rounded-t px-3 text-[11px] capitalize text-[var(--taomni-code-muted)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
              onClick={() => setMode(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
      }
      footer={
        <>
          <span>↑↓ select</span>
          <span>Enter {mode === "files" ? "open" : "run"}</span>
          <span>Esc close</span>
          <span className="ml-auto">
            {mode === "files" ? (
              <>{truncated ? "file index truncated · " : ""}{items.length} file{items.length === 1 ? "" : "s"}</>
            ) : (
              <>{commands.length} action{commands.length === 1 ? "" : "s"}</>
            )}
          </span>
        </>
      }
      onClose={onClose}
      onPick={(item) => {
        if (item.kind === "file") onOpenFile(item.value);
        else onRunCommand?.(item.value.id);
      }}
    />
  );
}
