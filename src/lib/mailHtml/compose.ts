import { MAIL_MARKDOWN } from "./configuration";
import { sanitizeMailComposeHtml } from "./sanitize";
import { escapeHtml } from "./escaping";

/**
 * Convert Markdown clipboard text to portable, email-safe HTML.
 *
 * This deliberately uses a mail-specific renderer rather than the chat
 * renderer: compose HTML must survive outside Taomni and use the mail
 * sanitizer/style policy as its final security boundary.
 */
export function markdownToMailHtml(markdown: string): string {
  const source = markdown.replace(/\r\n?/g, "\n");
  if (!source.trim()) return "<p><br></p>";
  const rendered = MAIL_MARKDOWN.parse(source) as string;
  const styled = addMailMarkdownStyles(rendered);
  return sanitizeMailComposeHtml(styled);
}

export function addMailMarkdownStyles(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("blockquote").forEach((node) => {
    appendNodeStyle(node, "border-left: 2px solid #729fcf; margin: 0.6em 0; padding-left: 0.85em; color: #333333;");
  });
  doc.querySelectorAll("pre").forEach((node) => {
    appendNodeStyle(node, "margin: 0.6em 0; padding: 0.65em 0.8em; overflow: auto; background: #f4f4f5; color: #1f2937; white-space: pre-wrap; word-break: break-word;");
  });
  doc.querySelectorAll("pre code").forEach((node) => {
    appendNodeStyle(node, "font-family: ui-monospace, Consolas, monospace; font-size: 0.92em;");
  });
  doc.querySelectorAll("code:not(pre code)").forEach((node) => {
    appendNodeStyle(node, "font-family: ui-monospace, Consolas, monospace; font-size: 0.92em; background: #f4f4f5; padding: 0.05em 0.35em;");
  });
  doc.querySelectorAll("table").forEach((node) => {
    appendNodeStyle(node, "border-collapse: collapse; border-spacing: 0; max-width: 100%;");
  });
  doc.querySelectorAll("th, td").forEach((node) => {
    appendNodeStyle(node, "border: 1px solid #d4d4d8; padding: 0.25em 0.5em; vertical-align: top; text-align: left;");
  });
  doc.querySelectorAll("th").forEach((node) => appendNodeStyle(node, "background: #f4f4f5; font-weight: 600;"));
  doc.querySelectorAll("hr").forEach((node) => appendNodeStyle(node, "margin: 1em 0; border: none; border-top: 1px solid #d4d4d8;"));
  return doc.body.innerHTML;
}

export function appendNodeStyle(node: Element, style: string): void {
  const existing = node.getAttribute("style")?.trim();
  node.setAttribute("style", existing ? `${existing}; ${style}` : style);
}

/** Build a compose-time inline image that previews via data URL and sends as cid: */
export function buildInlineImageHtml(opts: {
  contentId: string;
  dataUrl: string;
  alt?: string;
}): string {
  const contentId = opts.contentId.trim();
  const dataUrl = opts.dataUrl.trim();
  const alt = opts.alt?.trim() || "image";
  return `<img src="${escapeHtml(dataUrl)}" data-taomni-cid="${escapeHtml(contentId)}" alt="${escapeHtml(alt)}">`;
}

/** Rewrite compose previews (data URL + data-taomni-cid) to cid: for MIME send. */
export function prepareMailHtmlForSend(html: string): string {
  const sanitized = sanitizeMailComposeHtml(html);
  if (typeof DOMParser === "undefined") {
    return sanitized.replace(
      /<img\b([^>]*?)\bsrc=(["'])data:[^"']*\2([^>]*?)\bdata-taomni-cid=(["'])([^"']+)\4([^>]*)>/gi,
      (_full, before: string, _q1: string, mid: string, _q2: string, cid: string, after: string) =>
        `<img${before}src="cid:${cid}"${mid}${after}>`.replace(/\sdata-taomni-cid=(["'])[^"']+\1/i, ""),
    );
  }
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  doc.querySelectorAll("img[data-taomni-cid]").forEach((img) => {
    const cid = img.getAttribute("data-taomni-cid")?.trim();
    if (!cid) return;
    img.setAttribute("src", `cid:${cid}`);
    img.removeAttribute("data-taomni-cid");
  });
  return doc.body.innerHTML.trim() || "<p><br></p>";
}

export function plainTextToMailHtml(text: string): string {
  const escaped = escapeHtml(text || "");
  if (!escaped) return "<p><br></p>";
  return `<p>${escaped.replace(/\r?\n/g, "<br>")}</p>`;
}

export function mailHtmlToPlainText(html: string): string {
  const sanitized = sanitizeMailComposeHtml(html);
  if (typeof document === "undefined") {
    return sanitized.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  }
  const container = document.createElement("div");
  container.innerHTML = sanitized;
  return collectPlainText(container).replace(/\n{3,}/g, "\n\n").trim();
}

export function collectPlainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) {
    return Array.from(node.childNodes).map(collectPlainText).join("");
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  const text = Array.from(node.childNodes).map(collectPlainText).join("");
  if (tag === "li") return `* ${text.trim()}\n`;
  if (["p", "div", "blockquote", "tr", "table", "ul", "ol", "pre", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  if (tag === "td" || tag === "th") return `${text.trim()}\t`;
  return text;
}

export function hasRichMailFormatting(html: string): boolean {
  const sanitized = sanitizeMailComposeHtml(html);
  if (typeof DOMParser === "undefined") {
    return /<(b|strong|i|em|u|a|ul|ol|li|table|blockquote|font|h[1-6]|img)\b/i.test(sanitized)
      || /\sstyle=/.test(sanitized);
  }
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  return Array.from(doc.body.querySelectorAll("*")).some((node) => {
    const tag = node.tagName.toLowerCase();
    if (!["p", "div", "br", "span"].includes(tag)) return true;
    return node.hasAttribute("style") || node.hasAttribute("align");
  });
}

export function signatureToMailHtml(signature: string | null | undefined): string {
  const clean = signature?.trimEnd();
  if (!clean) return "";
  return `<p><br>-- <br>${escapeHtml(clean).replace(/\r?\n/g, "<br>")}</p>`;
}

export function buildReplyHtml(intro: string, original: { html?: string | null; text?: string | null; }, signature?: string | null): string {
  const originalHtml = original.html
    ? sanitizeMailComposeHtml(original.html)
    : plainTextToMailHtml(original.text ?? "");
  return `<p><br></p>${signatureToMailHtml(signature)}<p>${escapeHtml(intro)}</p><blockquote type="cite" style="border-left: 2px solid #729fcf; margin-left: 0.8em; padding-left: 0.8em;">${originalHtml}</blockquote>`;
}

export function buildForwardHtml(headerLines: string[], original: { html?: string | null; text?: string | null; }, signature?: string | null): string {
  const header = headerLines.map(escapeHtml).join("<br>");
  const originalHtml = original.html
    ? sanitizeMailComposeHtml(original.html)
    : plainTextToMailHtml(original.text ?? "");
  return `<p><br></p>${signatureToMailHtml(signature)}<p>---------- Forwarded message ----------<br>${header}</p>${originalHtml}`;
}

export function quotePlainText(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}
