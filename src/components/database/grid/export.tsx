import type { DbColumn } from "../../../lib/ipc";
import { writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen } from "../../../lib/ipc";
import { type GridRow, type RowStatus, type TextFunction, type ExportOptions, type ExportColumnConfig, type SqlDelimiterMode, type Encoding } from "./types";


export function csvEscape(value: string | null): string {
  if (value === null) return "";
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}


export function sameValues(a: (string | null)[] | null, b: (string | null)[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}


export function statusAfterValueChange(row: GridRow, values: (string | null)[]): RowStatus {
  if (row.status === "inserted" || row.status === "deleted") return row.status;
  return sameValues(row.original, values) ? "clean" : "updated";
}


export function formatDatePart(value: number): string {
  return String(value).padStart(2, "0");
}


export function formatDateWithPattern(value: string, pattern: string, kind: "date" | "time" | "timestamp"): string {
  if (!pattern.trim()) return value;
  const source =
    kind === "time"
      ? `1970-01-01T${value}`
      : value.includes("T")
        ? value
        : value.includes(" ")
          ? value.replace(" ", "T")
          : value;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return value;
  return pattern
    .replace(/yyyy/g, String(date.getFullYear()))
    .replace(/MM/g, formatDatePart(date.getMonth() + 1))
    .replace(/dd/g, formatDatePart(date.getDate()))
    .replace(/HH/g, formatDatePart(date.getHours()))
    .replace(/mm/g, formatDatePart(date.getMinutes()))
    .replace(/ss/g, formatDatePart(date.getSeconds()));
}


export function formatNumberText(value: string, groupSeparator: string, decimalSeparator: string): string {
  if (!/^-?\d+([.,]\d+)?$/.test(value.trim())) return value;
  const sign = value.startsWith("-") ? "-" : "";
  const unsigned = sign ? value.slice(1) : value;
  const [integer, fraction] = unsigned.split(/[.,]/);
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  return `${sign}${grouped}${fraction !== undefined ? `${decimalSeparator}${fraction}` : ""}`;
}


export function applyTextFunction(value: string, fn: TextFunction): string {
  switch (fn) {
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "trim":
      return value.trim();
    default:
      return value;
  }
}


export function formatValue(value: string | null, column: DbColumn, options: ExportOptions): string {
  if (value === null) return options.nullValueText;
  const type = column.type.toLowerCase();
  if (/(blob|binary|bytea|varbinary)/.test(type)) {
    if (options.binaryMode === "dont") return "";
    if (options.binaryMode === "length") return `${value.length} bytes`;
  }
  if (/clob/.test(type) && options.clobMode === "dont") return "";
  if (/bool/.test(type)) {
    if (/^(true|t|1)$/i.test(value)) return options.booleanTrueText;
    if (/^(false|f|0)$/i.test(value)) return options.booleanFalseText;
  }
  if (/(timestamp|datetime)/.test(type)) {
    return applyTextFunction(formatDateWithPattern(value, options.timestampFormat, "timestamp"), options.textFunction);
  }
  if (/\bdate\b/.test(type)) {
    return applyTextFunction(formatDateWithPattern(value, options.dateFormat, "date"), options.textFunction);
  }
  if (/\btime\b/.test(type)) {
    return applyTextFunction(formatDateWithPattern(value, options.timeFormat, "time"), options.textFunction);
  }
  if (/(decimal|numeric)/.test(type) && options.decimalFormat === "grouped") {
    return formatNumberText(value, options.groupSeparator, options.decimalSeparator);
  }
  if (/(int|float|double|real|number)/.test(type) && options.numberFormat === "grouped") {
    return formatNumberText(value, options.groupSeparator, options.decimalSeparator);
  }
  return applyTextFunction(value, options.textFunction);
}


export function delimitedField(value: string, options: ExportOptions): string {
  const quoteChar = options.quoteTextValue === "double" ? '"' : options.quoteTextValue === "single" ? "'" : "";
  if (!quoteChar) return value;
  const needsQuote =
    options.quoteAllValues ||
    value.includes(options.columnDelimiter) ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes(quoteChar);
  if (!needsQuote) return value;
  const escaped = options.duplicateEmbedded
    ? value.split(quoteChar).join(`${quoteChar}${quoteChar}`)
    : value.split(quoteChar).join(`\\${quoteChar}`);
  return `${quoteChar}${escaped}${quoteChar}`;
}


export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


export function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, "&apos;");
}


export function uniqueColumnNames(columns: DbColumn[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((column) => {
    const base = column.name || "column";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}


export function columnOutputName(column: ExportColumnConfig, options: ExportOptions): string {
  return options.useLabels ? column.label || column.name : column.name;
}


export function cleanExportText(value: string, options: ExportOptions): string {
  return options.removeNewlines ? value.replace(/[\r\n]+/g, " ") : value;
}


export function renderTemplate(template: string, value: string): string {
  return template.replace(/\$\{value\}\$?/g, () => value);
}


export function quoteSqlIdentifier(name: string, mode: SqlDelimiterMode): string {
  switch (mode) {
    case "double":
      return `"${name.replace(/"/g, '""')}"`;
    case "backtick":
      return `\`${name.replace(/`/g, "``")}\``;
    case "bracket":
      return `[${name.replace(/]/g, "]]")}]`;
    default:
      return name;
  }
}


export function sqlExportTableName(options: ExportOptions): string {
  const table = quoteSqlIdentifier(options.sqlTableName || "result_export", options.sqlDelimiterMode);
  if (!options.sqlUseQualifier || !options.sqlQualifier.trim()) return table;
  return `${quoteSqlIdentifier(options.sqlQualifier.trim(), options.sqlDelimiterMode)}.${table}`;
}


export function originalSqlBlock(sourceSql: string | undefined, options: ExportOptions, commentPrefix = "--"): string[] {
  if (!sourceSql?.trim() || options.includeOriginalSql === "none") return [];
  const lines = sourceSql.trim().split(/\r?\n/).map((line) => `${commentPrefix} ${line}`);
  return options.includeOriginalSql === "top" ? lines : [`${commentPrefix} Original SQL:`, ...lines];
}


export function serializeResult(
  columns: DbColumn[],
  rows: GridRow[],
  exportColumns: ExportColumnConfig[],
  options: ExportOptions,
  sourceSql?: string,
): { text: string; extension: string; mime: string } {
  const limitedRows = options.maxRows > 0 ? rows.slice(0, options.maxRows) : rows;
  const enabledColumns = exportColumns.filter((column) => column.export);
  const columnByName = new Map(columns.map((column, index) => [column.name, { column, index }]));
  const rowValues = limitedRows.map((row) =>
    enabledColumns.map((exportColumn) => {
      let originalIndex = parseInt(exportColumn.id.split('-')[1], 10);
      if (Number.isNaN(originalIndex) || exportColumn.id.startsWith("export-col")) {
        const match = columnByName.get(exportColumn.name);
        originalIndex = match ? match.index : -1;
      }
      const sourceColumn = columns[originalIndex] ?? { name: exportColumn.name, type: exportColumn.type };
      const raw = originalIndex >= 0 && originalIndex < columns.length ? row.values[originalIndex] : null;
      const columnOptions = exportColumn.textFunction === "none" ? options : { ...options, textFunction: exportColumn.textFunction };
      const formatted = formatValue(raw, sourceColumn, columnOptions);
      return cleanExportText(renderTemplate(exportColumn.valueTemplate || "${value}$", formatted), options);
    }),
  );

  switch (options.outputFormat) {
    case "html": {
      const html = (value: string) => (options.htmlConvertCharacters ? escapeHtml(value) : value);
      const title = html(options.htmlTitle || "Query Results");
      const description = options.htmlDescription ? `<div>${html(options.htmlDescription)}</div>\n` : "";
      const footer = options.htmlFooter ? `\n<footer>${html(options.htmlFooter)}</footer>` : "";
      const headerTemplate = options.htmlPerTableHeader.replace("${dbvis-timestamp}", new Date().toISOString());
      const sqlBlock = originalSqlBlock(sourceSql, options, "<!--").map((line) => `${line} -->`).join("\n");
      const header = `<tr>${enabledColumns.map((column) => `<th>${html(columnOutputName(column, options))}</th>`).join("")}</tr>`;
      const body = rowValues
        .map((row) => `<tr>${row.map((value) => `<td>${html(value)}</td>`).join("")}</tr>`)
        .join("\n");
      const text = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>\n${sqlBlock}\n<h1>${title}</h1>\n${description}${headerTemplate}\n<table border="1">\n${header}\n${body}\n</table>${footer}\n</body></html>`;
      return {
        text,
        extension: "html",
        mime: "text/html",
      };
    }
    case "excel": {
      const title = escapeHtml(options.excelTitle || "Query Results");
      const description = options.excelDescription ? `<div>${escapeHtml(options.excelDescription)}</div>\n` : "";
      const sqlBlock = originalSqlBlock(sourceSql, options, "<!--").map((line) => `${line} -->`).join("\n");
      const numberAsText = options.excelExportNumberAsText || options.excelExportDateTimeAsText;
      const header = options.includeColumnNames
        ? `<tr>${enabledColumns.map((column) => `<th>${escapeHtml(columnOutputName(column, options))}</th>`).join("")}</tr>`
        : "";
      const body = rowValues
        .map((row) =>
          `<tr>${row
            .map((value) => `<td${numberAsText ? ' style="mso-number-format:\\@"' : ""}>${escapeHtml(value)}</td>`)
            .join("")}</tr>`,
        )
        .join("\n");
      const text = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>\n${sqlBlock}\n<h1>${title}</h1>\n${description}<table border="1">\n${header}\n${body}\n</table></body></html>`;
      return {
        text,
        extension: options.excelFileFormat,
        mime:
          options.excelFileFormat === "xlsx"
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/vnd.ms-excel",
      };
    }
    case "csv": {
      const lines: string[] = [];
      lines.push(...originalSqlBlock(sourceSql, options, options.rowCommentIdentifier || "#"));
      if (options.includeColumnNames) {
        lines.push(enabledColumns.map((column) => delimitedField(columnOutputName(column, options), options)).join(options.columnDelimiter));
      }
      for (const row of rowValues) {
        lines.push(row.map((value) => delimitedField(value, options)).join(options.columnDelimiter));
      }
      return {
        text: lines.join(options.rowDelimiter),
        extension: "csv",
        mime: "text/csv",
      };
    }
    case "txt": {
      const separator = " ".repeat(Math.max(1, options.txtSpacesBetweenColumns));
      const lines: string[] = [];
      lines.push(...originalSqlBlock(sourceSql, options, options.rowCommentIdentifier || "#"));
      if (options.includeColumnNames) {
        lines.push(enabledColumns.map((column) => columnOutputName(column, options)).join(separator));
      }
      for (const row of rowValues) {
        lines.push(row.join(separator));
      }
      return {
        text: lines.join(options.rowDelimiter),
        extension: "txt",
        mime: "text/plain",
      };
    }
    case "json": {
      const names = uniqueColumnNames(enabledColumns.map((column) => ({ name: columnOutputName(column, options), type: column.type })));
      const rowsPayload = rowValues.map((row) =>
        Object.fromEntries(row.map((value, index) => [names[index], value])),
      );
      const payload = options.jsonStyle === "object" ? { rows: rowsPayload } : rowsPayload;
      return { text: JSON.stringify(payload, null, 2), extension: "json", mime: "application/json" };
    }
    case "xml": {
      const description = options.xmlDescription ? `  <description>${escapeXml(options.xmlDescription)}</description>\n` : "";
      const sql = sourceSql?.trim() && options.includeOriginalSql !== "none" ? `  <sql>${escapeXml(sourceSql.trim())}</sql>\n` : "";
      const body = rowValues
        .map((row) => {
          const cells = row
            .map((value, index) => {
              const name = escapeXml(columnOutputName(enabledColumns[index], options));
              return options.xmlStyle === "flat"
                ? `    <${name}>${escapeXml(value)}</${name}>`
                : `    <column name="${name}">${escapeXml(value)}</column>`;
            })
            .join("\n");
          return `  <row>\n${cells}\n  </row>`;
        })
        .join("\n");
      return { text: `<result style="${options.xmlStyle}">\n${description}${sql}${body}\n</result>`, extension: "xml", mime: "application/xml" };
    }
    case "sql": {
      const tableName = sqlExportTableName(options);
      const quotedColumns = enabledColumns.map((column) => quoteSqlIdentifier(columnOutputName(column, options), options.sqlDelimiterMode)).join(", ");
      const lines: string[] = [];
      lines.push(...originalSqlBlock(sourceSql, options, options.rowCommentIdentifier || "--"));
      if (options.sqlIncludeBasicDdl) {
        const ddlColumns = enabledColumns
          .map((column) => `  ${quoteSqlIdentifier(columnOutputName(column, options), options.sqlDelimiterMode)} ${column.type || "TEXT"}`)
          .join(",\n");
        lines.push(`CREATE TABLE ${tableName} (\n${ddlColumns}\n)${options.sqlStatementSeparator}`);
      }
      if (options.sqlGenerateMerge) {
        const matchColumns = options.sqlMergeMatchColumns
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        for (const row of rowValues) {
          const values = row.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
          const match = matchColumns.length > 0 ? matchColumns.join(", ") : enabledColumns[0]?.name ?? "id";
          lines.push(`${options.sqlAddBefore}MERGE INTO ${tableName} USING (VALUES (${values})) AS src (${quotedColumns}) ON (${match}) WHEN MATCHED THEN UPDATE SET ${quotedColumns} = ${quotedColumns} WHEN NOT MATCHED THEN INSERT (${quotedColumns}) VALUES (${quotedColumns})${options.sqlStatementSeparator}${options.sqlAddAfter}`);
        }
      } else if (options.sqlGenerateMultiRow) {
        for (let index = 0; index < rowValues.length; index += Math.max(1, options.sqlRowsPerMultiRow)) {
          const chunk = rowValues.slice(index, index + Math.max(1, options.sqlRowsPerMultiRow));
          const tuples = chunk
            .map((row) => `(${row.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ")})`)
            .join(",\n");
          lines.push(`${options.sqlAddBefore}INSERT INTO ${tableName} (${quotedColumns}) VALUES\n${tuples}${options.sqlStatementSeparator}${options.sqlAddAfter}`);
        }
      } else {
        for (const row of rowValues) {
          const values = row.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
          lines.push(`${options.sqlAddBefore}INSERT INTO ${tableName} (${quotedColumns}) VALUES (${values})${options.sqlStatementSeparator}${options.sqlAddAfter}`);
        }
      }
      return { text: lines.filter(Boolean).join("\n"), extension: "sql", mime: "application/sql" };
    }
  }
}


export function encodeOutput(text: string, encoding: Encoding): Uint8Array {
  if (encoding === "utf-8-bom") {
    const bytes = new TextEncoder().encode(text);
    const output = new Uint8Array(bytes.length + 3);
    output.set([0xef, 0xbb, 0xbf], 0);
    output.set(bytes, 3);
    return output;
  }
  if (encoding === "utf-16le") {
    const output = new Uint8Array(text.length * 2 + 2);
    output[0] = 0xff;
    output[1] = 0xfe;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      output[index * 2 + 2] = code & 0xff;
      output[index * 2 + 3] = code >> 8;
    }
    return output;
  }
  return new TextEncoder().encode(text);
}


export async function writeBytesToPath(path: string, bytes: Uint8Array): Promise<void> {
  let handleId: string | null = null;
  try {
    handleId = await writeStreamOpen(path);
    await writeStreamAppend(handleId, bytes);
    await writeStreamClose(handleId);
  } catch (err) {
    if (handleId) await writeStreamAbort(handleId).catch(() => undefined);
    throw err;
  }
}


export function browserDownload(bytes: Uint8Array, filename: string, mime: string): void {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


export function browserOpen(bytes: Uint8Array, mime: string): void {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    browserDownload(bytes, "query-results.html", mime);
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}


export function nowDateText(): string {
  const d = new Date();
  return `${d.getFullYear()}-${formatDatePart(d.getMonth() + 1)}-${formatDatePart(d.getDate())}`;
}


export function nowTimeText(): string {
  const d = new Date();
  return `${formatDatePart(d.getHours())}:${formatDatePart(d.getMinutes())}:${formatDatePart(d.getSeconds())}`;
}


export function nowTimestampText(): string {
  return `${nowDateText()} ${nowTimeText()}`;
}


export function extensionForOptions(options: ExportOptions): string {
  if (options.outputFormat === "excel") return options.excelFileFormat;
  return options.outputFormat === "csv"
    ? "csv"
    : options.outputFormat === "html"
      ? "html"
      : options.outputFormat === "txt"
        ? "txt"
        : options.outputFormat === "sql"
          ? "sql"
          : options.outputFormat === "xml"
            ? "xml"
            : "json";
}
