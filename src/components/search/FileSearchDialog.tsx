import { File, Folder, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../lib/i18n";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { validFileQuery, type GlobalFileMatch } from "../../lib/explorer/globalFileSearch";
import { openFile } from "../../lib/openFile";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useGlobalFileSearch } from "./useGlobalFileSearch";

interface Props {
  contextRoot?: string;
  initialQuery?: string;
  returnFocus: HTMLElement;
  onClose: () => void;
  onOpened?: () => void;
}

export function FileSearchDialog({ contextRoot, initialQuery, returnFocus, onClose, onOpened = onClose }: Props) {
  const t = useT();
  const search = useGlobalFileSearch(contextRoot, initialQuery);
  const { state } = search;
  const results = state.phase === "done" ? state.results : undefined;
  const hintId = useId();
  const field = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [activeRow, setActiveRow] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const openRequest = useRef<symbol | null>(null);
  useEffect(() => () => { openRequest.current = null; }, []);

  const open = async (entry: GlobalFileMatch) => {
    if (openRequest.current) return;
    const token = Symbol();
    openRequest.current = token;
    setOpening(true);
    setOpenError("");
    try {
      if (entry.isDirectory) await openExplorer(entry.path);
      else await openFile(entry.path, { context: "global-file-search", host: "explorer" });
      if (openRequest.current === token) onOpened();
    } catch (error) {
      if (openRequest.current === token) setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      if (openRequest.current === token) {
        openRequest.current = null;
        setOpening(false);
      }
    }
  };
  const navigateRows = (event: KeyboardEvent, index: number) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !results?.entries.length) return;
    let target: number;
    if (event.key === "ArrowDown") target = Math.min(index + 1, results.entries.length - 1);
    else if (event.key === "ArrowUp" && index >= 0) target = index - 1;
    else if (event.key === "Home" && index >= 0) target = 0;
    else if (event.key === "End" && index >= 0) target = results.entries.length - 1;
    else return;
    event.preventDefault();
    if (target < 0) field.current?.focus();
    else rows.current?.querySelectorAll("button")[target]?.focus();
  };

  return <Modal title={t("fileSearch.title")} testId="file-search-dialog" size="wide"
    initialFocus='[data-testid="file-search-input"]' returnFocus={returnFocus} onCancel={onClose}
    footer={<Button data-testid="file-search-close" onClick={onClose}>{t("common.close")}</Button>}>
    <div className="flex items-center gap-2">
      <input className="taomni-input min-w-0 flex-1" ref={field} data-testid="file-search-input"
        aria-label={t("fileSearch.filename")} aria-describedby={hintId} placeholder={t("fileSearch.filename")}
        spellCheck={false} autoComplete="off" value={search.query} disabled={opening}
        onChange={(event) => { search.edit(event.target.value); setOpenError(""); setActiveRow(0); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); search.submit(); }
          else navigateRows(event, -1);
        }} />
      <Button variant="primary" data-testid="file-search-submit" busy={state.phase === "loading"}
        disabled={!validFileQuery(search.query) || opening} onClick={search.submit}>
        {state.phase !== "loading" && <Search aria-hidden="true" className="size-3.5" />}{t("fileSearch.submit")}
      </Button>
      {state.phase === "loading" && <Button data-testid="file-search-cancel" onClick={() => { search.cancel(); field.current?.focus(); }}>{t("common.cancel")}</Button>}
    </div>
    <div role="status" aria-live="polite" className="mt-2 text-ui-body" data-testid="file-search-status" data-state={state.phase}
      data-provider={results?.provider} data-truncated={results?.truncated}>
      <p id={hintId} className="text-ui-small text-[var(--taomni-text-muted)]">{t("fileSearch.hint")}</p>
      {state.phase === "loading" && t("fileSearch.searching")}
      {state.phase === "cancelled" && t("fileSearch.cancelled")}
      {state.phase === "error" && <p className="text-ui-danger">{state.detail.startsWith("busy:") ? t("fileSearch.busy") : t("fileSearch.failed", { detail: state.detail })}</p>}
      {results && <>
        <p>{results.entries.length ? t("fileSearch.count", { count: results.entries.length }) : t("fileSearch.empty")}</p>
        <p className="text-ui-small text-[var(--taomni-text-muted)]">{t("fileSearch.provider", { provider: t(`fileSearch.${results.provider}`) })}</p>
        {results.scannedRoots.length > 0 && <p className="taomni-mono text-ui-small text-[var(--taomni-text-muted)]">{t("fileSearch.scannedRoots", { roots: results.scannedRoots.join(" · ") })}</p>}
        {results.truncated && <p>{t("fileSearch.limited")}</p>}
      </>}
    </div>
    {openError && <p role="alert" className="mt-2 text-ui-danger">{t("fileSearch.openFailed", { detail: openError })}</p>}
    {results && results.entries.length > 0 && <div ref={rows} className="mt-2 max-h-[45vh] overflow-auto">
      {results.entries.map((entry, index) => {
        const Kind = entry.isDirectory ? Folder : File;
        return <button type="button" key={entry.path} data-testid="file-search-result" data-path={entry.path}
          className="flex w-full min-w-0 items-start gap-1.5 rounded px-2 py-1.5 text-left hover:bg-[var(--taomni-hover)] focus-visible:bg-[var(--taomni-selected)]"
          tabIndex={index === Math.min(activeRow, results.entries.length - 1) ? 0 : -1} disabled={opening}
          onFocus={() => setActiveRow(index)} onKeyDown={(event) => navigateRows(event, index)} onClick={() => void open(entry)}>
          <Kind className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">{t(entry.isDirectory ? "fileSearch.folder" : "fileSearch.file")}</span>
          <span className="min-w-0 break-all"><span className="block text-ui-body">{entry.name}</span>
            <span className="taomni-mono block select-text text-ui-small text-[var(--taomni-text-muted)]">{entry.path}</span>
          </span>
        </button>;
      })}
    </div>}
  </Modal>;
}
