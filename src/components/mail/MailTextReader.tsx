import { useMemo } from "react";
import {
  parseMailPlainTextLines,
  splitMailPlainTextLinks,
  type MailPlainLine,
} from "../../lib/mailPlainText";

interface MailTextReaderProps {
  text: string;
  /** Match mail chrome dark theme (Thunderbird-style plain body). */
  preferDark?: boolean;
  fontSize?: number;
  className?: string;
  /** Case-insensitive highlight query for find-in-message. */
  highlightQuery?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText({ text, query }: { text: string; query?: string }) {
  const q = query?.trim();
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, "gi"));
  return (
    <>
      {parts.map((part, index) => (
        part.toLowerCase() === q.toLowerCase()
          ? <mark key={index} className="taomni-mail-find-hit">{part}</mark>
          : <span key={index}>{part}</span>
      ))}
    </>
  );
}

function LinkedPlainText({ text, highlightQuery }: { text: string; highlightQuery?: string }) {
  const parts = useMemo(() => splitMailPlainTextLinks(text), [text]);
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "link" && part.href) {
          return (
            <a
              key={`${index}-${part.value}`}
              href={part.href}
              target="_blank"
              rel="noopener noreferrer"
              className="taomni-mail-plain-link"
            >
              <HighlightedText text={part.value} query={highlightQuery} />
            </a>
          );
        }
        return (
          <span key={`${index}-${part.value}`}>
            <HighlightedText text={part.value} query={highlightQuery} />
          </span>
        );
      })}
    </>
  );
}

function PlainLine({ line, highlightQuery }: { line: MailPlainLine; highlightQuery?: string }) {
  if (line.kind === "blank") {
    return <div className="mail-line mail-line-blank"><br /></div>;
  }
  if (line.kind === "quote") {
    return (
      <div className={`mail-line mail-quote mail-quote-${line.level}`}>
        <span className="mail-quote-mark">{line.mark}</span>
        {line.text ? <LinkedPlainText text={line.text} highlightQuery={highlightQuery} /> : null}
      </div>
    );
  }
  return (
    <div className="mail-line">
      {line.text ? <LinkedPlainText text={line.text} highlightQuery={highlightQuery} /> : <br />}
    </div>
  );
}

/**
 * Thunderbird-style plain-text body: quote-level colors, autolinks, themed paper.
 */
export function MailTextReader({
  text,
  preferDark = false,
  fontSize = 14,
  className,
  highlightQuery,
}: MailTextReaderProps) {
  const lines = useMemo(() => parseMailPlainTextLines(text), [text]);
  const size = Math.max(8, Math.min(32, fontSize));

  return (
    <div
      className={`taomni-mail-reader-paper ${preferDark ? "is-dark" : ""} ${className ?? ""}`.trim()}
      data-testid="mail-reader-paper"
      data-reader-theme={preferDark ? "dark" : "light"}
      style={{ fontSize: size }}
    >
      <div className="taomni-mail-reader-text" data-testid="mail-reader-text">
        {lines.map((line, index) => (
          <PlainLine key={index} line={line} highlightQuery={highlightQuery} />
        ))}
      </div>
    </div>
  );
}
