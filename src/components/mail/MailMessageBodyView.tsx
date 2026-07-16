import { useEffect, useMemo, useState } from "react";
import { Code, FileText, Loader2 } from "lucide-react";
import { MailHtmlReader } from "./MailHtmlReader";
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

/**
 * Message body surface with optional HTML / Plain toggle when both parts exist.
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

  useEffect(() => {
    setMode(hasHtml ? "html" : "plain");
  }, [messageKey, hasHtml]);

  const showToggle = hasHtml && hasText;
  const activeMode: MailBodyViewMode = mode === "plain" && hasText
    ? "plain"
    : hasHtml
      ? "html"
      : "plain";

  const emptyHint = useMemo(
    () => snippet?.trim() || "No cached body content.",
    [snippet],
  );

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
      {showToggle && (
        <div
          className="flex items-center gap-1 self-start rounded border border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)] p-0.5"
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

      {activeMode === "html" && hasHtml ? (
        <MailHtmlReader
          html={html!}
          allowRemoteImages={allowRemoteImages}
          preferDark={preferDark}
          fontSize={fontSize}
          title={title}
        />
      ) : (
        <MailTextReader
          text={text ?? ""}
          preferDark={preferDark}
          fontSize={fontSize}
        />
      )}
    </div>
  );
}
