import { useMemo } from "react";
import DOMPurify from "dompurify";

/** Thumbnail has no author scripts, same-origin, local file or network access.
 * Full resource-enabled preview uses the separately scoped native protocol. */
export function HtmlThumbnail({ content, title }: { content: string; title: string }) {
  const html = useMemo(() => {
    const sanitized = DOMPurify.sanitize(content, { WHOLE_DOCUMENT: true, FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "link"], FORBID_ATTR: ["src", "href", "srcset", "ping", "action", "formaction"], ALLOW_DATA_ATTR: false });
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;font:13px system-ui;background:white;color:#0f172a}body{padding:12px}img{max-width:100%}</style></head><body>${sanitized}</body></html>`;
  }, [content]);
  return <div className="ex-pv-html"><iframe data-testid="explorer-preview-html" title={title} sandbox="" srcDoc={html} referrerPolicy="no-referrer" /><span>{"沙盒 / Sandbox"}</span></div>;
}
