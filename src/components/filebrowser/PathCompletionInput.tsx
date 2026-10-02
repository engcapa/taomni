import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Folder } from "lucide-react";
import { useT } from "../../lib/i18n";
import { commonPathPrefix, pathCompletionQuery, pathSuggestions, resolvePathInput } from "../../lib/pathCompletion";
import type { FileEntry } from "../../lib/sftp";

interface Props {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  listDirectory?: (path: string) => Promise<FileEntry[]>;
  homePath?: string | null;
  detectWindows?: boolean;
  showHidden?: boolean;
  testId?: string;
}

export function PathCompletionInput({ path, value, onChange, onCommit, onCancel, listDirectory, homePath, detectWindows, showHidden, testId }: Props) {
  const t = useT();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingTab = useRef<string | null>(null);
  const committed = useRef(false);
  const [composing, setComposing] = useState(false);
  const [listing, setListing] = useState<{ directory: string; provider: Props["listDirectory"]; entries: FileEntry[]; error?: boolean } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({});
  const query = useMemo(() => pathCompletionQuery(value, path, homePath, detectWindows), [value, path, homePath, detectWindows]);
  const matchingListing = listing?.directory === query.directory && listing.provider === listDirectory;
  const loading = !!listDirectory && !composing && !matchingListing;
  const suggestions = useMemo(() => matchingListing && listing
    ? pathSuggestions(listing.entries, query, showHidden) : [], [matchingListing, listing, query, showHidden]);
  const open = !!listDirectory && !composing;
  const activeSuggestion = suggestions[activeIndex];

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!listDirectory || composing) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listDirectory(query.directory).then((entries) => {
        if (!cancelled) setListing({ directory: query.directory, provider: listDirectory, entries });
      }).catch(() => {
        if (!cancelled) setListing({ directory: query.directory, provider: listDirectory, entries: [], error: true });
      });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query.directory, listDirectory, composing]);

  useEffect(() => { setActiveIndex(-1); }, [value]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      const upwards = below < 180 && above > below;
      setPosition({
        position: "fixed", left: Math.max(4, rect.left), width: Math.min(rect.width, window.innerWidth - 8),
        top: upwards ? undefined : rect.bottom + 2,
        bottom: upwards ? window.innerHeight - rect.top + 2 : undefined,
        maxHeight: Math.min(260, Math.max(60, (upwards ? above : below) - 8)), zIndex: 10000,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);

  useEffect(() => {
    if (activeIndex >= 0) listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const complete = () => {
    if (!suggestions.length) return;
    const common = commonPathPrefix(suggestions, query.windows);
    const resolved = resolvePathInput(value, path, homePath, query.windows);
    onChange(activeSuggestion ? activeSuggestion.value
      : suggestions.length > 1 && common.length > resolved.length ? common : suggestions[0].value);
  };

  useEffect(() => {
    if (pendingTab.current !== value || loading || composing) return;
    pendingTab.current = null;
    complete();
    // Completion must use the matching loaded directory and current input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, suggestions, composing, value]);

  const commit = (next: string) => {
    if (committed.current) return;
    committed.current = true;
    onCommit(next);
  };

  return <>
    <input
      ref={inputRef}
      data-testid={testId}
      aria-label={testId ?? t("fileBrowser.pathBreadcrumbEditTitle")}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={activeSuggestion ? `${listId}-${activeIndex}` : undefined}
      autoComplete="off"
      spellCheck={false}
      className="taomni-input flex-1 min-w-0 h-6"
      value={value}
      onChange={(e) => { pendingTab.current = null; onChange(e.target.value); }}
      onBlur={() => commit(value)}
      onCompositionStart={() => { pendingTab.current = null; setComposing(true); }}
      onCompositionEnd={() => setComposing(false)}
      onKeyDown={(e) => {
        if (composing || e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") {
          e.preventDefault(); e.stopPropagation(); committed.current = true; onCancel();
        } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (suggestions.length || loading)) {
          e.preventDefault(); e.stopPropagation();
          if (loading) pendingTab.current = value;
          else complete();
        } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestions.length) {
          e.preventDefault(); e.stopPropagation();
          setActiveIndex((index) => e.key === "ArrowDown" ? (index + 1) % suggestions.length : (index <= 0 ? suggestions.length : index) - 1);
        } else if (e.key === "Enter") {
          e.preventDefault(); e.stopPropagation(); commit(activeSuggestion ? activeSuggestion.value : value);
        }
      }}
    />
    {open && createPortal(
      <div
        data-testid={testId ? `${testId}-suggestions` : undefined}
        className="rounded shadow-lg border overflow-y-auto text-[12px]"
        style={{ ...position, background: "var(--taomni-bg)", color: "var(--taomni-text)", borderColor: "var(--taomni-input-border)" }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div ref={listRef} id={listId} role="listbox" aria-label={t("fileBrowser.pathCompletionSuggestions")} aria-busy={loading}>
          {suggestions.map((suggestion, index) => <div
            id={`${listId}-${index}`}
            key={suggestion.value}
            role="option"
            aria-selected={index === activeIndex}
            data-path={suggestion.value}
            className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-[var(--taomni-hover)]"
            style={{ background: index === activeIndex ? "var(--taomni-selected)" : undefined }}
            title={suggestion.value}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => { pendingTab.current = null; onChange(suggestion.value); inputRef.current?.focus(); }}
          >
            <Folder className="w-3.5 h-3.5 shrink-0" />
            <div className="min-w-0">
              <div className="truncate font-medium">{suggestion.name}</div>
              <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">{suggestion.value}</div>
            </div>
          </div>)}
        </div>
        {!suggestions.length && <div role="status" className="px-2 py-1 text-[var(--taomni-text-muted)]">
          {t(loading ? "fileBrowser.pathCompletionLoading" : listing?.error ? "fileBrowser.pathCompletionError" : "fileBrowser.pathCompletionEmpty")}
        </div>}
        {!!suggestions.length && <div className="px-2 py-1 text-[var(--taomni-text-muted)] border-t" style={{ borderColor: "var(--taomni-divider)" }}>
          {t("fileBrowser.pathCompletionHint")}
        </div>}
      </div>, document.body,
    )}
  </>;
}
