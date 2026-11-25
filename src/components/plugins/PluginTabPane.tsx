import { Component, createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { Tab } from "../../types";
import { useT } from "../../lib/i18n";
import { loadPluginFrontend, type PluginImporter } from "../../lib/pluginLoader";
import { createPluginFrontendApi, installPluginFrontendHost, type PluginFrontendApi, type PluginFrontendProps } from "../../lib/pluginFrontendHost";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { PluginUnavailablePane } from "./PluginUnavailablePane";

interface LoadedFrontend<Props> {
  identity: string;
  component: ComponentType<Props>;
  api: PluginFrontendApi;
}

/** An official module render failure is contained to its own tab. */
class PluginRenderBoundary extends Component<{ children: ReactNode; fallback: (error: Error) => ReactNode; onError: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}

type TabLocator = Pick<Tab, "id" | "plugin">;

export function PluginTabPane<Props extends object = Record<never, never>>({ tab, active, importer, onOpenSettings,
  componentProps, unavailableActions, className = "flex h-full min-h-0 flex-col overflow-auto",
}: {
  tab: TabLocator;
  active: boolean;
  importer?: PluginImporter<PluginFrontendProps & Props>;
  onOpenSettings?: () => void;
  componentProps?: Props;
  unavailableActions?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const state = usePluginFrontendStore();
  const slug = tab.plugin?.slug ?? "";
  const kind = tab.plugin?.kind ?? "";
  const record = state.records[slug];
  const epoch = state.epochs[slug] ?? 0;
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<LoadedFrontend<PluginFrontendProps & Props> | null>(null);
  const [failure, setFailure] = useState<{ identity: string; error: string } | null>(null);
  const available = state.status === "ready" && !state.pending.has(slug)
    && record?.lifecycle === "enabled" && Boolean(record.manifest?.entry.frontend)
    && (componentProps !== undefined || Boolean(record.manifest?.tabs.some((entry) => entry.kind === kind)));
  const identity = `${slug}/${record?.manifest?.version}/${epoch}/${retry}`;

  useEffect(() => {
    if (!available || !record?.manifest) return;
    let disposed = false;
    const isCurrent = () => {
      const current = usePluginFrontendStore.getState();
      return !disposed && current.status === "ready" && !current.pending.has(slug)
        && current.records[slug]?.lifecycle === "enabled"
        && current.records[slug]?.manifest?.version === record.manifest?.version
        && (current.epochs[slug] ?? 0) === epoch;
    };
    const api = createPluginFrontendApi(slug, isCurrent);
    void Promise.resolve().then(() => {
      installPluginFrontendHost();
      return loadPluginFrontend<PluginFrontendProps & Props>(record.manifest!, importer, `${tab.id}-${epoch}-${retry}`);
    }).then((module) => {
      if (isCurrent()) setLoaded({ identity, component: (module.default ?? module.component)!, api });
    }).catch((error) => {
      if (isCurrent()) setFailure({ identity, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { disposed = true; api.dispose(); };
  }, [available, record, slug, epoch, retry, identity, importer, tab.id]);

  const retryLoad = () => { setRetry((value) => value + 1); void state.refresh(slug); };
  const errorView = (message: string) => (
    <div data-testid="plugin-tab-error" role="alert" className="m-auto max-w-lg space-y-3 p-6 text-ui-body">
      <p className="font-semibold">{t("plugins.loadFailed")}</p>
      <p className="break-words text-[var(--taomni-text-muted)]">{message}</p>
      <button data-testid="plugin-tab-retry" className="taomni-btn px-3 py-1" onClick={retryLoad}>{t("plugins.retry")}</button>
      {unavailableActions}
    </div>
  );
  let content: ReactNode;
  if (state.status === "failed") {
    content = errorView(state.error ?? t("plugins.loadFailed"));
  } else if (state.status === "idle" || state.status === "loading" || state.pending.has(slug)) {
    content = <p data-testid="plugin-tab-loading" role="status" className="m-auto p-6 text-ui-body">{t("plugins.loading")}</p>;
  } else if (!available) {
    const reason = record?.lifecycle === "uninstalled" || !record ? "missing" : record.lifecycle !== "enabled" ? "disabled" : "unavailable";
    content = <PluginUnavailablePane reason={reason} detail={record?.reason} onOpenSettings={onOpenSettings}>
      <button data-testid="plugin-tab-retry" className="taomni-btn px-3 py-1" onClick={retryLoad}>{t("plugins.retry")}</button>
      {unavailableActions}
    </PluginUnavailablePane>;
  } else if (failure?.identity === identity) {
    content = errorView(failure.error);
  } else if (loaded?.identity === identity) {
    content = <PluginRenderBoundary key={identity} onError={loaded.api.dispose} fallback={(error) => errorView(error.message)}>
      {createElement(loaded.component, { ...componentProps as Props, tabId: tab.id, kind, active, api: loaded.api })}
    </PluginRenderBoundary>;
  } else {
    content = <p data-testid="plugin-tab-loading" role="status" className="m-auto p-6 text-ui-body">{t("plugins.loading")}</p>;
  }
  return <section data-testid="plugin-tab-panel" data-plugin-slug={slug} data-plugin-kind={kind}
    data-plugin-version={record?.manifest?.version ?? ""} className={className}>
    {content}
  </section>;
}
