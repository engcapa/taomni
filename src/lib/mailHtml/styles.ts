/**
 * Presentation properties commonly used by HTML email (marketing + clients).
 * Intentionally excludes layout escape hatches (position fixed/absolute, z-index,
 * transform, filter, clip-path) and anything that can load remote resources via url().
 */
export const SAFE_STYLE_PROPS = new Set([
  "background",
  "background-color",
  "border",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-style",
  "border-top-width",
  "border-width",
  "color",
  "display",
  "box-sizing",
  "clear",
  "empty-cells",
  "float",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "overflow",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "table-layout",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-indent",
  "text-transform",
  "vertical-align",
  "visibility",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
  "word-wrap",
]);

export const LENGTH_TOKEN = /^(?:auto|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%|ex|ch|pc|in|cm|mm)?)$/i;

export const LENGTH_OR_NORMAL = /^(?:normal|auto|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%|ex|ch|pc|in|cm|mm)?)$/i;

export const BORDER_STYLE = /^(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i;

export const BORDER_WIDTH = /^(?:thin|medium|thick|0|-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)$/i;

export function normalizeLegacyPresentationalAttrs(node: HTMLElement): void {
  const bgcolor = node.getAttribute("bgcolor");
  if (bgcolor && isSafeCssColor(bgcolor.trim())) {
    const existing = node.getAttribute("style") ?? "";
    if (!/(?:^|;)\s*background-color\s*:/i.test(existing)) {
      node.setAttribute("style", appendStyle(existing, `background-color: ${bgcolor.trim()}`));
    }
  }
  const colorAttr = node.getAttribute("color");
  if (colorAttr && isSafeCssColor(colorAttr.trim()) && (node.tagName === "FONT" || node.tagName === "SPAN")) {
    const existing = node.getAttribute("style") ?? "";
    if (!/(?:^|;)\s*color\s*:/i.test(existing)) {
      node.setAttribute("style", appendStyle(existing, `color: ${colorAttr.trim()}`));
    }
  }
}

export function appendStyle(existing: string, decl: string): string {
  const base = existing.trim().replace(/;\s*$/, "");
  return base ? `${base}; ${decl}` : decl;
}

export function sanitizeInlineStyle(style: string, options?: { keepImportant?: boolean; }): string {
  const keepImportant = options?.keepImportant === true;
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl) => {
      const colon = decl.indexOf(":");
      if (colon <= 0) return null;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const rawTail = decl.slice(colon + 1).trim();
      const important = /\s*!important\s*$/i.test(rawTail);
      const rawValue = rawTail.replace(/\s*!important\s*$/i, "").trim();
      if (!SAFE_STYLE_PROPS.has(prop) || !isSafeStyleValue(prop, rawValue)) return null;
      return `${prop}: ${rawValue}${keepImportant && important ? " !important" : ""}`;
    })
    .filter((decl): decl is string => !!decl)
    .join("; ");
}

export function isSafeStyleValue(prop: string, value: string): boolean {
  const lower = value.toLowerCase();
  if (!value || /url\s*\(|expression\s*\(|javascript:|behavior:|-moz-binding|@import|attr\s*\(/i.test(lower)) {
    return false;
  }
  // Block layout escape / stacking that can overlay the app chrome.
  if (/fixed|sticky|absolute/.test(lower) && (prop === "display" || prop.includes("position"))) {
    return false;
  }

  switch (prop) {
    case "text-align":
      return /^(left|center|right|justify|start|end)$/.test(lower);
    case "font-style":
      return /^(normal|italic|oblique)$/.test(lower);
    case "font-weight":
      return /^(normal|bold|bolder|lighter|[1-9]00)$/.test(lower);
    case "font-variant":
      return /^(normal|small-caps)$/.test(lower);
    case "text-decoration":
    case "text-decoration-line":
      return /^(none|underline|line-through|overline)(\s+(underline|line-through|overline))*$/.test(lower);
    case "text-decoration-style":
      return /^(solid|double|dotted|dashed|wavy)$/.test(lower);
    case "text-decoration-color":
      return isSafeCssColor(value);
    case "text-transform":
      return /^(none|capitalize|uppercase|lowercase)$/.test(lower);
    case "font-family":
      return /^[\w\s,"'-]+$/.test(value) && value.length < 200;
    case "font-size":
    case "width":
    case "height":
    case "max-width":
    case "max-height":
    case "min-width":
    case "min-height":
    case "text-indent":
    case "letter-spacing":
    case "word-spacing":
    case "border-spacing":
      return LENGTH_OR_NORMAL.test(lower) || isMultiLength(lower, 1, 2);
    case "line-height":
      return LENGTH_OR_NORMAL.test(lower) || /^\d+(\.\d+)?$/.test(lower);
    case "margin":
    case "padding":
      return isMultiLength(lower, 1, 4);
    case "margin-left":
    case "margin-right":
    case "margin-top":
    case "margin-bottom":
    case "padding-left":
    case "padding-right":
    case "padding-top":
    case "padding-bottom":
      return LENGTH_TOKEN.test(lower);
    case "border-collapse":
      return /^(collapse|separate)$/.test(lower);
    case "border":
    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left":
      return isSafeBorderShorthand(value);
    case "border-width":
      return isMultiToken(lower, 1, 4, (t) => BORDER_WIDTH.test(t));
    case "border-style":
      return isMultiToken(lower, 1, 4, (t) => BORDER_STYLE.test(t));
    case "border-color":
      return isMultiColor(value, 1, 4);
    case "border-top-width":
    case "border-right-width":
    case "border-bottom-width":
    case "border-left-width":
      return BORDER_WIDTH.test(lower);
    case "border-top-style":
    case "border-right-style":
    case "border-bottom-style":
    case "border-left-style":
      return BORDER_STYLE.test(lower);
    case "border-top-color":
    case "border-right-color":
    case "border-bottom-color":
    case "border-left-color":
      return isSafeCssColor(value);
    case "border-radius":
      return isMultiLength(lower.replace(/\//g, " "), 1, 8);
    case "color":
    case "background-color":
      return isSafeCssColor(value);
    case "background":
      // Color-only backgrounds (no images). Marketing mail often uses this shorthand.
      return isSafeCssColor(value) || /^(transparent|none)$/.test(lower);
    case "display":
      return /^(block|inline|inline-block|inline-table|table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|table-column|table-column-group|table-caption|list-item|none|contents|flow-root)$/.test(lower);
    case "vertical-align":
      return /^(baseline|sub|super|top|text-top|middle|bottom|text-bottom|0|-?\d+(\.\d+)?(px|pt|em|rem|%))$/.test(lower);
    case "white-space":
      return /^(normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/.test(lower);
    case "word-break":
      return /^(normal|break-all|keep-all|break-word)$/.test(lower);
    case "overflow-wrap":
    case "word-wrap":
      return /^(normal|break-word|anywhere)$/.test(lower);
    case "overflow":
    case "overflow-x":
    case "overflow-y":
      return /^(visible|hidden|clip|scroll|auto)$/.test(lower);
    case "opacity":
      return /^(0|1|0?\.\d+)$/.test(lower);
    case "list-style-type":
      return /^(disc|circle|square|decimal|decimal-leading-zero|lower-roman|upper-roman|lower-alpha|upper-alpha|lower-latin|upper-latin|none)$/.test(lower);
    case "list-style-position":
      return /^(inside|outside)$/.test(lower);
    case "list-style":
      return !/url\s*\(/i.test(lower) && value.length < 80;
    case "table-layout":
      return /^(auto|fixed)$/.test(lower);
    case "empty-cells":
      return /^(show|hide)$/.test(lower);
    case "float":
      return /^(left|right|none|inline-start|inline-end)$/.test(lower);
    case "clear":
      return /^(none|left|right|both|inline-start|inline-end)$/.test(lower);
    case "box-sizing":
      return /^(border-box|content-box)$/.test(lower);
    case "visibility":
      return /^(visible|hidden|collapse)$/.test(lower);
    case "font":
      // Shorthand is hard to validate fully; allow conservative system/web-safe forms without url().
      return value.length < 120 && !/url\s*\(/i.test(lower);
    default:
      return false;
  }
}

export function isMultiLength(value: string, min: number, max: number): boolean {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < min || tokens.length > max) return false;
  return tokens.every((token) => LENGTH_TOKEN.test(token));
}

export function isMultiToken(value: string, min: number, max: number, test: (token: string) => boolean): boolean {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < min || tokens.length > max) return false;
  return tokens.every(test);
}

export function isMultiColor(value: string, min: number, max: number): boolean {
  // Split carefully enough for simple hex/named colors; rgba() with commas is a single color only.
  if (/^rgba?\(/i.test(value.trim()) || /^hsla?\(/i.test(value.trim())) {
    return min <= 1 && isSafeCssColor(value);
  }
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < min || tokens.length > max) return false;
  return tokens.every((token) => isSafeCssColor(token));
}

export function isSafeBorderShorthand(value: string): boolean {
  const lower = value.toLowerCase().trim();
  if (!lower || lower === "none" || lower === "0") return true;
  // Allow order-independent width/style/color tokens.
  // Collapse rgba() to a single token first.
  const normalized = lower
    .replace(/rgba?\([^)]+\)/g, "§color§")
    .replace(/hsla?\([^)]+\)/g, "§color§");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every((token) => {
    if (token === "§color§") return true;
    if (BORDER_WIDTH.test(token)) return true;
    if (BORDER_STYLE.test(token)) return true;
    return isSafeCssColor(token);
  });
}

export function isSafeCssColor(value: string): boolean {
  const lower = value.toLowerCase().trim();
  if (/^#[0-9a-f]{3,8}$/.test(lower)) return true;
  if (/^[a-z]+$/.test(lower)) return true;
  if (/^transparent$/i.test(lower)) return true;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(\s*,\s*(0|1|0?\.\d+))?\s*\)$/.test(lower)) return true;
  if (/^rgba?\(\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}(\s*\/\s*(0|1|0?\.\d+|\d+%))?\s*\)$/.test(lower)) return true;
  if (/^hsla?\(\s*\d{1,3}(\.\d+)?(deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(\s*,\s*(0|1|0?\.\d+))?\s*\)$/.test(lower)) return true;
  return false;
}
