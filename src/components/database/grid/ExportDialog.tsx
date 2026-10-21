import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Download, FileText, FolderOpen } from "lucide-react";
import { readFileBytes, selectFilePath, selectSaveFilePath } from "../../../lib/ipc";
import { writeText } from "../../../lib/clipboard";
import { listQueryTabs } from "../../../lib/queryRegistry";
import { type ExportOptions, type ExportColumnConfig, type ExportTarget, type ExportDestination, type RowDelimiter, type IncludeOriginalSql, type SqlDelimiterMode, type OutputFormat, type Encoding, type TextFunction, type QuoteMode, type SqlCommanderPosition } from "./types";
import { readExportFileHistory, writeExportFileHistory, EXPORT_DEFAULTS_KEY, readStoredExportOptions, DEFAULT_EXPORT_OPTIONS } from "./preferences";
import { extensionForOptions, writeBytesToPath } from "./export";
import { nextRowId } from "./model";


export function ExportDialog({
  options,
  columns,
  target,
  rowCount,
  totalRows,
  onOptionsChange,
  onColumnsChange,
  onClose,
  onExport,
}: {
  options: ExportOptions;
  columns: ExportColumnConfig[];
  target: ExportTarget;
  rowCount: number;
  totalRows: number;
  onOptionsChange: (options: ExportOptions) => void;
  onColumnsChange: (columns: ExportColumnConfig[]) => void;
  onClose: () => void;
  onExport: (options: ExportOptions, columns: ExportColumnConfig[], destination: ExportDestination) => void;
}) {
  const [step, setStep] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileHistory, setFileHistory] = useState<string[]>(() => readExportFileHistory());
  const [destination, setDestination] = useState<ExportDestination>({
    kind: "file",
    filePath: "",
    sqlCommanderTabId: "active",
    sqlCommanderPosition: "caret",
  });
  const queryTabs = listQueryTabs();
  const input = "taomni-input h-7 text-[12px]";
  const label = "flex flex-col gap-1 text-[11px] text-[var(--taomni-text-muted)]";
  const sectionTitle = "mb-2 text-[12px] font-semibold";
  const update = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
    onOptionsChange({ ...options, [key]: value });
  };
  const updateColumn = (id: string, patch: Partial<ExportColumnConfig>) => {
    onColumnsChange(columns.map((column) => (column.id === id ? { ...column, ...patch } : column)));
  };
  const moveColumn = (id: string, direction: -1 | 1) => {
    const index = columns.findIndex((column) => column.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= columns.length) return;
    const next = [...columns];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    onColumnsChange(next);
  };
  const chooseFilePath = async () => {
    const path = await selectSaveFilePath(`query-results.${extensionForOptions(options)}`, destination.filePath || undefined);
    if (!path) return;
    setDestination((current) => ({ ...current, kind: "file", filePath: path }));
    const nextHistory = [path, ...fileHistory.filter((entry) => entry !== path)].slice(0, 12);
    setFileHistory(nextHistory);
    writeExportFileHistory(nextHistory);
  };
  const settingsPayload = () => JSON.stringify({ options, columns }, null, 2);
  const saveDefaultSettings = () => {
    localStorage.setItem(EXPORT_DEFAULTS_KEY, JSON.stringify(options));
    setSettingsOpen(false);
  };
  const useDefaultSettings = () => {
    onOptionsChange(readStoredExportOptions());
    setSettingsOpen(false);
  };
  const removeDefaultSettings = () => {
    localStorage.removeItem(EXPORT_DEFAULTS_KEY);
    onOptionsChange(DEFAULT_EXPORT_OPTIONS);
    setSettingsOpen(false);
  };
  const loadSettings = async () => {
    const path = await selectFilePath();
    if (!path) return;
    const text = new TextDecoder().decode(await readFileBytes(path));
    const parsed = JSON.parse(text) as { options?: Partial<ExportOptions>; columns?: ExportColumnConfig[] };
    onOptionsChange({ ...DEFAULT_EXPORT_OPTIONS, ...(parsed.options ?? {}) });
    if (Array.isArray(parsed.columns)) onColumnsChange(parsed.columns);
    setSettingsOpen(false);
  };
  const saveSettingsAs = async () => {
    const path = await selectSaveFilePath("export-grid-settings.json");
    if (!path) return;
    await writeBytesToPath(path, new TextEncoder().encode(settingsPayload()));
    setSettingsOpen(false);
  };
  const copySettings = async () => {
    await writeText(settingsPayload());
    setSettingsOpen(false);
  };
  const bool = (key: keyof ExportOptions, text: string) => (
    <label className="h-7 inline-flex items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
      <input type="checkbox" checked={Boolean(options[key])} onChange={(event) => update(key as never, event.target.checked as never)} />
      {text}
    </label>
  );
  const formatOptionFields = () => {
    if (options.outputFormat === "csv") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>Column Delimiter<select className={input} value={options.columnDelimiter} onChange={(event) => update("columnDelimiter", event.target.value)}><option value={"\t"}>TAB</option><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value="|">Pipe (|)</option></select></label>
          <label className={label}>Row Delimiter<select className={input} value={options.rowDelimiter} onChange={(event) => update("rowDelimiter", event.target.value as RowDelimiter)}><option value={"\n"}>UNIX LF</option><option value={"\r\n"}>Windows CRLF</option><option value={"\r"}>Mac CR</option></select></label>
          {bool("includeColumnNames", "Include Column Names")}
          {bool("useLabels", "Use any Label (Alias)")}
          {bool("removeNewlines", "Remove Newline Characters")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
          <label className={label}>Row Comment Identifier<input className={input} value={options.rowCommentIdentifier} onChange={(event) => update("rowCommentIdentifier", event.target.value)} /></label>
        </div>
      );
    }
    if (options.outputFormat === "html") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>Title<input className={input} value={options.htmlTitle} onChange={(event) => update("htmlTitle", event.target.value)} /></label>
          <label className={`${label} col-span-2`}>Description<input className={input} value={options.htmlDescription} onChange={(event) => update("htmlDescription", event.target.value)} /></label>
          <label className={label}>Footer<input className={input} value={options.htmlFooter} onChange={(event) => update("htmlFooter", event.target.value)} /></label>
          <label className={`${label} col-span-2`}>Per Table Header<input className={input} value={options.htmlPerTableHeader} onChange={(event) => update("htmlPerTableHeader", event.target.value)} /></label>
          {bool("htmlConvertCharacters", "Convert HTML characters")}
          {bool("useLabels", "Use any Label (Alias)")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
        </div>
      );
    }
    if (options.outputFormat === "txt") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>Spaces Between Columns<input className={input} type="number" min={1} value={options.txtSpacesBetweenColumns} onChange={(event) => update("txtSpacesBetweenColumns", Math.max(1, Number(event.target.value) || 1))} /></label>
          <label className={label}>Row Delimiter<select className={input} value={options.rowDelimiter} onChange={(event) => update("rowDelimiter", event.target.value as RowDelimiter)}><option value={"\n"}>UNIX LF</option><option value={"\r\n"}>Windows CRLF</option><option value={"\r"}>Mac CR</option></select></label>
          {bool("includeColumnNames", "Include Column Names")}
          {bool("useLabels", "Use any Label (Alias)")}
          {bool("removeNewlines", "Remove Newline Characters")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
        </div>
      );
    }
    if (options.outputFormat === "sql") {
      return (
        <div className="grid grid-cols-4 gap-2">
          {bool("sqlUseQualifier", "Use Qualifier")}
          <label className={label}>Qualifier<input className={input} value={options.sqlQualifier} onChange={(event) => update("sqlQualifier", event.target.value)} /></label>
          <label className={label}>Table Name<input className={input} value={options.sqlTableName} onChange={(event) => update("sqlTableName", event.target.value)} /></label>
          <label className={label}>Delimiters<select className={input} value={options.sqlDelimiterMode} onChange={(event) => update("sqlDelimiterMode", event.target.value as SqlDelimiterMode)}><option value="none">None</option><option value="double">Double Quote</option><option value="backtick">Backtick</option><option value="bracket">Bracket</option></select></label>
          <label className={label}>Statement Separator<input className={input} value={options.sqlStatementSeparator} onChange={(event) => update("sqlStatementSeparator", event.target.value)} /></label>
          {bool("sqlIncludeBasicDdl", "Include Basic DDL")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
          <label className={label}>Row Comment Identifier<input className={input} value={options.rowCommentIdentifier} onChange={(event) => update("rowCommentIdentifier", event.target.value)} /></label>
          <label className={label}>Add Before<input className={input} value={options.sqlAddBefore} onChange={(event) => update("sqlAddBefore", event.target.value)} /></label>
          <label className={label}>Add After<input className={input} value={options.sqlAddAfter} onChange={(event) => update("sqlAddAfter", event.target.value)} /></label>
          {bool("sqlGenerateMultiRow", "Generate Multi-Row INSERT statements")}
          <label className={label}>Rows per Multi-Row INSERT<input className={input} type="number" min={1} value={options.sqlRowsPerMultiRow} onChange={(event) => update("sqlRowsPerMultiRow", Math.max(1, Number(event.target.value) || 1))} /></label>
          <label className={label}>Type<select className={input} value={options.sqlMultiRowType} onChange={(event) => update("sqlMultiRowType", event.target.value as ExportOptions["sqlMultiRowType"])}><option value="multi-insert-sql92">multi-insert-sql92</option></select></label>
          {bool("sqlGenerateMerge", "Generate MERGE statements")}
          <label className={label}>Merge Type<select className={input} value={options.sqlMergeType} onChange={(event) => update("sqlMergeType", event.target.value as ExportOptions["sqlMergeType"])}><option value="single-merge-sql92">single-merge-sql92</option></select></label>
          <label className={`${label} col-span-2`}>The columns to use when matching rows<input className={input} value={options.sqlMergeMatchColumns} onChange={(event) => update("sqlMergeMatchColumns", event.target.value)} /></label>
        </div>
      );
    }
    if (options.outputFormat === "xml") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>XML Style<select className={input} value={options.xmlStyle} onChange={(event) => update("xmlStyle", event.target.value as ExportOptions["xmlStyle"])}><option value="dbvis">DbVisualizer</option><option value="flat">Flat Elements</option></select></label>
          <label className={`${label} col-span-2`}>Description<input className={input} value={options.xmlDescription} onChange={(event) => update("xmlDescription", event.target.value)} /></label>
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
          {bool("useLabels", "Use any Label (Alias)")}
        </div>
      );
    }
    if (options.outputFormat === "excel") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>File Format<select className={input} value={options.excelFileFormat} onChange={(event) => update("excelFileFormat", event.target.value as ExportOptions["excelFileFormat"])}><option value="xlsx">XLSX</option><option value="xls">XLS</option></select></label>
          <label className={label}>Title<input className={input} value={options.excelTitle} onChange={(event) => update("excelTitle", event.target.value)} /></label>
          <label className={label}>Description<input className={input} value={options.excelDescription} onChange={(event) => update("excelDescription", event.target.value)} /></label>
          <label className={label}>Sheet Name<input className={input} value={options.excelSheetName} onChange={(event) => update("excelSheetName", event.target.value)} /></label>
          {bool("includeColumnNames", "Include Column Names")}
          {bool("useLabels", "Use any Label (Alias)")}
          {bool("excelExportNumberAsText", "Export Number as Text")}
          {bool("excelExportDateTimeAsText", "Export Date/Time as Text")}
          {bool("excelAutoResizeColumns", "Auto Resize Columns")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">None</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-4 gap-2">
        <label className={label}>JSON Style<select className={input} value={options.jsonStyle} onChange={(event) => update("jsonStyle", event.target.value as ExportOptions["jsonStyle"])}><option value="array">Array</option><option value="object">Object with rows</option></select></label>
        {bool("useLabels", "Use any Label (Alias)")}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45" onMouseDown={onClose}>
      <div
        className="w-[920px] max-w-[calc(100vw-24px)] h-[min(760px,calc(100vh-24px))] flex flex-col rounded shadow-xl"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)", color: "var(--taomni-text)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="h-11 flex items-center gap-2 px-3" style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
          <Download className="w-4 h-4" />
          <div className="font-semibold text-[13px]">Export Grid</div>
          <div className="ml-3 flex items-center gap-1 text-[11px]">
            {["Format", "Columns", "Output"].map((name, index) => (
              <button key={name} type="button" className="h-6 px-2 rounded" style={{ background: step === index ? "var(--taomni-selected)" : "transparent", color: step === index ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }} onClick={() => setStep(index)}>{index + 1}. {name}</button>
            ))}
          </div>
          <div className="ml-auto text-[11px] text-[var(--taomni-text-muted)]">{target === "selection" ? "Selection" : "All visible rows"}: {rowCount} / Total Rows in Grid: {totalRows}</div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-3">
          {step === 0 && (
            <div className="space-y-3">
              <section>
                <div className={sectionTitle}>Output Format</div>
                <div className="grid grid-cols-4 gap-2">
                  <label className={label}>Output Format<select className={input} value={options.outputFormat} onChange={(event) => update("outputFormat", event.target.value as OutputFormat)}><option value="csv">CSV</option><option value="html">HTML</option><option value="txt">TXT</option><option value="sql">SQL</option><option value="xml">XML</option><option value="excel">Excel</option><option value="json">JSON</option></select></label>
                  <label className={label}>Encoding<select className={input} value={options.encoding} onChange={(event) => update("encoding", event.target.value as Encoding)}><option value="utf-8">UTF-8</option><option value="utf-8-bom">UTF-8 BOM</option><option value="utf-16le">UTF-16 LE</option></select></label>
                  <label className={label}>Max Rows<input className={input} type="number" min={0} value={options.maxRows} onChange={(event) => update("maxRows", Math.max(0, Number(event.target.value) || 0))} /></label>
                </div>
              </section>
              <section>
                <div className={sectionTitle}>Data Format</div>
                <div className="grid grid-cols-4 gap-2">
                  <label className={label}>Date<input className={input} value={options.dateFormat} onChange={(event) => update("dateFormat", event.target.value)} /></label>
                  <label className={label}>Time<input className={input} value={options.timeFormat} onChange={(event) => update("timeFormat", event.target.value)} /></label>
                  <label className={label}>Timestamp<input className={input} value={options.timestampFormat} onChange={(event) => update("timestampFormat", event.target.value)} /></label>
                  <label className={label}>Text Function<select className={input} value={options.textFunction} onChange={(event) => update("textFunction", event.target.value as TextFunction)}><option value="none">None</option><option value="upper">Upper case</option><option value="lower">Lower case</option><option value="trim">Trim</option></select></label>
                  <label className={label}>Number<select className={input} value={options.numberFormat} onChange={(event) => update("numberFormat", event.target.value as ExportOptions["numberFormat"])}><option value="unformatted">Unformatted</option><option value="grouped">Custom separators</option></select></label>
                  <label className={label}>Decimal Number<select className={input} value={options.decimalFormat} onChange={(event) => update("decimalFormat", event.target.value as ExportOptions["decimalFormat"])}><option value="unformatted">Unformatted</option><option value="grouped">Custom separators</option></select></label>
                  <label className={label}>Grouping Separator<input className={input} value={options.groupSeparator} onChange={(event) => update("groupSeparator", event.target.value)} /></label>
                  <label className={label}>Decimal Separator<input className={input} value={options.decimalSeparator} onChange={(event) => update("decimalSeparator", event.target.value)} /></label>
                  <label className={label}>Boolean True<input className={input} value={options.booleanTrueText} onChange={(event) => update("booleanTrueText", event.target.value)} /></label>
                  <label className={label}>Boolean False<input className={input} value={options.booleanFalseText} onChange={(event) => update("booleanFalseText", event.target.value)} /></label>
                  <label className={label}>Binary/BLOB<select className={input} value={options.binaryMode} onChange={(event) => update("binaryMode", event.target.value as ExportOptions["binaryMode"])}><option value="dont">Don't Export</option><option value="text">Export Text</option><option value="length">Length Text</option></select></label>
                  <label className={label}>CLOB<select className={input} value={options.clobMode} onChange={(event) => update("clobMode", event.target.value as ExportOptions["clobMode"])}><option value="dont">Don't Export</option><option value="text">Export Text</option></select></label>
                  <label className={label}>Null Value Text<input className={input} value={options.nullValueText} onChange={(event) => update("nullValueText", event.target.value)} /></label>
                  <label className={label}>Quote Text Value<select className={input} value={options.quoteTextValue} onChange={(event) => update("quoteTextValue", event.target.value as QuoteMode)}><option value="single">Single</option><option value="double">Double</option><option value="none">None</option></select></label>
                  {bool("duplicateEmbedded", "Duplicate Embedded")}
                  {bool("quoteAllValues", "Quote All Values")}
                </div>
              </section>
              <section>
                <div className={sectionTitle}>Options</div>
                {formatOptionFields()}
              </section>
            </div>
          )}

          {step === 1 && (
            <div className="h-full min-h-[420px] grid grid-cols-[1fr_150px] gap-3">
              <div className="min-w-0 overflow-auto taomni-scroll-y" style={{ border: "1px solid var(--taomni-divider)" }}>
                <div className="min-w-[860px] grid grid-cols-[54px_160px_180px_120px_70px_130px_1fr] text-[11px]" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
                  {["Export", "Name", "Label (Alias)", "Type", "Is Text", "Text Function", "Value"].map((head) => <div key={head} className="px-2 py-1 font-semibold" style={{ borderRight: "1px solid var(--taomni-divider)" }}>{head}</div>)}
                  {columns.map((column) => (
                    <div key={column.id} className="contents">
                      <label className="px-2 py-1"><input type="checkbox" checked={column.export} onChange={(event) => updateColumn(column.id, { export: event.target.checked })} /></label>
                      <div className="px-2 py-1 truncate">{column.name}</div>
                      <div className="px-1 py-1"><input className="taomni-input h-6 w-full text-[11px]" value={column.label} onChange={(event) => updateColumn(column.id, { label: event.target.value })} /></div>
                      <div className="px-2 py-1 truncate">{column.type}</div>
                      <label className="px-2 py-1"><input type="checkbox" checked={column.isText} onChange={(event) => updateColumn(column.id, { isText: event.target.checked })} /></label>
                      <div className="px-1 py-1"><select className="taomni-input h-6 w-full text-[11px]" value={column.textFunction} onChange={(event) => updateColumn(column.id, { textFunction: event.target.value as TextFunction })}><option value="none">None</option><option value="upper">Upper case</option><option value="lower">Lower case</option><option value="trim">Trim</option></select></div>
                      <div className="px-1 py-1"><input className="taomni-input h-6 w-full text-[11px]" value={column.valueTemplate} onChange={(event) => updateColumn(column.id, { valueTemplate: event.target.value })} /></div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <button type="button" className="taomni-btn w-full" onClick={() => onColumnsChange([...columns, { id: nextRowId("export-col"), export: true, name: `custom_${columns.length + 1}`, label: `custom_${columns.length + 1}`, type: "String", isText: true, textFunction: "none", valueTemplate: "" }])}>+ Add Column</button>
                <button type="button" className="taomni-btn w-full" onClick={() => onColumnsChange(columns.map((column) => ({ ...column, export: true })))}>Select All</button>
                <button type="button" className="taomni-btn w-full" onClick={() => onColumnsChange(columns.map((column) => ({ ...column, export: false })))}>Select None</button>
                {columns.map((column) => (
                  <div key={column.id} className="flex gap-1">
                    <button type="button" className="taomni-btn flex-1 truncate" onClick={() => moveColumn(column.id, -1)}>Up</button>
                    <button type="button" className="taomni-btn flex-1 truncate" onClick={() => moveColumn(column.id, 1)}>Down</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3 text-[12px]">
              <label className="flex items-center gap-2"><input type="radio" checked={destination.kind === "file"} onChange={() => setDestination((current) => ({ ...current, kind: "file" }))} />File</label>
              {destination.kind === "file" && (
                <div className="grid grid-cols-[1fr_130px] gap-2">
                  <input className={input} value={destination.filePath} onChange={(event) => setDestination((current) => ({ ...current, filePath: event.target.value }))} placeholder="Output file path" />
                  <button type="button" className="taomni-btn inline-flex items-center justify-center gap-1" onClick={() => void chooseFilePath()}><FolderOpen className="w-3.5 h-3.5" />Browse</button>
                  <select className={`${input} col-span-2`} value="" onChange={(event) => event.target.value && setDestination((current) => ({ ...current, filePath: event.target.value }))}>
                    <option value="">History</option>
                    {fileHistory.map((path) => <option key={path} value={path}>{path}</option>)}
                  </select>
                </div>
              )}
              <label className="flex items-center gap-2"><input type="radio" checked={destination.kind === "sqlCommander"} onChange={() => setDestination((current) => ({ ...current, kind: "sqlCommander" }))} />SQL Commander</label>
              {destination.kind === "sqlCommander" && (
                <div className="grid grid-cols-2 gap-2">
                  <label className={label}>Editor<select className={input} value={destination.sqlCommanderTabId} onChange={(event) => setDestination((current) => ({ ...current, sqlCommanderTabId: event.target.value }))}><option value="new">New Editor</option><option value="active">Active Editor</option>{queryTabs.map((tab) => <option key={tab.tabId} value={tab.tabId}>{tab.title}</option>)}</select></label>
                  <label className={label}>Insert Position<select className={input} value={destination.sqlCommanderPosition} onChange={(event) => setDestination((current) => ({ ...current, sqlCommanderPosition: event.target.value as SqlCommanderPosition }))}><option value="caret">At Caret</option><option value="first">First</option><option value="last">Last</option><option value="replaceAll">Replace All</option></select></label>
                </div>
              )}
              <label className="flex items-center gap-2"><input type="radio" checked={destination.kind === "clipboard"} onChange={() => setDestination((current) => ({ ...current, kind: "clipboard" }))} />Clipboard</label>
            </div>
          )}
        </div>

        <div className="relative h-11 flex items-center gap-2 px-3" style={{ borderTop: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
          <button type="button" className="taomni-btn inline-flex items-center gap-1" onClick={() => setSettingsOpen((value) => !value)}><FileText className="w-3.5 h-3.5" />Settings</button>
          {settingsOpen && (
            <div className="absolute left-3 bottom-10 z-10 min-w-[230px] rounded shadow-lg p-1 text-[12px]" style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={saveDefaultSettings}>Save As Default Settings</button>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={useDefaultSettings}>Use Default Settings</button>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={removeDefaultSettings}>Remove Default Settings</button>
              <div className="my-1 h-px" style={{ background: "var(--taomni-divider)" }} />
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={() => void loadSettings()}>Load...</button>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={() => void saveSettingsAs()}>Save As...</button>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={() => void copySettings()}>Copy Settings to Clipboard</button>
            </div>
          )}
          <div className="flex-1" />
          <button type="button" className="taomni-btn inline-flex items-center gap-1" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}><ArrowLeft className="w-3.5 h-3.5" />Back</button>
          {step < 2 ? (
            <button type="button" className="taomni-btn inline-flex items-center gap-1" data-primary="true" onClick={() => setStep((value) => Math.min(2, value + 1))}>Next<ArrowRight className="w-3.5 h-3.5" /></button>
          ) : (
            <button type="button" className="taomni-btn inline-flex items-center gap-1" data-primary="true" onClick={() => onExport(options, columns, destination)}><Check className="w-3.5 h-3.5" />Export</button>
          )}
          <button type="button" className="taomni-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
