import { Marked } from "marked";
import { type Config as DomPurifyConfig } from "dompurify";

export const MAIL_ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "del", "div", "em", "font", "h1", "h2", "h3", "h4", "h5",
  "h6", "hr", "i", "img", "ins", "li", "mark", "ol", "p", "pre", "q", "s",
  "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul",
];

export const MAIL_ALLOWED_ATTR = [
  "align", "alt", "axis", "bgcolor", "border", "cellpadding", "cellspacing",
  "class", "color", "colspan", "data-taomni-cid", "dir", "face", "frame",
  "headers", "height", "href", "lang", "name", "nowrap", "rel", "role",
  "rowspan", "rules", "scope", "size", "span", "src", "style", "summary",
  "target", "title", "type", "valign", "width",
];

export const MAIL_MARKDOWN = new Marked({
  gfm: true,
  breaks: true,
});

export const MAIL_PURIFY_CONFIG: DomPurifyConfig = {
  ALLOWED_TAGS: MAIL_ALLOWED_TAGS,
  ALLOWED_ATTR: MAIL_ALLOWED_ATTR,
  FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta", "base", "form", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onmouseenter", "onmouseleave"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target", "data-taomni-cid"],
  // Thunderbird-style: allow embedded cid:/data: images; remote http(s) stay for optional load.
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|cid|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};
