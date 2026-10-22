import DOMPurify from "dompurify";
import { isSafeCssColor, sanitizeInlineStyle } from "./styles";
import { type MailDisplayDocument, type MailReaderRenderOptions } from "./types";
import { installMailPurifyHooks, preprocessMailHtml, isRemoteMailImageSrc, remoteImagePlaceholderLabel } from "./sanitize";
import { MAIL_PURIFY_CONFIG } from "./configuration";
import { escapeHtml } from "./escaping";

/**
 * Pull presentation hints off a full HTML document's <body> before tags are
 * stripped, so marketing mails that set body bgcolor/text keep their look.
 */
export function extractMailDocumentChrome(html: string): string {
  if (typeof DOMParser === "undefined") {
    const bg = /\bbody\b[^>]*\bbgcolor\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
    const text = /\bbody\b[^>]*\btext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
    const styleMatch = /\bbody\b[^>]*\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
    const parts: string[] = [];
    const bgColor = bg?.[1] ?? bg?.[2] ?? bg?.[3];
    const textColor = text?.[1] ?? text?.[2] ?? text?.[3];
    if (bgColor && isSafeCssColor(bgColor)) parts.push(`background-color: ${bgColor}`);
    if (textColor && isSafeCssColor(textColor)) parts.push(`color: ${textColor}`);
    if (styleMatch) {
      const sanitized = sanitizeInlineStyle(styleMatch[1] ?? styleMatch[2] ?? "");
      if (sanitized) parts.push(sanitized);
    }
    return parts.join("; ");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return "";
  const parts: string[] = [];
  const bgcolor = body.getAttribute("bgcolor");
  if (bgcolor && isSafeCssColor(bgcolor.trim())) {
    parts.push(`background-color: ${bgcolor.trim()}`);
  }
  const text = body.getAttribute("text");
  if (text && isSafeCssColor(text.trim())) {
    parts.push(`color: ${text.trim()}`);
  }
  const style = body.getAttribute("style");
  if (style) {
    const sanitized = sanitizeInlineStyle(style);
    if (sanitized) parts.push(sanitized);
  }
  // De-dupe background-color / color if both attr + style set them.
  return sanitizeInlineStyle(parts.join("; "));
}

/** Extract `<style>` blocks before DOMPurify drops them. */
export function extractMailStyleBlocks(html: string): { html: string; styles: string; } {
  if (typeof DOMParser === "undefined") {
    const styles: string[] = [];
    const stripped = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_full, css: string) => {
      styles.push(css);
      return "";
    });
    return { html: stripped, styles: styles.join("\n") };
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const styles: string[] = [];
  doc.querySelectorAll("style").forEach((node) => {
    styles.push(node.textContent ?? "");
    node.remove();
  });
  // Drop external stylesheets — never load remote CSS into the reader.
  doc.querySelectorAll('link[rel~="stylesheet"]').forEach((node) => node.remove());
  return {
    html: doc.documentElement?.outerHTML ?? html,
    styles: styles.join("\n"),
  };
}

/**
 * Sanitize email stylesheets used by class/id driven HTML mail.
 * Keeps simple rules + @media; strips @import, url(), expressions, and unsafe props.
 */
export function sanitizeMailStylesheet(css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return sanitizeCssRuleList(withoutComments).trim();
}

export function sanitizeCssRuleList(css: string): string {
  const out: string[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i]!)) i += 1;
    if (i >= n) break;

    if (css[i] === "@") {
      const headerStart = i;
      while (i < n && css[i] !== "{" && css[i] !== ";") i += 1;
      const header = css.slice(headerStart, i).trim();
      if (i < n && css[i] === ";") {
        i += 1;
        continue;
      }
      if (i >= n || css[i] !== "{") break;
      const block = readCssBraceBlock(css, i);
      i = block.end;
      if (/^@media\b/i.test(header) && isSafeMediaQuery(header)) {
        const inner = sanitizeCssRuleList(block.content);
        if (inner.trim()) out.push(`${normalizeCssWhitespace(header)}{${inner}}`);
      }
      continue;
    }

    const selectorStart = i;
    while (i < n && css[i] !== "{") {
      if (css[i] === "}" || css[i] === "@") break;
      i += 1;
    }
    if (i >= n || css[i] !== "{") {
      // Unrecoverable junk — skip one char to avoid infinite loops.
      if (i < n && css[i] !== "{") i += 1;
      continue;
    }
    const selector = css.slice(selectorStart, i).trim();
    const block = readCssBraceBlock(css, i);
    i = block.end;
    if (!isSafeCssSelector(selector)) continue;
    const decls = sanitizeInlineStyle(block.content, { keepImportant: true });
    if (!decls) continue;
    out.push(`${normalizeCssWhitespace(selector)}{${decls}}`);
  }
  return out.join("");
}

export function readCssBraceBlock(css: string, openIndex: number): { content: string; end: number; } {
  let depth = 0;
  let i = openIndex;
  for (; i < css.length; i += 1) {
    const ch = css[i]!;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return { content: css.slice(openIndex + 1, i), end: i + 1 };
      }
    }
  }
  return { content: css.slice(openIndex + 1), end: css.length };
}

export function isSafeMediaQuery(header: string): boolean {
  if (header.length > 400) return false;
  const lower = header.toLowerCase();
  if (/url\s*\(|expression|javascript:|behavior:|@import/.test(lower)) return false;
  return /^@media\b/.test(lower);
}

export function isSafeCssSelector(selector: string): boolean {
  if (!selector || selector.length > 800) return false;
  const lower = selector.toLowerCase();
  if (/expression|javascript:|behavior:|-moz-binding|@import|url\s*\(|</.test(lower)) return false;
  // Reject unbalanced quotes / brackets that often signal broken or hostile input.
  if ((selector.match(/"/g) ?? []).length % 2 !== 0) return false;
  if ((selector.match(/'/g) ?? []).length % 2 !== 0) return false;
  return true;
}

export function normalizeCssWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Full Thunderbird-style display prep: body chrome + stylesheets + sanitized body.
 */
export function prepareMailDisplayDocument(html: string, allowRemoteImages: boolean): MailDisplayDocument {
  installMailPurifyHooks();
  const preprocessed = preprocessMailHtml(html);
  const { html: withoutStyles, styles: rawStyles } = extractMailStyleBlocks(preprocessed);
  const bodyStyle = extractMailDocumentChrome(withoutStyles);
  let bodyHtml = DOMPurify.sanitize(withoutStyles, MAIL_PURIFY_CONFIG) as unknown as string;
  if (!allowRemoteImages) {
    if (typeof DOMParser === "undefined") {
      bodyHtml = bodyHtml.replace(/<img\b[^>]*>/gi, (tag) => {
        const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const src = srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "";
        const alt = altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "";
        return isRemoteMailImageSrc(src) ? remoteImagePlaceholderLabel(alt, src) : tag;
      });
    } else {
      const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
      doc.querySelectorAll("img").forEach((img) => {
        if (!isRemoteMailImageSrc(img.getAttribute("src"))) return;
        const placeholder = doc.createElement("span");
        placeholder.setAttribute("data-taomni-remote-image", "blocked");
        placeholder.className = "taomni-mail-remote-image-blocked";
        const src = img.getAttribute("src");
        const alt = img.getAttribute("alt");
        placeholder.textContent = remoteImagePlaceholderLabel(alt, src);
        if (src) placeholder.setAttribute("title", src);
        // Preserve layout footprint when width/height known so tables don't collapse as hard.
        const width = img.getAttribute("width") || img.style.width;
        const height = img.getAttribute("height") || img.style.height;
        if (width) placeholder.style.minWidth = /px|%|em|rem|pt$/i.test(width) ? width : `${width}px`;
        if (height) placeholder.style.minHeight = /px|%|em|rem|pt$/i.test(height) ? height : `${height}px`;
        img.replaceWith(placeholder);
      });
      bodyHtml = doc.body.innerHTML;
    }
  }
  return {
    bodyHtml,
    styles: sanitizeMailStylesheet(rawStyles),
    bodyStyle,
  };
}

export function normalizeReaderOptions(
  options: boolean | MailReaderRenderOptions,
): Required<Pick<MailReaderRenderOptions, "allowRemoteImages">> & MailReaderRenderOptions {
  if (typeof options === "boolean") return { allowRemoteImages: options };
  return options;
}

export function messageHasOwnBackground(bodyStyle: string): boolean {
  return /(?:^|;)\s*background(?:-color)?\s*:/i.test(bodyStyle);
}

/** Base reader chrome — light paper defaults similar to Thunderbird's message pane. */
export function buildMailReaderBaseCss(options?: {
  fontSize?: number;
  preferDark?: boolean;
  fontFamily?: string;
  forceDarkDefaults?: boolean;
}): string {
  const fontSize = Math.max(8, Math.min(32, options?.fontSize ?? 14));
  const fontFamily = options?.fontFamily?.trim()
    || `"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
  const dark = options?.forceDarkDefaults === true;
  const fg = dark ? "#e8e6e3" : "#1a1a1a";
  const bg = dark ? "#1c1b22" : "#ffffff";
  const muted = dark ? "#c4c0ba" : "#333333";
  const link = dark ? "#8ab4f8" : "#0b57d0";
  const linkVisited = dark ? "#c58af9" : "#681da8";
  const preBg = dark ? "#2b2a33" : "#f4f4f5";
  const preBorder = dark ? "#3f3e46" : "#e4e4e7";
  const hr = dark ? "#3f3e46" : "#d4d4d8";
  const quoteBorder = dark ? "#8ab4f8" : "#729fcf";
  const blockedBg = dark ? "#2b2a33" : "#fafafa";
  const blockedFg = dark ? "#a1a1aa" : "#71717a";
  const blockedBorder = dark ? "#52525b" : "#a1a1aa";

  return `
html, body { margin: 0; padding: 0; }
body {
  font-family: ${fontFamily};
  font-size: ${fontSize}px;
  line-height: 1.5;
  color: ${fg};
  background: ${bg};
  word-wrap: break-word;
  overflow-wrap: anywhere;
  padding: 16px 20px 24px;
  -webkit-text-size-adjust: 100%;
  color-scheme: ${dark ? "dark" : "light"};
}
img { max-width: 100%; height: auto; }
a { color: ${link}; }
a:visited { color: ${linkVisited}; }
p { margin: 0 0 0.75em; }
p:last-child { margin-bottom: 0; }
h1, h2, h3, h4, h5, h6 { margin: 0.9em 0 0.45em; line-height: 1.25; font-weight: 600; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.3em; }
h3 { font-size: 1.15em; }
ul, ol { margin: 0.5em 0 0.75em; padding-left: 1.5em; }
li { margin: 0.2em 0; }
blockquote {
  margin: 0.6em 0;
  padding: 0 0 0 0.85em;
  border-left: 2px solid ${quoteBorder};
  color: ${muted};
}
pre, code { font-family: ui-monospace, "Cascadia Mono", "Segoe UI Mono", Consolas, monospace; font-size: 0.92em; }
pre {
  margin: 0.6em 0;
  padding: 0.65em 0.8em;
  overflow: auto;
  background: ${preBg};
  border: 1px solid ${preBorder};
  border-radius: 4px;
  white-space: pre-wrap;
}
hr { margin: 1em 0; border: none; border-top: 1px solid ${hr}; }
table { border-collapse: collapse; border-spacing: 0; max-width: 100%; }
td, th { vertical-align: top; }
.taomni-mail-remote-image-blocked {
  display: inline-block;
  margin: 2px 0;
  padding: 3px 8px;
  border: 1px dashed ${blockedBorder};
  border-radius: 4px;
  background: ${blockedBg};
  color: ${blockedFg};
  font-size: 12px;
  line-height: 1.4;
  vertical-align: middle;
}
`.replace(/\s+/g, " ").trim();
}

/** @deprecated Use buildMailReaderBaseCss() — kept for callers expecting a constant. */
export const MAIL_READER_BASE_CSS = buildMailReaderBaseCss();

/**
 * Build a complete sandboxed document for the HTML mail reader iframe.
 * CSP + no scripts; remote images gated by allowRemoteImages.
 */
export function buildMailReaderSrcDoc(
  html: string,
  options: boolean | MailReaderRenderOptions = false,
): string {
  const opts = normalizeReaderOptions(options);
  const prepared = prepareMailDisplayDocument(html, opts.allowRemoteImages);
  const forceDarkDefaults = opts.preferDark === true && !messageHasOwnBackground(prepared.bodyStyle);
  const baseCss = buildMailReaderBaseCss({
    fontSize: opts.fontSize,
    preferDark: opts.preferDark,
    fontFamily: opts.fontFamily,
    forceDarkDefaults,
  });
  const imgSrc = opts.allowRemoteImages
    ? "img-src data: blob: cid: http: https:"
    : "img-src data: blob: cid:";
  const csp = [
    "default-src 'none'",
    imgSrc,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "font-src 'none'",
  ].join("; ");

  const styleBlocks = [
    `<style>${baseCss}</style>`,
    prepared.styles ? `<style>${prepared.styles}</style>` : "",
  ].filter(Boolean).join("");

  const bodyAttr = prepared.bodyStyle
    ? ` style="${escapeHtml(prepared.bodyStyle)}"`
    : "";

  return [
    "<!DOCTYPE html>",
    `<html lang="en"${forceDarkDefaults ? ' data-taomni-reader="dark"' : ' data-taomni-reader="light"'}>`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`,
    styleBlocks,
    "</head>",
    `<body${bodyAttr}>${prepared.bodyHtml}</body>`,
    "</html>",
  ].join("");
}

/**
 * Sanitize HTML for the message reader (fragment form, for non-iframe consumers).
 * When allowRemoteImages is false, only remote http(s) images are blocked —
 * embedded cid:/data: images remain visible (Thunderbird-aligned).
 */
export function sanitizeMailDisplayHtml(html: string, allowRemoteImages: boolean): string {
  const prepared = prepareMailDisplayDocument(html, allowRemoteImages);
  let out = prepared.bodyHtml;
  if (prepared.bodyStyle) {
    out = `<div class="taomni-mail-body-root" style="${escapeHtml(prepared.bodyStyle)}">${out}</div>`;
  }
  if (prepared.styles) {
    out = `<style>${prepared.styles}</style>${out}`;
  }
  return out;
}
