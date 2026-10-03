/**
 * Thunderbird-style plain-text mail formatting: quote levels, autolinks, safe HTML.
 */

export type MailPlainLine =
  | { kind: "blank" }
  | { kind: "text"; text: string }
  | { kind: "quote"; level: number; mark: string; text: string };

const URL_RE = /((?:https?|ftp):\/\/[^\s<>"'{}|\\^`[\]]+|(?:mailto:)?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

/** Parse plain text into display lines with quote depth (Thunderbird-style). */
export function parseMailPlainTextLines(text: string): MailPlainLine[] {
  const normalized = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return [{ kind: "blank" }];
  return normalized.split("\n").map((raw) => {
    if (raw.length === 0) return { kind: "blank" as const };
    // Classic `>` quoting, optionally with spaces after each marker: "> > text"
    const plainQuote = /^(?:>[ \t]?)+/.exec(raw);
    if (plainQuote) {
      const mark = plainQuote[0];
      const level = Math.min(5, (mark.match(/>/g) ?? []).length);
      return {
        kind: "quote" as const,
        level,
        mark,
        text: raw.slice(mark.length),
      };
    }
    return { kind: "text" as const, text: raw };
  });
}

/** Split a line into text / link segments for safe React rendering. */
export function splitMailPlainTextLinks(text: string): Array<{ type: "text" | "link"; value: string; href?: string }> {
  if (!text) return [{ type: "text", value: "" }];
  const parts: Array<{ type: "text" | "link"; value: string; href?: string }> = [];
  let last = 0;
  const re = new RegExp(URL_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ type: "text", value: text.slice(last, match.index) });
    }
    const value = match[0];
    // Trim trailing punctuation commonly glued to URLs.
    let url = value;
    let trailing = "";
    while (/[.,);:\]]$/.test(url) && url.length > 1) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    const href = /^mailto:/i.test(url) || url.includes("@") && !/^https?:/i.test(url)
      ? (url.startsWith("mailto:") ? url : `mailto:${url}`)
      : url;
    parts.push({ type: "link", value: url, href });
    if (trailing) parts.push({ type: "text", value: trailing });
    last = match.index + value.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  if (parts.length === 0) parts.push({ type: "text", value: text });
  return parts;
}

export function escapeMailPlainText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML fragment for plain-text body (used by print / fallbacks). */
export function formatMailPlainTextHtml(text: string): string {
  return parseMailPlainTextLines(text).map((line) => {
    if (line.kind === "blank") return '<div class="mail-line mail-line-blank"><br></div>';
    if (line.kind === "quote") {
      const body = autolinkHtml(escapeMailPlainText(line.text));
      return `<div class="mail-line mail-quote mail-quote-${line.level}"><span class="mail-quote-mark">${escapeMailPlainText(line.mark)}</span>${body || "<br>"}</div>`;
    }
    const body = autolinkHtml(escapeMailPlainText(line.text));
    return `<div class="mail-line">${body || "<br>"}</div>`;
  }).join("");
}

function autolinkHtml(escaped: string): string {
  // Operate on already-escaped text; only wrap safe URL-looking spans.
  return escaped.replace(URL_RE, (raw) => {
    let url = raw;
    let trailing = "";
    while (/[.,);:\]]$/.test(url) && url.length > 1) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    const href = /^mailto:/i.test(url) || (url.includes("@") && !/^https?:/i.test(url))
      ? (url.startsWith("mailto:") ? url : `mailto:${url}`)
      : url;
    // href is from escaped text so &amp; etc. are already entities — rebuild carefully.
    const plainHref = href
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"");
    const safeHref = escapeMailPlainText(plainHref);
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${url}</a>${trailing}`;
  });
}
