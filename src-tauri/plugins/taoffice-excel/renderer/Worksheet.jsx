import { cellKey, columnName, COLUMNS, ROWS, moveInSheet, tsv } from "./workbook.js";
import { excelEditKey } from "./workbookEdits.js";
import { CellEdit } from "./CellEdit.jsx";

const { React } = globalThis.__taomniHost;
const { useLayoutEffect, useMemo, useRef, useState } = React;

export function Worksheet({ range, cursor, move, active, pending, label, platform, editor }) {
  const { window, start } = range;
  const current = useRef(null);
  const grid = useRef(null);
  const restoreFocus = useRef(false);
  const [anchor, setAnchor] = useState(null);
  const [clipboardError, setClipboardError] = useState(false);
  const [draft, setDraft] = useState(null);
  const editing = draft !== null;
  const cells = useMemo(() => new Map(window.cells.map((cell) => {
    const address = columnName(cell.column) + (cell.row + 1);
    const edit = editor.edits.get(excelEditKey(range.sheet, address));
    return [cellKey(cell.row, cell.column), edit ? { ...cell, original: cell.value, value: edit.value } : cell];
  })), [window, range.sheet, editor.edits]);
  const selected = cells.get(cellKey(cursor.row, cursor.column));
  const address = columnName(cursor.column) + (cursor.row + 1);
  const editable = editor.permitted && !editor.saving && !pending && !!selected?.editType;
  const rowCount = Math.min(ROWS, window.rows - start.row);
  const columnCount = Math.min(COLUMNS, window.columns - start.column);

  useLayoutEffect(() => {
    if (active && current.current && restoreFocus.current) {
      current.current.focus();
      restoreFocus.current = false;
    }
  }, [cursor, range, active, editing]);

  function select(next, extend = false) {
    const inWindow = next.row >= start.row && next.row < start.row + rowCount
      && next.column >= start.column && next.column < start.column + columnCount;
    setAnchor(extend && inWindow ? (anchor ?? cursor) : null);
    restoreFocus.current = true;
    if (!inWindow) grid.current?.focus();
    move(next);
  }

  function onGridKey(event) {
    if (editing || !active || pending || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey) return;
    const mod = platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (editable && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "F2") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(selected.value);
      return;
    }
    if (mod && event.key.toLowerCase() === "c") {
      event.preventDefault();
      event.stopPropagation();
      setClipboardError(false);
      void navigator.clipboard.writeText(tsv(cells, anchor ?? cursor, cursor)).catch(() => setClipboardError(true));
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) return;
    const next = moveInSheet(event, cursor, window);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    select(next, event.shiftKey && event.key !== "Enter");
  }

  const inRange = (row, column) => row >= Math.min(cursor.row, anchor?.row ?? cursor.row)
    && row <= Math.max(cursor.row, anchor?.row ?? cursor.row)
    && column >= Math.min(cursor.column, anchor?.column ?? cursor.column)
    && column <= Math.max(cursor.column, anchor?.column ?? cursor.column);

  function endEdit(event = null, focusCell = true) {
    restoreFocus.current = focusCell;
    setDraft(null);
    if (event) select(moveInSheet(event, cursor, window));
  }

  return <>
    <div className="taoffice-excel-formula">
      <span className="taomni-mono" data-testid="taoffice-excel-cell-address">{address}</span>
      <input className="taomni-input" readOnly aria-label={label("单元格内容或公式", "Cell value or formula")}
        data-testid="taoffice-excel-formula" value={draft ?? (selected?.formula ? `=${selected.formula}` : (selected?.value ?? ""))} />
      {editor.permitted && !editing && <button type="button" className="taomni-btn" disabled={!editable}
        title={label("编辑单元格 (F2)", "Edit cell (F2)")} data-testid="taoffice-excel-edit-cell" onClick={() => setDraft(selected.value)}>{label("编辑单元格", "Edit cell")}</button>}
    </div>
    {selected?.truncated && <p className="taoffice-excel-feedback" role="status">
      {label("单元格内容过长，查看器显示前 960 个字符。", "This cell preview shows the first 960 characters.")}
    </p>}
    {editor.permitted && selected?.tableMetadata && <p className="taoffice-excel-feedback" role="status" data-testid="taoffice-excel-table-readonly">
      {label("表格标题和汇总行是只读的。", "Table headers and totals rows are read-only.")}
    </p>}
    {clipboardError && <p role="alert">{label("无法复制，请再次按复制快捷键。", "Clipboard access failed. Try the copy shortcut again.")}</p>}
    <div className="taoffice-excel-grid">
      <table role="grid" aria-label={label("工作表单元格", "Worksheet cells")} aria-busy={pending}
        aria-rowcount={window.rows + 1} aria-colcount={window.columns + 1} aria-readonly={!editor.permitted} aria-multiselectable="true"
        tabIndex={-1} onKeyDown={onGridKey} onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) restoreFocus.current = false;
        }} ref={grid} data-testid="taoffice-excel-grid">
        <thead><tr aria-rowindex={1}><th aria-colindex={1} aria-label={label("行号", "Row number")} />
          {Array.from({ length: columnCount }, (_, offset) => <th key={offset} scope="col"
            aria-colindex={start.column + offset + 2}>{columnName(start.column + offset)}</th>)}</tr></thead>
        <tbody>{Array.from({ length: rowCount }, (_, rowOffset) => {
          const row = start.row + rowOffset;
          return <tr key={row} aria-rowindex={row + 2}><th scope="row" aria-colindex={1}>{row + 1}</th>
            {Array.from({ length: columnCount }, (_, columnOffset) => {
              const column = start.column + columnOffset;
              const key = cellKey(row, column);
              const focused = row === cursor.row && column === cursor.column;
              return <td key={key} role="gridcell" aria-colindex={column + 2}
                aria-readonly={!editor.permitted || !cells.get(key)?.editType}
                aria-selected={inRange(row, column)} tabIndex={focused ? 0 : -1} ref={focused ? current : null}
                data-testid="taoffice-excel-cell" data-address={`${columnName(column)}${row + 1}`}
                title={cells.get(key)?.value}
                onClick={(event) => {
                  if (editing) {
                    if (!focused) current.current?.querySelector("input")?.focus();
                    return;
                  }
                  select({ row, column }, event.shiftKey);
                }}
                onDoubleClick={() => {
                  if (focused && editable) setDraft(selected.value);
                }}>
                {focused && editing && editable ? <CellEdit key={address} type={selected.editType} address={address}
                  value={draft} onChange={setDraft} label={label} platform={platform} onCancel={endEdit}
                  onSave={() => { void editor.save().catch(() => {}); }}
                  onCommit={(value, event, focusCell) => {
                    if (!editor.apply(range.sheet, address, selected.original ?? selected.value, value)) return false;
                    endEdit(event, focusCell);
                    return true;
                  }} /> : cells.get(key)?.value}
              </td>;
            })}
          </tr>;
        })}</tbody>
      </table>
    </div>
    <footer className="taoffice-excel-pages" aria-label={label("工作表页面", "Worksheet pages")}>
      <button className="taomni-btn" type="button" disabled={pending || start.row === 0}
        onClick={() => move({ row: Math.max(0, start.row - ROWS), column: cursor.column })}>{label("上一组行", "Previous rows")}</button>
      <button className="taomni-btn" type="button" disabled={pending || start.row + ROWS >= window.rows}
        onClick={() => move({ row: start.row + ROWS, column: cursor.column })}>{label("下一组行", "Next rows")}</button>
      <button className="taomni-btn" type="button" disabled={pending || start.column === 0}
        onClick={() => move({ row: cursor.row, column: Math.max(0, start.column - COLUMNS) })}>{label("上一组列", "Previous columns")}</button>
      <button className="taomni-btn" type="button" disabled={pending || start.column + COLUMNS >= window.columns}
        onClick={() => move({ row: cursor.row, column: start.column + COLUMNS })}>{label("下一组列", "Next columns")}</button>
    </footer>
  </>;
}
