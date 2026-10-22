import DOMPurify from "dompurify";
import { sanitizeInlineStyle, normalizeLegacyPresentationalAttrs } from "./styles";
import { MAIL_PURIFY_CONFIG } from "./configuration";

export const REMOTE_IMAGE_PLACEHOLDER = "[remote image blocked]";

export let hooksInstalled = false;

/**
 * Outlook/Word emit conditional comments and namespaced junk that breaks
 * non-Outlook renderers. Keep non-MSO branches, drop pure MSO/VML scaffolding.
 */
export function preprocessMailHtml(html: string): string {
  let out = html ?? "";
  // XML declaration / BOM-ish noise
  out = out.replace(/^\uFEFF/, "");
  out = out.replace(/<\?xml[\s\S]*?\?>/gi, "");
  // <!--[if !mso]><!--> content <!--<![endif]-->  (and variants without the inner HTML comments)
  out = out.replace(
    /<!--\s*\[if\s*!mso[^\]]*\]\s*>(?:\s*<!--\s*>)?([\s\S]*?)(?:<!--\s*)?<!\s*\[endif\]\s*-->/gi,
    "$1",
  );
  // <!--[if !IE]> content <![endif]-->
  out = out.replace(
    /<!--\s*\[if\s*!IE[^\]]*\]\s*>(?:\s*<!--\s*>)?([\s\S]*?)(?:<!--\s*)?<!\s*\[endif\]\s*-->/gi,
    "$1",
  );
  // <!--[if mso ...]> ... <![endif]-->  (MSO-only tables, VML buttons, etc.)
  out = out.replace(/<!--\s*\[if\s*mso[\s\S]*?<!\s*\[endif\]\s*-->/gi, "");
  // Remaining IE conditionals — drop entirely (content is usually duplicated)
  out = out.replace(/<!--\s*\[if[\s\S]*?<!\s*\[endif\]\s*-->/gi, "");
  // Office namespace tags (empty wrappers)
  out = out.replace(/<\/?(?:o|w|v|x):[^>]*>/gi, "");
  // Common empty Office paragraphs left behind
  out = out.replace(/<p[^>]*>\s*(?:&nbsp;|\u00a0|\s)*<\/p>/gi, (match) => {
    // Keep real empty paragraphs that may be intentional spacing — only strip o:p residue already gone
    return match;
  });
  // Drop <xml>...</xml> Word blobs
  out = out.replace(/<xml\b[^>]*>[\s\S]*?<\/xml>/gi, "");
  // Drop <style type="text/css"><!-- ... --></style> comment wrappers later handled by style extract
  return out;
}

export function remoteImagePlaceholderLabel(alt: string | null | undefined, src: string | null | undefined): string {
  const cleanAlt = (alt ?? "").trim().replace(/\s+/g, " ");
  if (cleanAlt && cleanAlt.length <= 80) return `[remote image blocked: ${cleanAlt}]`;
  try {
    if (src && /^https?:/i.test(src)) {
      const host = new URL(src).hostname;
      if (host) return `[remote image blocked · ${host}]`;
    }
  } catch {
    // ignore invalid URL
  }
  return REMOTE_IMAGE_PLACEHOLDER;
}

export function installMailPurifyHooks(): void {
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
      // Normalize legacy presentational attributes that browsers still honor for mail.
      normalizeLegacyPresentationalAttrs(node);
    }
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
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

export function sanitizeMailComposeHtml(html: string): string {
  installMailPurifyHooks();
  const sanitized = DOMPurify.sanitize(html, MAIL_PURIFY_CONFIG) as unknown as string;
  return sanitized.trim() || "<p><br></p>";
}
