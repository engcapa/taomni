export const SOCKSCAP_WINDOW_HASH = "#sockscap";

export function isSockscapWindowUrl(href: string): boolean {
  try {
    const url = new URL(href, "http://taomni.local/");
    return url.hash === SOCKSCAP_WINDOW_HASH || url.searchParams.get("sockscap") === "1";
  } catch {
    return false;
  }
}

export function detectSockscapWindowRoute(): boolean {
  return typeof window !== "undefined" && isSockscapWindowUrl(window.location.href);
}

/** Browser preview uses a query because `window.open` handles it reliably. */
export function sockscapBrowserWindowUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set("sockscap", "1");
  url.hash = "";
  return url.toString();
}
