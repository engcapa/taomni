import { marked } from "marked";
import DOMPurify, { type Config as DomPurifyConfig } from "dompurify";

export type ChatOutputFormat = "md" | "html" | "plain";

const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "code", "del", "details", "div",
  "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins",
  "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small",
  "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "u", "ul", "var",
];

const ALLOWED_ATTR = ["href", "title", "alt", "src", "class", "lang", "name", "target", "rel"];

const PURIFY_CONFIG: DomPurifyConfig = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // Block any kind of script execution surface. DOMPurify already blocks
  // <script>, on* handlers, and javascript: URLs by default; we keep the
  // explicit forbid list as defence-in-depth in case the upstream defaults
  // change between minor versions.
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "meta"],
  FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target"],
};

// Force every external link to open out-of-process (or in a blank tab in the
// dev-mode webview) and strip referrer/window.opener access. This runs after
// DOMPurify finalises each anchor.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Configure marked once. We want GFM (tables, task lists), no auto-IDs (we
// don't surface them anywhere), and a single newline = <br/> so terminal-style
// output reads naturally.
marked.use({
  gfm: true,
  breaks: true,
});

/**
 * Render a chat message body for display.
 *
 * The `format` parameter mirrors `AiConfig.chat_output_format` /
 * `ChatThread.output_format`:
 *   - "md"    → parse as GitHub-flavoured Markdown, then sanitize.
 *   - "html"  → trust the LLM produced HTML, but sanitize aggressively.
 *   - "plain" → return null so the caller renders the raw text with
 *               whitespace-pre-wrap (no DOM injection).
 *
 * Returns the sanitized HTML string, or `null` for plain text.
 */
export function renderFormatted(content: string, format: ChatOutputFormat): string | null {
  if (format === "plain") return null;
  let html: string;
  if (format === "html") {
    html = content;
  } else {
    // marked.parse can be sync or async depending on options/extensions; with
    // our options it's synchronous. Cast accordingly.
    html = marked.parse(content, { async: false }) as string;
  }
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
}
