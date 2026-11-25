import { Trash2 } from "lucide-react";
import type { NotepadSearchResultHit } from "../../../stores/notepadStore";
import { useViewerLabels } from "../../viewer/viewerLabels";

export function SearchResultsPanel({
  title,
  hits,
  onJumpHit,
  onClear,
}: {
  title: string;
  hits: NotepadSearchResultHit[];
  onJumpHit: (hit: NotepadSearchResultHit) => void;
  onClear: () => void;
}) {
  const label = useViewerLabels();

  const grouped = new Map<string, NotepadSearchResultHit[]>();
  for (const hit of hits) {
    const groupKey = hit.filePath ?? hit.docId ?? hit.name;
    const list = grouped.get(groupKey) ?? [];
    list.push(hit);
    grouped.set(groupKey, list);
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 text-ui-body" data-testid="notepad-search-results">
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--taomni-divider)] text-ui-small">
        <span className="font-medium truncate">
          {title || label("搜索结果", "Search Results")} — {hits.length} {label("条匹配", "hit(s)")}
        </span>
        <button
          type="button"
          className="np-btn h-6 px-2 inline-flex items-center gap-1"
          data-testid="notepad-results-clear"
          onClick={onClear}
        >
          <Trash2 size={11} />
          {label("清空", "Clear")}
        </button>
      </div>
      <div className="flex-1 overflow-auto font-mono text-ui-small">
        {hits.length === 0 ? (
          <div className="p-3 text-[var(--taomni-text-muted)] font-sans">
            {label("暂无搜索结果。使用“查找所有”或“在文件中查找”。", "No results yet. Use Find All or Find in Files.")}
          </div>
        ) : (
          Array.from(grouped.entries()).map(([groupKey, items]) => (
            <div key={groupKey} className="border-b border-[var(--taomni-divider)]">
              <div className="px-2 py-1 bg-[var(--taomni-panel-bg)] font-sans font-semibold text-ui-small truncate">
                {items[0]?.name} ({items.length}) <span className="font-normal opacity-65">{groupKey}</span>
              </div>
              {items.map((hit, idx) => (
                <button
                  key={`${hit.from}-${idx}`}
                  type="button"
                  data-testid={`notepad-result-hit-${idx}`}
                  className="w-full text-left flex items-baseline gap-2 px-3 py-0.5 hover:bg-[var(--taomni-hover)]"
                  onClick={() => onJumpHit(hit)}
                >
                  <span className="text-[var(--taomni-accent)] shrink-0">Ln {hit.line + 1}:</span>
                  <span className="truncate">{hit.lineText}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
