import { isTauriRuntime } from "../../lib/runtime";

export interface HtmlPreviewSession { url: string; token: string }

/** Only the explicit browser stub may return blob documents. Native never accepts them. */
export function browserPreviewSession(session: HtmlPreviewSession): boolean {
  return !isTauriRuntime() && /^[\w-]+$/.test(session.token) && session.url.startsWith("blob:");
}

export function validatePreviewSession(session: HtmlPreviewSession): void {
  if (browserPreviewSession(session)) { new URL(session.url); return; }
  previewRoot(session);
}
export type HtmlConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
export interface HtmlBridgeMessage {
  type: "taomni-html-preview";
  token: string;
  kind: "console" | "navigate" | "external" | "blocked";
  level?: HtmlConsoleLevel;
  message?: string;
  href?: string;
}

export function previewRoot(session: HtmlPreviewSession): URL {
  const url = new URL(session.url);
  if (url.username || url.password || !session.token || !/^[\w-]+$/.test(session.token)) throw new Error("Invalid HTML preview session");
  const protocol = url.protocol;
  if (!(protocol === "taomni-preview:" && url.hostname === "localhost") &&
    !((protocol === "http:" || protocol === "https:") && url.hostname === "taomni-preview.localhost")) throw new Error("Invalid HTML preview protocol");
  if (url.port || !url.pathname.startsWith(`/${session.token}/`)) throw new Error("Invalid HTML preview token root");
  return new URL(`/${session.token}/`, url);
}

/** Never let a forged bridge message turn the preview into an arbitrary browser or IPC client. */
export function localPreviewHref(href: string, session: HtmlPreviewSession, current = session.url): string | null {
  try {
    if (browserPreviewSession(session)) {
      const base = session.url.split("#")[0];
      const url = new URL(href, current);
      return url.href.split("#")[0] === base ? url.href : null;
    }
    const root = previewRoot(session);
    const url = new URL(href, current);
    if (url.protocol !== root.protocol || url.host !== root.host || url.username || url.password || !url.pathname.startsWith(root.pathname)) return null;
    const relative = url.pathname.slice(root.pathname.length);
    for (const segment of relative.split("/")) {
      let decoded = decodeURIComponent(segment);
      // The native protocol decodes once; reject layered traversal too, while
      // keeping ordinary percent signs in filenames (e.g. 50%25.html) valid.
      for (let pass = 0; pass < 4 && /%[\da-f]{2}/i.test(decoded); pass++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      if (decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/.test(decoded)) return null;
    }
    return url.href;
  } catch { return null; }
}

export function previewRoute(href: string, session: HtmlPreviewSession): string | null {
  const safe = localPreviewHref(href, session);
  if (safe && browserPreviewSession(session)) return new URL(safe).hash;
  return safe ? safe.slice(previewRoot(session).href.length) : null;
}

export function previewRouteUrl(route: string, session: HtmlPreviewSession): string | null {
  if (browserPreviewSession(session)) return route === "" || route.startsWith("#") ? session.url.split("#")[0] + route : null;
  return localPreviewHref(route, session, previewRoot(session).href);
}

export function externalPreviewHref(href: string): string | null {
  try {
    const url = new URL(href);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      hostname !== "localhost" && !hostname.endsWith(".localhost") && !/^127\./.test(hostname) &&
      hostname !== "[::1]" && !/^\[::ffff:7f[\da-f]{2}:/i.test(hostname) ? url.href : null;
  } catch { return null; }
}

export function readHtmlBridgeMessage(event: MessageEvent, frame: Window | null, session: HtmlPreviewSession): HtmlBridgeMessage | null {
  if (!frame || event.source !== frame || !event.data || typeof event.data !== "object") return null;
  const data = event.data as Partial<HtmlBridgeMessage>;
  if (data.type !== "taomni-html-preview" || data.token !== session.token ||
    !["console", "navigate", "external", "blocked"].includes(String(data.kind))) return null;
  if (data.href !== undefined && (typeof data.href !== "string" || data.href.length > 16384)) return null;
  if (data.message !== undefined && typeof data.message !== "string") return null;
  return { type: "taomni-html-preview", token: session.token, kind: data.kind!,
    href: data.href, message: data.message?.slice(0, 8192),
    level: ["log", "info", "warn", "error", "debug"].includes(String(data.level)) ? data.level : "log" };
}

export function htmlFileAddress(path: string, route?: string, initialRoute?: string): string {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(path);
  const normalized = windows ? path.replace(/\\/g, "/") : path;
  const slash = normalized.lastIndexOf("/");
  const relative = route?.split(/[?#]/, 1)[0];
  const initial = initialRoute?.split(/[?#]/, 1)[0];
  let displayPath = normalized;
  if (relative && relative !== initial) {
    try { displayPath = normalized.slice(0, slash + 1) + relative.split("/").map(decodeURIComponent).join("/"); }
    catch { /* Keep the original readable address on malformed percent input. */ }
  }
  if (windows && displayPath.startsWith("//")) return `file:${displayPath}`;
  return `file://${displayPath.startsWith("/") ? "" : "/"}${displayPath}`;
}

export interface HtmlHistory { entries: string[]; index: number }
export function pushHtmlHistory(history: HtmlHistory, route: string): HtmlHistory {
  if (history.entries[history.index] === route) return history;
  const entries = [...history.entries.slice(0, history.index + 1), route];
  const bounded = entries.slice(-100);
  return { entries: bounded, index: bounded.length - 1 };
}
