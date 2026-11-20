import type { FilePanelViewProps } from "../filebrowser/filePanel/FilePanelView";
import { EXPLORER_COLUMNS, DEFAULT_EXPLORER_WIDTHS, MIN_EXPLORER_WIDTHS, MAX_EXPLORER_COLUMN_WIDTH, explorerColumnTitle, type ExplorerLabel } from "./explorerColumns";
import type { useExplorerColumns } from "./useExplorerColumns";

interface Props {
  details: boolean;
  inputs: Pick<FilePanelViewProps, "sortKey" | "sortDir" | "onHeaderClick">;
  columns: ReturnType<typeof useExplorerColumns>;
  label: ExplorerLabel;
}

export function ExplorerFileColumns({ details, inputs, columns, label }: Props) {
  return <div className="ex-fhead" role="row" style={{ minWidth: details ? columns.minWidth : undefined }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    {(details ? EXPLORER_COLUMNS : ["name"] as const).map(key => {
      const title = explorerColumnTitle(key, label), active = inputs.sortKey === key;
      return <div className="ex-column" data-column={key} key={key} role="columnheader" aria-sort={active ? inputs.sortDir === "asc" ? "ascending" : "descending" : "none"}>
        <button type="button" data-testid={`explorer-column-${key}`} className={active ? "on" : ""} onClick={() => inputs.onHeaderClick(key)} title={title}>
          <span>{title}</span>{active && <span aria-hidden="true">{inputs.sortDir === "asc" ? "▲" : "▼"}</span>}
        </button>
        {details && <div className="ex-col-resize" data-testid={`explorer-column-resize-${key}`} role="separator" aria-orientation="vertical" tabIndex={0}
          aria-label={label(`调整“${title}”列宽`, `Resize ${title} column`)} aria-valuemin={MIN_EXPLORER_WIDTHS[key]}
          aria-valuemax={MAX_EXPLORER_COLUMN_WIDTH} aria-valuenow={Math.round(columns.effective[key] ?? columns.measuredWidth(key) ?? DEFAULT_EXPLORER_WIDTHS[key])}
          title={label("拖动调整列宽；双击适应内容", "Drag to resize; double-click to fit contents")}
          onPointerDown={event => columns.startResize(key, event)} onKeyDown={event => columns.resizeKey(key, event)}
          onClick={event => event.stopPropagation()} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); columns.fit(key); }} />}
      </div>;
    })}
  </div>;
}
