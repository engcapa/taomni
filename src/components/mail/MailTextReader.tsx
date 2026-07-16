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
}

function LinkedPlainText({ text }: { text: string }) {
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
              {part.value}
            </a>
          );
        }
        return <span key={`${index}-${part.value}`}>{part.value}</span>;
      })}
    </>
  );
}

function PlainLine({ line }: { line: MailPlainLine }) {
  if (line.kind === "blank") {
    return <div className="mail-line mail-line-blank"><br /></div>;
  }
  if (line.kind === "quote") {
    return (
      <div className={`mail-line mail-quote mail-quote-${line.level}`}>
        <span className="mail-quote-mark">{line.mark}</span>
        {line.text ? <LinkedPlainText text={line.text} /> : null}
      </div>
    );
  }
  return (
    <div className="mail-line">
      {line.text ? <LinkedPlainText text={line.text} /> : <br />}
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
          <PlainLine key={index} line={line} />
        ))}
      </div>
    </div>
  );
}
