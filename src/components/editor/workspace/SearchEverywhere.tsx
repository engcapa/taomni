import { useCallback } from "react";
import { File } from "lucide-react";
import { QuickPickOverlay } from "./QuickPickOverlay";
import { rankFuzzy } from "./fuzzyMatch";

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
  onClose: () => void;
  onOpenFile: (item: GoToFileItem) => void;
}

const MAX_RESULTS = 50;

function itemKey(item: GoToFileItem): string {
  return `${item.rootId}:${item.path}`;
}

export function SearchEverywhere({
  open,
  items,
  loading,
  truncated = false,
  onClose,
  onOpenFile,
}: SearchEverywhereProps) {
  const filterItems = useCallback(
    (query: string, all: GoToFileItem[]) =>
      rankFuzzy(query, all, (item) => `${item.rootName}/${item.path}`, MAX_RESULTS),
    [],
  );

  return (
    <QuickPickOverlay
      open={open}
      testId="code-workspace-search-everywhere"
      inputLabel="Go to file"
      placeholder="Go to file (supports camelCase abbreviations)"
      items={items}
      loading={loading}
      filterItems={filterItems}
      itemKey={itemKey}
      renderItem={(item) => {
        const name = item.path.split("/").pop() ?? item.path;
        const dir = item.path.slice(0, item.path.length - name.length).replace(/\/$/, "");
        return (
          <>
            <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
            <span className="shrink-0 text-[var(--taomni-code-text)]">{name}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
              {item.rootName}{dir ? `/${dir}` : ""}
            </span>
          </>
        );
      }}
      emptyText={() =>
        loading
          ? "Indexing workspace files..."
          : items.length === 0
            ? "No files in workspace roots"
            : "No matching files"
      }
      footer={
        <>
          <span>↑↓ select</span>
          <span>Enter open</span>
          <span>Esc close</span>
          <span className="ml-auto">
            {truncated ? "file index truncated · " : ""}
            {items.length} file{items.length === 1 ? "" : "s"}
          </span>
        </>
      }
      onClose={onClose}
      onPick={onOpenFile}
    />
  );
}
