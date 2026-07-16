import { useEffect, useMemo, useRef, useState } from "react";
import { Code, FileText, Loader2, Minus, Plus, Search, X } from "lucide-react";
import { MailHtmlReader, type MailHtmlReaderHandle } from "./MailHtmlReader";
import { MailTextReader } from "./MailTextReader";

export type MailBodyViewMode = "html" | "plain";

interface MailMessageBodyViewProps {
  html?: string | null;
  text?: string | null;
  snippet?: string | null;
  allowRemoteImages: boolean;
  preferDark?: boolean;
  fontSize?: number;
  title?: string;
  loading?: boolean;
}

const BODY_ZOOM_MIN = 0.75;
const BODY_ZOOM_MAX = 1.75;
const BODY_ZOOM_STEP = 0.1;

/**
 * Message body surface with HTML/Plain toggle, body zoom, and find-in-message.
 */
export function MailMessageBodyView({
  html,
  text,
  snippet,
  allowRemoteImages,
  preferDark = false,
  fontSize = 14,
  title = "Message body",
  loading = false,
}: MailMessageBodyViewProps) {
  const hasHtml = !!html?.trim();
  const hasText = !!text?.trim();
  const messageKey = `${hasHtml ? "h" : ""}${hasText ? "t" : ""}:${(html ?? "").length}:${(text ?? "").length}:${title}`;
  const defaultMode: MailBodyViewMode = hasHtml ? "html" : "plain";
  const [mode, setMode] = useState<MailBodyViewMode>(defaultMode);
  const [bodyZoom, setBodyZoom] = useState(1);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const htmlReaderRef = useRef<MailHtmlReaderHandle>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMode(hasHtml ? "html" : "plain");
    setBodyZoom(1);
    setFindOpen(false);
    setFindQuery("");
    setFindStatus(null);
  }, [messageKey, hasHtml]);

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  const showToggle = hasHtml && hasText;
  const activeMode: MailBodyViewMode = mode === "plain" && hasText
    ? "plain"
    : hasHtml
      ? "html"
      : "plain";

  const effectiveFontSize = useMemo(
    () => Math.round(Math.max(8, Math.min(36, fontSize * bodyZoom))),
    [bodyZoom, fontSize],
  );

  const emptyHint = useMemo(
    () => snippet?.trim() || "No cached body content.",
    [snippet],
  );

  const runFind = (backward = false) => {
    const q = findQuery.trim();
    if (!q) {
      setFindStatus(null);
      return;
    }
    if (activeMode === "html" && hasHtml) {
      const found = backward
        ? htmlReaderRef.current?.findPrevious(q)
        : htmlReaderRef.current?.findNext(q);
      setFindStatus(found ? null : "No matches");
      return;
    }
    // Plain: highlights via CSS; report whether query appears.
    const hay = (text ?? "").toLowerCase();
    setFindStatus(hay.includes(q.toLowerCase()) ? null : "No matches");
  };

  if (loading) {
    return (
      <div className="h-32 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]" data-testid="mail-reader-loading">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Loading message body
      </div>
    );
  }

  if (!hasHtml && !hasText) {
    return (
      <div className="text-[12px] text-[var(--taomni-text-muted)]" data-testid="mail-reader-empty">
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="mail-message-body-view">
      <div className="flex flex-wrap items-center gap-1.5">
        {showToggle && (
          <div
            className="flex items-center gap-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] p-0.5"
            data-testid="mail-body-mode-toggle"
            role="tablist"
            aria-label="Message body format"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === "html"}
              className={`h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] ${
                activeMode === "html"
                  ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)] shadow-sm"
                  : "text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
              }`}
              data-testid="mail-body-mode-html"
              onClick={() => setMode("html")}
            >
              <Code className="w-3 h-3" />
              HTML
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === "plain"}
              className={`h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] ${
                activeMode === "plain"
                  ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)] shadow-sm"
                  : "text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
              }`}
              data-testid="mail-body-mode-plain"
              onClick={() => setMode("plain")}
            >
              <FileText className="w-3 h-3" />
              Plain
            </button>
          </div>
        )}

        <div
          className="flex items-center gap-0.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] p-0.5"
          data-testid="mail-body-zoom"
        >
          <button
            type="button"
            className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-40"
            title="Zoom out"
            aria-label="Zoom out message body"
            data-testid="mail-body-zoom-out"
            disabled={bodyZoom <= BODY_ZOOM_MIN + 0.001}
            onClick={() => setBodyZoom((z) => Math.max(BODY_ZOOM_MIN, Math.round((z - BODY_ZOOM_STEP) * 10) / 10))}
          >
            <Minus className="w-3 h-3" />
          </button>
          <button
            type="button"
            className="h-6 min-w-[3rem] px-1 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] rounded"
            title="Reset zoom"
            data-testid="mail-body-zoom-reset"
            onClick={() => setBodyZoom(1)}
          >
            {Math.round(bodyZoom * 100)}%
          </button>
          <button
            type="button"
            className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] disabled:opacity-40"
            title="Zoom in"
            aria-label="Zoom in message body"
            data-testid="mail-body-zoom-in"
            disabled={bodyZoom >= BODY_ZOOM_MAX - 0.001}
            onClick={() => setBodyZoom((z) => Math.min(BODY_ZOOM_MAX, Math.round((z + BODY_ZOOM_STEP) * 10) / 10))}
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        <button
          type="button"
          className={`h-7 px-2 inline-flex items-center gap-1 rounded border border-[var(--taomni-divider)] text-[11px] ${
            findOpen
              ? "bg-[var(--taomni-bg)] text-[var(--taomni-accent)]"
              : "bg-[var(--taomni-sidebar-bg)] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
          }`}
          data-testid="mail-body-find-toggle"
          title="Find in message"
          onClick={() => {
            setFindOpen((open) => {
              if (open) {
                setFindQuery("");
                setFindStatus(null);
                htmlReaderRef.current?.clearFind();
              }
              return !open;
            });
          }}
        >
          <Search className="w-3 h-3" />
          Find
        </button>
      </div>

      {findOpen && (
        <div
          className="flex flex-wrap items-center gap-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] px-2 py-1.5"
          data-testid="mail-body-find-bar"
        >
          <Search className="w-3.5 h-3.5 text-[var(--taomni-text-muted)] shrink-0" />
          <input
            ref={findInputRef}
            type="search"
            className="taomni-input h-7 flex-1 min-w-[140px] text-[12px]"
            placeholder="Find in message…"
            value={findQuery}
            data-testid="mail-body-find-input"
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindStatus(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runFind(event.shiftKey);
              } else if (event.key === "Escape") {
                setFindOpen(false);
                setFindQuery("");
                setFindStatus(null);
                htmlReaderRef.current?.clearFind();
              }
            }}
          />
          <button
            type="button"
            className="taomni-btn h-7 px-2 text-[11px]"
            data-testid="mail-body-find-prev"
            onClick={() => runFind(true)}
          >
            Prev
          </button>
          <button
            type="button"
            className="taomni-btn h-7 px-2 text-[11px]"
            data-testid="mail-body-find-next"
            onClick={() => runFind(false)}
          >
            Next
          </button>
          {findStatus && (
            <span className="text-[11px] text-[var(--taomni-text-muted)]" data-testid="mail-body-find-status">
              {findStatus}
            </span>
          )}
          <button
            type="button"
            className="h-7 w-7 inline-flex items-center justify-center rounded text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]"
            aria-label="Close find"
            data-testid="mail-body-find-close"
            onClick={() => {
              setFindOpen(false);
              setFindQuery("");
              setFindStatus(null);
              htmlReaderRef.current?.clearFind();
            }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {activeMode === "html" && hasHtml ? (
        <MailHtmlReader
          ref={htmlReaderRef}
          html={html!}
          allowRemoteImages={allowRemoteImages}
          preferDark={preferDark}
          fontSize={effectiveFontSize}
          title={title}
        />
      ) : (
        <MailTextReader
          text={text ?? ""}
          preferDark={preferDark}
          fontSize={effectiveFontSize}
          highlightQuery={findOpen ? findQuery : undefined}
        />
      )}
    </div>
  );
}
