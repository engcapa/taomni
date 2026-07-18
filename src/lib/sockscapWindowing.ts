export const SOCKSCAP_WINDOW_HASH = "#sockscap";
export type SockscapWindowSection = "overview" | "profiles" | "rules" | "dashboard" | "lifecycle";

const SOCKSCAP_WINDOW_SECTIONS = new Set<SockscapWindowSection>([
  "overview",
  "profiles",
  "rules",
  "dashboard",
  "lifecycle",
]);

export function isSockscapWindowSection(value: unknown): value is SockscapWindowSection {
  return typeof value === "string" && SOCKSCAP_WINDOW_SECTIONS.has(value as SockscapWindowSection);
}

export function isSockscapWindowUrl(href: string): boolean {
  try {
    const url = new URL(href, "http://taomni.local/");
    return url.hash === SOCKSCAP_WINDOW_HASH
      || url.hash.startsWith(`${SOCKSCAP_WINDOW_HASH}/`)
      || url.searchParams.get("sockscap") === "1";
  } catch {
    return false;
  }
}

export function detectSockscapWindowRoute(): boolean {
  return typeof window !== "undefined" && isSockscapWindowUrl(window.location.href);
}

export function detectSockscapWindowSection(href?: string): SockscapWindowSection | null {
  const value = href ?? (typeof window !== "undefined" ? window.location.href : "");
  try {
    const url = new URL(value, "http://taomni.local/");
    const querySection = url.searchParams.get("section");
    if (isSockscapWindowSection(querySection)) return querySection;
    if (url.hash.startsWith(`${SOCKSCAP_WINDOW_HASH}/`)) {
      const hashSection = url.hash.slice(`${SOCKSCAP_WINDOW_HASH}/`.length);
      return isSockscapWindowSection(hashSection) ? hashSection : null;
    }
  } catch {
    // Invalid URLs simply use the overview.
  }
  return null;
}

/** Browser preview uses a query because `window.open` handles it reliably. */
export function sockscapBrowserWindowUrl(href: string, section?: SockscapWindowSection): string {
  const url = new URL(href);
  url.searchParams.set("sockscap", "1");
  if (section) url.searchParams.set("section", section);
  else url.searchParams.delete("section");
  url.hash = "";
  return url.toString();
}
