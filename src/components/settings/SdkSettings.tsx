import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import {
  sdkDiscoverInstallations,
  sdkGetRegistry,
  sdkProbeInstallation,
  sdkRefreshInstallations,
  sdkRemoveInstallation,
  sdkSaveInstallation,
  sdkSetDefault,
  subscribeSdkRegistryChanged,
  type SdkInstallation,
  type SdkKind,
  type SdkProbe,
  type SdkRegistry,
} from "../../lib/editor/sdk";
import { useT } from "../../lib/i18n";
import { selectFolderPath } from "../../lib/ipc";

const SDK_KINDS: SdkKind[] = ["java", "kotlin", "scala", "python"];

const EMPTY_REGISTRY: SdkRegistry = {
  schemaVersion: 1,
  installations: [],
  defaults: [],
  bindings: [],
};

interface SdkDraft {
  id: string | null;
  kind: SdkKind;
  name: string;
  location: string;
}

function pathKey(kind: SdkKind, location: string): string {
  return `${kind}:${location.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`;
}

function kindLabel(kind: SdkKind): string {
  switch (kind) {
    case "java": return "Java / JDK";
    case "kotlin": return "Kotlin";
    case "scala": return "Scala";
    case "python": return "Python";
  }
}

function statusTone(status: SdkInstallation["status"] | SdkProbe["status"]): string {
  return status === "ready"
    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    : status === "missing"
      ? "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : "border-red-500/35 bg-red-500/10 text-red-600 dark:text-red-400";
}

export function SdkSettings() {
  const t = useT();
  const [registry, setRegistry] = useState<SdkRegistry>(EMPTY_REGISTRY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SdkDraft | null>(null);
  const [probe, setProbe] = useState<SdkProbe | null>(null);
  const [discoveries, setDiscoveries] = useState<SdkProbe[] | null>(null);

  const loadRegistry = useCallback(async () => {
    try {
      const next = await sdkGetRegistry();
      setRegistry(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRegistry();
    return subscribeSdkRegistryChanged(() => { void loadRegistry(); });
  }, [loadRegistry]);

  const registeredPaths = useMemo(
    () => new Set(registry.installations.map((sdk) => pathKey(sdk.kind, sdk.location))),
    [registry.installations],
  );
  const availableDiscoveries = useMemo(
    () => (discoveries ?? []).filter((item) => !registeredPaths.has(pathKey(item.kind, item.location))),
    [discoveries, registeredPaths],
  );

  const runMutation = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await loadRegistry();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }, [loadRegistry]);

  const openNew = (kind: SdkKind = "java") => {
    setProbe(null);
    setDraft({ id: null, kind, name: "", location: "" });
  };

  const openEdit = (installation: SdkInstallation) => {
    setProbe(null);
    setDraft({
      id: installation.id,
      kind: installation.kind,
      name: installation.name,
      location: installation.location,
    });
  };

  const browse = useCallback(async () => {
    if (!draft) return;
    try {
      const selected = await selectFolderPath(draft.location || undefined);
      if (selected) {
        setProbe(null);
        setDraft((current) => current ? { ...current, location: selected } : current);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [draft]);

  const checkDraft = useCallback(async () => {
    if (!draft?.location.trim()) return;
    setBusy("probe");
    setError(null);
    try {
      setProbe(await sdkProbeInstallation(draft.kind, draft.location.trim()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }, [draft]);

  const saveDraft = useCallback(async () => {
    if (!draft?.location.trim()) return;
    await runMutation("save", async () => {
      await sdkSaveInstallation({
        id: draft.id,
        kind: draft.kind,
        name: draft.name.trim() || null,
        location: draft.location.trim(),
        origin: "manual",
      });
      setDraft(null);
      setProbe(null);
    });
  }, [draft, runMutation]);

  const discover = useCallback(async () => {
    setBusy("discover");
    setError(null);
    try {
      setDiscoveries(await sdkDiscoverInstallations());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }, []);

  const addDiscovery = useCallback(async (candidate: SdkProbe) => {
    await runMutation(`discover:${pathKey(candidate.kind, candidate.location)}`, async () => {
      await sdkSaveInstallation({
        kind: candidate.kind,
        location: candidate.location,
        origin: "discovered",
      });
    });
  }, [runMutation]);

  const addAllDiscoveries = useCallback(async () => {
    await runMutation("discover:add-all", async () => {
      for (const candidate of availableDiscoveries) {
        await sdkSaveInstallation({
          kind: candidate.kind,
          location: candidate.location,
          origin: "discovered",
        });
      }
    });
  }, [availableDiscoveries, runMutation]);

  const remove = useCallback((installation: SdkInstallation) => {
    if (!window.confirm(t("settings.sdkRemoveConfirm", { name: installation.name }))) return;
    void runMutation(`remove:${installation.id}`, () => sdkRemoveInstallation(installation.id));
  }, [runMutation, t]);

  return (
    <section
      data-testid="sdk-settings"
      className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3"
    >
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{t("settings.sdkTitle")}</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)]">
            {t("settings.sdkSubtitle")}
          </div>
        </div>
        <button
          type="button"
          data-testid="sdk-discover"
          className="taomni-btn inline-flex h-7 items-center gap-1 px-2.5 text-[11px]"
          disabled={busy !== null}
          onClick={() => void discover()}
        >
          {busy === "discover" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          {t("settings.sdkDiscover")}
        </button>
        <button
          type="button"
          data-testid="sdk-add"
          className="taomni-btn inline-flex h-7 items-center gap-1 px-2.5 text-[11px]"
          disabled={busy !== null}
          onClick={() => openNew()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("settings.sdkAdd")}
        </button>
        <button
          type="button"
          data-testid="sdk-refresh-all"
          aria-label={t("settings.sdkRefresh")}
          title={t("settings.sdkRefresh")}
          className="taomni-btn inline-flex h-7 w-7 items-center justify-center p-0"
          disabled={busy !== null || loading}
          onClick={() => void runMutation("refresh:all", () => sdkRefreshInstallations())}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy === "refresh:all" ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div data-testid="sdk-settings-error" className="mb-2 rounded border border-red-500/35 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {draft && (
        <div data-testid="sdk-editor" className="mb-3 rounded border border-[var(--taomni-accent)]/40 bg-[var(--taomni-bg)] p-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-semibold">
              {draft.id ? t("settings.sdkEditTitle") : t("settings.sdkAddTitle")}
            </span>
            <button
              type="button"
              aria-label={t("settings.sdkCancel")}
              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]"
              onClick={() => { setDraft(null); setProbe(null); }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px_minmax(160px,1fr)]">
            <label className="text-[11px] text-[var(--taomni-text-muted)]">
              {t("settings.sdkKind")}
              <select
                data-testid="sdk-editor-kind"
                value={draft.kind}
                disabled={!!draft.id}
                className="mt-0.5 h-8 w-full rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-2 text-[12px]"
                onChange={(event) => {
                  setProbe(null);
                  setDraft((current) => current ? { ...current, kind: event.target.value as SdkKind } : current);
                }}
              >
                {SDK_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-[var(--taomni-text-muted)]">
              {t("settings.sdkName")}
              <input
                data-testid="sdk-editor-name"
                value={draft.name}
                className="taomni-input mt-0.5 h-8 w-full"
                placeholder={t("settings.sdkNamePlaceholder")}
                onChange={(event) => setDraft((current) => current ? { ...current, name: event.target.value } : current)}
              />
            </label>
          </div>
          <label className="mt-2 block text-[11px] text-[var(--taomni-text-muted)]">
            {t("settings.sdkLocation")}
            <div className="mt-0.5 flex gap-1.5">
              <input
                data-testid="sdk-editor-location"
                value={draft.location}
                className="taomni-input h-8 min-w-0 flex-1 font-mono text-[11px]"
                placeholder={t("settings.sdkLocationPlaceholder")}
                onChange={(event) => { setProbe(null); setDraft((current) => current ? { ...current, location: event.target.value } : current); }}
                onKeyDown={(event) => { if (event.key === "Enter") void saveDraft(); }}
              />
              <button type="button" data-testid="sdk-editor-browse" className="taomni-btn inline-flex h-8 items-center gap-1 px-2" onClick={() => void browse()}>
                <FolderOpen className="h-3.5 w-3.5" />
                {t("settings.sdkBrowse")}
              </button>
            </div>
          </label>
          {probe && (
            <div data-testid="sdk-editor-probe" className={`mt-2 rounded border px-2 py-1.5 text-[11px] ${statusTone(probe.status)}`}>
              <div className="flex items-center gap-1.5 font-medium">
                {probe.status === "ready" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                {kindLabel(probe.kind)} · {probe.version ?? t("settings.sdkUnknownVersion")} · {probe.status}
              </div>
              {probe.error && <div className="mt-0.5">{probe.error}</div>}
            </div>
          )}
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" data-testid="sdk-editor-probe-button" className="taomni-btn h-7 px-2.5 text-[11px]" disabled={!draft.location.trim() || busy !== null} onClick={() => void checkDraft()}>
              {busy === "probe" ? t("settings.sdkChecking") : t("settings.sdkCheck")}
            </button>
            <button type="button" data-testid="sdk-editor-save" className="taomni-btn h-7 px-2.5 text-[11px]" disabled={!draft.location.trim() || busy !== null} onClick={() => void saveDraft()}>
              {busy === "save" ? t("settings.sdkSaving") : t("settings.sdkSave")}
            </button>
          </div>
        </div>
      )}

      {discoveries && (
        <div data-testid="sdk-discovery-results" className="mb-3 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[12px] font-semibold">{t("settings.sdkDiscoveredTitle")}</span>
            <span className="text-[10px] text-[var(--taomni-text-muted)]">{availableDiscoveries.length}</span>
            {availableDiscoveries.length > 1 && (
              <button type="button" data-testid="sdk-discovery-add-all" className="taomni-btn ml-auto h-6 px-2 text-[10px]" disabled={busy !== null} onClick={() => void addAllDiscoveries()}>
                {t("settings.sdkAddAll")}
              </button>
            )}
            <button type="button" aria-label={t("settings.sdkCloseDiscoveries")} className={`${availableDiscoveries.length <= 1 ? "ml-auto" : ""} inline-flex h-6 w-6 items-center justify-center rounded`} onClick={() => setDiscoveries(null)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {availableDiscoveries.length === 0 ? (
            <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("settings.sdkNoDiscoveries")}</div>
          ) : availableDiscoveries.map((candidate) => {
            const key = pathKey(candidate.kind, candidate.location);
            return (
              <div key={key} className="mt-1.5 flex min-w-0 items-center gap-2 rounded border border-[var(--taomni-divider)] px-2 py-1.5">
                <span className="rounded bg-[var(--taomni-selected)] px-1.5 py-0.5 text-[10px] font-semibold">{kindLabel(candidate.kind)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={candidate.location}>{candidate.location}</span>
                <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">{candidate.version ?? "?"}</span>
                <button type="button" className="taomni-btn h-6 px-2 text-[10px]" disabled={busy !== null} onClick={() => void addDiscovery(candidate)}>
                  {busy === `discover:${key}` ? t("settings.sdkAdding") : t("settings.sdkAdd")}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-[11px] text-[var(--taomni-text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("settings.sdkLoading")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {SDK_KINDS.map((kind) => {
            const installations = registry.installations.filter((item) => item.kind === kind);
            const defaultId = registry.defaults.find((item) => item.kind === kind)?.sdkId ?? "";
            return (
              <div key={kind} data-testid={`sdk-kind-${kind}`} className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] p-2.5">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[12px] font-semibold">{kindLabel(kind)}</span>
                  <span className="text-[10px] text-[var(--taomni-text-muted)]">{installations.length}</span>
                  <button type="button" aria-label={`${t("settings.sdkAdd")} ${kindLabel(kind)}`} className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]" onClick={() => openNew(kind)}>
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <label className="mb-2 block text-[10px] text-[var(--taomni-text-muted)]">
                  {t("settings.sdkDefault")}
                  <select
                    data-testid={`sdk-default-${kind}`}
                    value={defaultId}
                    className="mt-0.5 h-7 w-full rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 text-[11px]"
                    disabled={busy !== null}
                    onChange={(event) => void runMutation(`default:${kind}`, () => sdkSetDefault(kind, event.target.value || null))}
                  >
                    <option value="">{t("settings.sdkNoDefault")}</option>
                    {installations.map((installation) => (
                      <option key={installation.id} value={installation.id}>{installation.name}</option>
                    ))}
                  </select>
                </label>
                {installations.length === 0 ? (
                  <div className="rounded border border-dashed border-[var(--taomni-divider)] px-2 py-3 text-center text-[11px] text-[var(--taomni-text-muted)]">
                    {t("settings.sdkEmptyKind")}
                  </div>
                ) : installations.map((installation) => (
                  <div key={installation.id} data-testid={`sdk-row-${installation.id}`} className="mt-1.5 rounded border border-[var(--taomni-divider)] px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`rounded border px-1 py-0.5 text-[9px] font-semibold uppercase ${statusTone(installation.status)}`}>
                        {installation.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={installation.name}>{installation.name}</span>
                      {defaultId === installation.id && <span className="text-[9px] font-semibold text-[var(--taomni-accent)]">{t("settings.sdkDefaultBadge")}</span>}
                      <button type="button" aria-label={`${t("settings.sdkRefresh")} ${installation.name}`} className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]" disabled={busy !== null} onClick={() => void runMutation(`refresh:${installation.id}`, () => sdkRefreshInstallations(installation.id))}>
                        <RefreshCw className={`h-3 w-3 ${busy === `refresh:${installation.id}` ? "animate-spin" : ""}`} />
                      </button>
                      <button type="button" aria-label={`${t("settings.sdkEdit")} ${installation.name}`} className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--taomni-control-hover)]" disabled={busy !== null} onClick={() => openEdit(installation)}>
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button type="button" aria-label={`${t("settings.sdkRemove")} ${installation.name}`} className="inline-flex h-6 w-6 items-center justify-center rounded text-red-500 hover:bg-red-500/10" disabled={busy !== null} onClick={() => remove(installation)}>
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-2 text-[9px] text-[var(--taomni-text-muted)]">
                      <span>{installation.version ?? t("settings.sdkUnknownVersion")}</span>
                      {installation.vendor && <span>{installation.vendor}</span>}
                      {installation.architecture && <span>{installation.architecture}</span>}
                      <span>{installation.origin}</span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-[var(--taomni-text-muted)]" title={installation.location}>{installation.location}</div>
                    {installation.lastError && <div className="mt-1 text-[9px] text-red-500">{installation.lastError}</div>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
