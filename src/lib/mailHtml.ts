import DOMPurify, { type Config as DomPurifyConfig } from "dompurify";

const MAIL_ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "center", "code", "del", "div",
  "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "ins", "li", "mark", "ol", "p", "pre", "q", "s", "small", "span",
  "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "u", "ul",
];

const MAIL_ALLOWED_ATTR = [
  "align", "alt", "class", "color", "colspan", "data-taomni-cid", "face",
  "height", "href", "lang", "name", "rel", "rowspan", "size", "src", "style",
  "target", "title", "width",
];

const MAIL_PURIFY_CONFIG: DomPurifyConfig = {
  ALLOWED_TAGS: MAIL_ALLOWED_TAGS,
  ALLOWED_ATTR: MAIL_ALLOWED_ATTR,
  FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target", "data-taomni-cid"],
  // Thunderbird-style: allow embedded cid:/data: images; remote http(s) stay for optional load.
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|cid|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

const SAFE_STYLE_PROPS = new Set([
  "background-color",
  "border",
  "border-collapse",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "margin-left",
  "padding",
  "text-align",
  "text-decoration",
  "text-decoration-line",
]);

const REMOTE_IMAGE_PLACEHOLDER = "[remote image blocked]";

let hooksInstalled = false;

function installMailPurifyHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLElement) {
      const style = node.getAttribute("style");
      if (style) {
        const sanitized = sanitizeInlineStyle(style);
        if (sanitized) node.setAttribute("style", sanitized);
        else node.removeAttribute("style");
      }
    }
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

function sanitizeInlineStyle(style: string): string {
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl) => {
      const colon = decl.indexOf(":");
      if (colon <= 0) return null;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).trim();
      if (!SAFE_STYLE_PROPS.has(prop) || !isSafeStyleValue(prop, value)) return null;
      return `${prop}: ${value}`;
    })
    .filter((decl): decl is string => !!decl)
    .join("; ");
}

function isSafeStyleValue(prop: string, value: string): boolean {
  const lower = value.toLowerCase();
  if (!value || /url\s*\(|expression\s*\(|javascript:|behavior:|-moz-binding|@import/.test(lower)) {
    return false;
  }
  if (prop === "text-align") return /^(left|center|right|justify)$/.test(lower);
  if (prop === "font-style") return /^(normal|italic|oblique)$/.test(lower);
  if (prop === "font-weight") return /^(normal|bold|bolder|lighter|[1-9]00)$/.test(lower);
  if (prop === "text-decoration" || prop === "text-decoration-line") {
    return /^(none|underline|line-through|overline)(\s+(underline|line-through|overline))*$/.test(lower);
  }
  if (prop === "font-family") return /^[\w\s,"'-]+$/.test(value);
  if (prop === "font-size" || prop === "margin-left") {
    return /^-?\d+(\.\d+)?(px|pt|em|rem|%)$/.test(lower);
  }
  if (prop === "padding") {
    return /^\d+(\.\d+)?(px|pt|em|rem|%)(\s+\d+(\.\d+)?(px|pt|em|rem|%)){0,3}$/.test(lower);
  }
  if (prop === "border-collapse") return /^(collapse|separate)$/.test(lower);
  if (prop === "border") {
    return /^(\d+(\.\d+)?(px|pt|em|rem)\s+)?(solid|dashed|dotted|double)\s+(#[0-9a-f]{3,8}|[a-z]+|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(\s*,\s*(0|1|0?\.\d+))?\s*\))$/.test(lower);
  }
  if (prop === "color" || prop === "background-color") return isSafeCssColor(value);
  return false;
}

function isSafeCssColor(value: string): boolean {
  const lower = value.toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(lower)) return true;
  if (/^[a-z]+$/.test(lower)) return true;
  return /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(\s*,\s*(0|1|0?\.\d+))?\s*\)$/.test(lower);
}

/** Remote content that should stay blocked until the user opts in (Thunderbird privacy model). */
export function isRemoteMailImageSrc(src: string | null | undefined): boolean {
  const value = (src ?? "").trim();
  if (!value) return false;
  if (/^(cid:|data:|blob:|file:)/i.test(value)) return false;
  return /^(https?:|\/\/)/i.test(value);
}

export function mailHtmlHasRemoteImages(html: string | null | undefined): boolean {
  const value = html?.trim();
  if (!value) return false;
  if (typeof DOMParser === "undefined") {
    return /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:|\/\/)/i.test(value);
  }
  const doc = new DOMParser().parseFromString(value, "text/html");
  return Array.from(doc.querySelectorAll("img")).some((img) => isRemoteMailImageSrc(img.getAttribute("src")));
}

/**
 * Sanitize HTML for the message reader.
 * When allowRemoteImages is false, only remote http(s) images are blocked —
 * embedded cid:/data: images remain visible (Thunderbird-aligned).
 */
export function sanitizeMailDisplayHtml(html: string, allowRemoteImages: boolean): string {
  installMailPurifyHooks();
  const sanitized = DOMPurify.sanitize(html, MAIL_PURIFY_CONFIG) as unknown as string;
  if (allowRemoteImages) return sanitized;
  if (typeof DOMParser === "undefined") {
    return sanitized.replace(/<img\b[^>]*>/gi, (tag) => {
      const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const src = srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "";
      return isRemoteMailImageSrc(src) ? REMOTE_IMAGE_PLACEHOLDER : tag;
    });
  }
  const doc = new DOMParser().parseFromString(sanitized, "text/html");
  doc.querySelectorAll("img").forEach((img) => {
    if (!isRemoteMailImageSrc(img.getAttribute("src"))) return;
    const placeholder = doc.createElement("span");
    placeholder.setAttribute("data-taomni-remote-image", "blocked");
    placeholder.className = "taomni-mail-remote-image-blocked";
    placeholder.textContent = REMOTE_IMAGE_PLACEHOLDER;
    img.replaceWith(placeholder);
  });
  return doc.body.innerHTML;
}

export function sanitizeMailComposeHtml(html: string): string {
  installMailPurifyHooks();
  const sanitized = DOMPurify.sanitize(html, MAIL_PURIFY_CONFIG) as unknown as string;
  return sanitized.trim() || "<p><br></p>";
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

function collectPlainText(node: Node): string {
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

export function buildReplyHtml(intro: string, original: { html?: string | null; text?: string | null }, signature?: string | null): string {
  const originalHtml = original.html
    ? sanitizeMailComposeHtml(original.html)
    : plainTextToMailHtml(original.text ?? "");
  return `<p><br></p>${signatureToMailHtml(signature)}<p>${escapeHtml(intro)}</p><blockquote type="cite" style="border-left: 2px solid #729fcf; margin-left: 0.8em; padding-left: 0.8em;">${originalHtml}</blockquote>`;
}

export function buildForwardHtml(headerLines: string[], original: { html?: string | null; text?: string | null }, signature?: string | null): string {
  const header = headerLines.map(escapeHtml).join("<br>");
  const originalHtml = original.html
    ? sanitizeMailComposeHtml(original.html)
    : plainTextToMailHtml(original.text ?? "");
  return `<p><br></p>${signatureToMailHtml(signature)}<p>---------- Forwarded message ----------<br>${header}</p>${originalHtml}`;
}

export function quotePlainText(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
