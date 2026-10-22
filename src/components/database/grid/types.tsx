import type { DbColumn, DbQueryResult, DbResultSqlRewriteRequest } from "../../../lib/ipc";
import { type GridChangePreview } from "../../../lib/dbGridChanges";


export type QueryRefreshMode = "normal" | "currentLimit" | "clearView";

export type QueryGeneratedSqlSyncMode = "sync" | "replaceSource";


export interface QueryGridRowChange {
  status: "inserted" | "updated" | "deleted";
  originalIndex: number | null;
  values: (string | null)[];
  original: (string | null)[] | null;
}


export interface QueryGridCommitPayload {
  columns: DbColumn[];
  changes: QueryGridRowChange[];
  counts: {
    inserted: number;
    updated: number;
    deleted: number;
  };
}


export interface QueryResultGridProps {
  result: DbQueryResult;
  sourceSql?: string;
  baseSql?: string;
  sqlEngine?: string;
  running?: boolean;
  cancelling?: boolean;
  onRefresh?: (mode: QueryRefreshMode) => void;
  onCancel?: () => void;
  onCommitChanges?: (payload: QueryGridCommitPayload) => Promise<void>;
  /** Generates the DML shown in the save confirmation before it runs. */
  onPreviewChanges?: (payload: QueryGridCommitPayload) => Promise<GridChangePreview>;
  onGeneratedSqlSync?: (sql: string, mode: QueryGeneratedSqlSyncMode) => void;
  onGeneratedSqlQuery?: (sql: string, request?: DbResultSqlRewriteRequest) => void | Promise<void>;
  onStatus?: (message: string) => void;
}


export interface ResolvedGeneratedSql {
  key: string;
  sql: string | null;
  mode: "inline" | "unsupported" | null;
  reason: string | null;
  pending: boolean;
}


export type SortDir = "asc" | "desc" | null;

export type ActiveSortDir = Exclude<SortDir, null>;

export interface SortRule {
  columnIndex: number;
  dir: ActiveSortDir;
}

export type ViewMode = "table" | "list" | "chart";

export type RowStatus = "clean" | "inserted" | "updated" | "deleted";

export type ExportTarget = "all" | "selection";

export type ColumnFilterMode = "fuzzy" | "exact";

export type OutputFormat = "csv" | "html" | "txt" | "sql" | "xml" | "excel" | "json";

export type TextFunction = "none" | "upper" | "lower" | "trim";

export type QuoteMode = "double" | "single" | "none";

export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le";

export type IncludeOriginalSql = "none" | "top" | "comment";

export type RowDelimiter = "\n" | "\r\n" | "\r";

export type SqlDelimiterMode = "none" | "double" | "backtick" | "bracket";

export type OutputDestinationKind = "file" | "sqlCommander" | "clipboard";

export type SqlCommanderPosition = "caret" | "first" | "last" | "replaceAll";


export interface GridRow {
  id: string;
  originalIndex: number | null;
  values: (string | null)[];
  original: (string | null)[] | null;
  status: RowStatus;
}


export interface ColumnFilterConfig {
  text: string;
  mode: ColumnFilterMode;
  selectedValues: (string | null)[];
}


export interface ActiveColumnFilter {
  columnIndex: number;
  text: string;
  mode: ColumnFilterMode;
  selectedValues: (string | null)[];
}


export interface DistinctColumnValue {
  key: string;
  value: string | null;
  label: string;
  count: number;
}


export interface DistinctColumnSummary {
  values: DistinctColumnValue[];
  total: number;
  truncated: boolean;
}


export interface GeneratedResultSqlOptions {
  sourceSql?: string;
  currentSql?: string;
  sqlEngine?: string;
  columns: DbColumn[];
  visibleColumnIndexes: number[];
  globalFilterText: string;
  columnFilters: ActiveColumnFilter[];
  sorts: SortRule[];
}


export interface OpenColumnFilter {
  columnIndex: number;
  left: number;
  top: number;
}


export interface GridCellCoord {
  rowId: string;
  colIdx: number;
}


export interface CellValueViewer {
  rowNumber: number;
  column: DbColumn;
  value: string | null;
}


export interface GridBlockSelection {
  anchor: GridCellCoord;
  focus: GridCellCoord;
  dragging: boolean;
}


export interface ExportOptions {
  outputFormat: OutputFormat;
  encoding: Encoding;
  dateFormat: string;
  timeFormat: string;
  timestampFormat: string;
  numberFormat: "unformatted" | "grouped";
  decimalFormat: "unformatted" | "grouped";
  groupSeparator: string;
  decimalSeparator: string;
  booleanTrueText: string;
  booleanFalseText: string;
  binaryMode: "dont" | "text" | "length";
  clobMode: "text" | "dont";
  nullValueText: string;
  quoteTextValue: QuoteMode;
  duplicateEmbedded: boolean;
  quoteAllValues: boolean;
  textFunction: TextFunction;
  maxRows: number;
  columnDelimiter: string;
  rowDelimiter: RowDelimiter;
  includeColumnNames: boolean;
  useLabels: boolean;
  removeNewlines: boolean;
  includeOriginalSql: IncludeOriginalSql;
  rowCommentIdentifier: string;
  htmlTitle: string;
  htmlDescription: string;
  htmlFooter: string;
  htmlPerTableHeader: string;
  htmlConvertCharacters: boolean;
  txtSpacesBetweenColumns: number;
  sqlUseQualifier: boolean;
  sqlQualifier: string;
  sqlTableName: string;
  sqlDelimiterMode: SqlDelimiterMode;
  sqlStatementSeparator: string;
  sqlIncludeBasicDdl: boolean;
  sqlAddBefore: string;
  sqlAddAfter: string;
  sqlGenerateMultiRow: boolean;
  sqlRowsPerMultiRow: number;
  sqlMultiRowType: "multi-insert-sql92";
  sqlGenerateMerge: boolean;
  sqlMergeType: "single-merge-sql92";
  sqlMergeMatchColumns: string;
  xmlStyle: "dbvis" | "flat";
  xmlDescription: string;
  excelFileFormat: "xlsx" | "xls";
  excelTitle: string;
  excelDescription: string;
  excelSheetName: string;
  excelExportNumberAsText: boolean;
  excelExportDateTimeAsText: boolean;
  excelAutoResizeColumns: boolean;
  jsonStyle: "array" | "object";
}


export interface ExportColumnConfig {
  id: string;
  export: boolean;
  name: string;
  label: string;
  type: string;
  isText: boolean;
  textFunction: TextFunction;
  valueTemplate: string;
}


export interface ExportDestination {
  kind: OutputDestinationKind;
  filePath: string;
  sqlCommanderTabId: "active" | "new" | string;
  sqlCommanderPosition: SqlCommanderPosition;
}
