export const ROWS = 32;
export const COLUMNS = 12;
const MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 768 * 1024;

export function legacyWorkbookFormat(extension) {
  const format = extension?.toLowerCase();
  return format === "xls" || format === "xlsb" || format === "ods" ? format : undefined;
}

export async function openWorkbook(api, source, id, signal) {
  const workbook = await source.read();
  signal.throwIfAborted();
  if (workbook.size > MAX_BYTES) throw new Error("Workbook preview is limited to 16 MiB.");
  const options = { signal };
  const format = legacyWorkbookFormat(source.extension);
  await api.invoke("workbook/begin", { id, size: workbook.size, ...(format ? { format } : {}) }, options);
  for (let offset = 0; offset < workbook.size; offset += CHUNK_BYTES) {
    const bytes = new Uint8Array(await workbook.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    signal.throwIfAborted();
    const chunks = [];
    for (let index = 0; index < bytes.length; index += 8192) {
      chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
    }
    await api.invoke("workbook/append", { id, offset, data: btoa(chunks.join("")) }, options);
  }
  return api.invoke("workbook/open", { id }, options);
}

export function columnName(column) {
  let name = "";
  for (let index = column + 1; index > 0; index = Math.floor((index - 1) / 26)) {
    name = String.fromCharCode(65 + (index - 1) % 26) + name;
  }
  return name;
}

export function cellKey(row, column) {
  return `${row}/${column}`;
}

export function moveInSheet(event, current, dimensions) {
  const { row, column } = current;
  const { rows, columns } = dimensions;
  let nextRow = row;
  let nextColumn = column;
  switch (event.key) {
    case "ArrowUp": nextRow--; break;
    case "ArrowDown": nextRow++; break;
    case "ArrowLeft": nextColumn--; break;
    case "ArrowRight": nextColumn++; break;
    case "PageUp": nextRow -= ROWS; break;
    case "PageDown": nextRow += ROWS; break;
    case "Home": nextColumn = 0; if (event.ctrlKey || event.metaKey) nextRow = 0; break;
    case "End": nextColumn = columns - 1; if (event.ctrlKey || event.metaKey) nextRow = rows - 1; break;
    default: return null;
  }
  return {
    row: Math.max(0, Math.min(rows - 1, nextRow)),
    column: Math.max(0, Math.min(columns - 1, nextColumn)),
  };
}

export function tsv(cells, start, end) {
  const firstRow = Math.min(start.row, end.row);
  const finalRow = Math.max(start.row, end.row);
  const firstColumn = Math.min(start.column, end.column);
  const finalColumn = Math.max(start.column, end.column);
  const rows = [];
  for (let row = firstRow; row <= finalRow; row++) {
    const values = [];
    for (let column = firstColumn; column <= finalColumn; column++) {
      const value = cells.get(cellKey(row, column))?.value ?? "";
      values.push(/[\t\r\n"]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value);
    }
    rows.push(values.join("\t"));
  }
  return rows.join("\n");
}
