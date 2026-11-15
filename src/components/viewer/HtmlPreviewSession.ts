import { useEffect, useMemo, useState } from "react";
import { viewerHtmlClose, viewerHtmlOpen, type ViewerHtmlNetworkOptions } from "../../lib/viewer";
import { validatePreviewSession, type HtmlPreviewSession } from "./HtmlPreviewBridge";

/** Tokens belong to this mounted tab, not to a transient iframe or source-mode subtree. */
export function useHtmlPreviewSession(options: {
  path: string; savedHash: string; mtime: number; allowNetwork: boolean; allowScripts: boolean; visible: boolean;
  proxyMode: ViewerHtmlNetworkOptions["proxyMode"]; customProxy?: ViewerHtmlNetworkOptions["customProxy"];
}) {
  const { path, savedHash, mtime, allowNetwork, allowScripts, visible, proxyMode = "app", customProxy } = options;
  // Preferences may be replaced for unrelated editor settings or reconstructed
  // with a new object identity. Only the selected proxy's actual fields own a token.
  const networkSignature = JSON.stringify({ proxyMode, ...(proxyMode === "custom" && customProxy ? { customProxy: {
    enabled: customProxy.enabled, mode: customProxy.mode, session_id: customProxy.session_id,
    kind: customProxy.kind, host: customProxy.host, port: customProxy.port,
    username: customProxy.username, password_ref: customProxy.password_ref,
  } } : {}) });
  const network = useMemo(() => JSON.parse(networkSignature) as ViewerHtmlNetworkOptions, [networkSignature]);
  const [activated, setActivated] = useState(visible);
  const [session, setSession] = useState<HtmlPreviewSession & { allowNetwork: boolean; proxyMode: ViewerHtmlNetworkOptions["proxyMode"] }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => { if (visible) setActivated(true); }, [visible]);
  useEffect(() => {
    if (!activated) return;
    let stale = false;
    let ownedToken: string | undefined;
    setSession(undefined); setError(""); setLoading(true);
    void viewerHtmlOpen(path, allowNetwork, allowScripts, network).then((result) => {
      ownedToken = result.token;
      if (stale) { void viewerHtmlClose(result.token).catch(() => undefined); return; }
      validatePreviewSession(result);
      setSession({ ...result, allowNetwork, proxyMode: network.proxyMode });
    }).catch((cause) => { if (!stale) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => {
      stale = true;
      if (ownedToken) void viewerHtmlClose(ownedToken).catch(() => undefined);
    };
  }, [path, savedHash, mtime, allowNetwork, allowScripts, activated, generation, network]);
  return { session, error, loading, refresh: () => setGeneration((value) => value + 1) };
}
