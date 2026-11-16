/** Invalidation only: neither renderer messages nor event payloads grant trust. */
export const PLUGIN_REGISTRY_CHANGED = "plugin-registry-changed";
const REVISION_KEY = "taomni.plugin-registry-revision.v1";

export function signalPluginRegistryChanged(slug?: string): void {
  window.dispatchEvent(new CustomEvent(PLUGIN_REGISTRY_CHANGED, { detail: { slug } }));
  // Same-origin browser preview windows have no native event bus. This marker
  // carries no registry state and is never used as installation evidence.
  try { localStorage.setItem(REVISION_KEY, crypto.randomUUID()); } catch { /* native events remain authoritative */ }
}

export function subscribePluginRegistryChanges(listener: (slug?: string) => void): () => void {
  const onChange = (event: Event) => listener((event as CustomEvent<{ slug?: string }>).detail?.slug);
  window.addEventListener(PLUGIN_REGISTRY_CHANGED, onChange);
  const onStorage = (event: StorageEvent) => { if (event.key === REVISION_KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PLUGIN_REGISTRY_CHANGED, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
