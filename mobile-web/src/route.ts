import { useCallback, useEffect, useState } from "react";

// Hash routes, so a reload, the phone's back gesture and links from Feishu land
// on the same view. `#/session/<id>` is the deep link format the instance sends;
// it carries no instance, which is resolved against the paired instances.
export type Route =
  | { view: "instances" }
  | { view: "pair"; sessionId?: string }
  | { view: "instance"; instanceId: string; sessionId?: string }
  | { view: "link"; sessionId: string };

const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return null; } };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "pair") {
    const sessionId = parts[1] ? decode(parts[1]) : undefined;
    return sessionId ? { view: "pair", sessionId } : { view: "pair" };
  }
  if (parts[0] === "session" && parts[1]) {
    const sessionId = decode(parts[1]);
    if (sessionId) return { view: "link", sessionId };
  }
  if (parts[0] === "i" && parts[1]) {
    const instanceId = decode(parts[1]);
    const sessionId = parts[2] === "s" && parts[3] ? decode(parts[3]) : undefined;
    if (instanceId && sessionId !== null) return sessionId ? { view: "instance", instanceId, sessionId } : { view: "instance", instanceId };
  }
  return { view: "instances" };
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case "pair": return `#/pair${route.sessionId ? `/${encodeURIComponent(route.sessionId)}` : ""}`;
    case "link": return `#/session/${encodeURIComponent(route.sessionId)}`;
    case "instance": return `#/i/${encodeURIComponent(route.instanceId)}${route.sessionId ? `/s/${encodeURIComponent(route.sessionId)}` : ""}`;
    default: return "#/";
  }
}

/** Route ancestry, not just a numeric depth: pairing and deep links skip views. */
const trail = (): string[] => {
  const value = (history.state as { taomniTrail?: unknown } | null)?.taomniTrail;
  return Array.isArray(value) ? value.filter((hash): hash is string => typeof hash === "string").slice(-32) : [];
};

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(location.hash));
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("hashchange", sync); };
  }, []);
  const navigate = useCallback((next: Route, mode: "push" | "replace" = "push") => {
    const hash = routeHash(next);
    try {
      if (mode === "push") history.pushState({ taomniTrail: [...trail(), location.hash || "#/"].slice(-32) }, "", hash);
      else history.replaceState({ taomniTrail: trail() }, "", hash);
    } catch { /* sandboxed previews can refuse history writes; the view still changes */ }
    setRoute(next);
  }, []);
  /** Back to the requested parent if it is in this app's history, otherwise replace. */
  const back = useCallback((fallback: Route) => {
    const ancestry = trail();
    const target = routeHash(fallback);
    const index = ancestry.lastIndexOf(target);
    if (index >= 0) history.go(index - ancestry.length);
    else navigate(fallback, "replace");
  }, [navigate]);
  return { route, navigate, back };
}
