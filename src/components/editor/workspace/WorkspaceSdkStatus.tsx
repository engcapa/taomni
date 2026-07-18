import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  RefreshCw,
  Wrench,
  X,
} from "lucide-react";
import {
  sdkGetRegistry,
  sdkRemoveWorkspaceBinding,
  sdkResolveWorkspace,
  sdkSaveWorkspaceBinding,
  subscribeSdkRegistryChanged,
  type ProjectSdkProfile,
  type ResolvedSdk,
  type ResolvedSdkSource,
  type ResolvedSdkStatus,
  type SdkInstallation,
  type SdkKind,
  type SdkRegistry,
  type SdkRole,
  type WorkspaceSdkBinding,
  type WorkspaceSdkResolution,
} from "../../../lib/editor/sdk";
import { useT, type TranslateFn } from "../../../lib/i18n";
import { openSettingsSection } from "../../../lib/settingsNavigation";
import type { CodeWorkspaceRootInfo } from "../../../types";

const EMPTY_REGISTRY: SdkRegistry = {
  schemaVersion: 1,
  installations: [],
  defaults: [],
  bindings: [],
};

interface RootSdkState {
  root: CodeWorkspaceRootInfo;
  resolution: WorkspaceSdkResolution | null;
  error: string | null;
}

interface WorkspaceSdkStatusProps {
  roots: CodeWorkspaceRootInfo[];
}

function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function pathIsWithin(path: string, ancestor: string): boolean {
  const child = normalizedPath(path);
  const parent = normalizedPath(ancestor);
  return child === parent || child.startsWith(`${parent}/`);
}

function nearestManualBinding(
  registry: SdkRegistry,
  scopePath: string,
  kind: SdkKind,
  role: SdkRole,
): WorkspaceSdkBinding | null {
  return registry.bindings
    .filter((binding) => (
      binding.mode === "manual"
      && binding.kind === kind
      && binding.role === role
      && pathIsWithin(scopePath, binding.scopePath)
    ))
    .sort((left, right) => right.scopePath.length - left.scopePath.length)[0] ?? null;
}

function kindLabel(kind: SdkKind): string {
  switch (kind) {
    case "java": return "Java / JDK";
    case "kotlin": return "Kotlin";
    case "scala": return "Scala";
    case "python": return "Python";
  }
}

function roleLabel(role: SdkRole, t: TranslateFn): string {
  switch (role) {
    case "project": return t("settings.workspaceSdkRoleProject");
    case "launcher": return t("settings.workspaceSdkRoleLauncher");
    case "tooling": return t("settings.workspaceSdkRoleTooling");
    case "compiler": return t("settings.workspaceSdkRoleCompiler");
  }
}

function statusLabel(status: ResolvedSdkStatus, t: TranslateFn): string {
  return t(`settings.workspaceSdkStatus${status[0]!.toUpperCase()}${status.slice(1)}`);
}

function sourceLabel(source: ResolvedSdkSource, t: TranslateFn): string {
  switch (source) {
    case "manualBinding": return t("settings.workspaceSdkSourceManual");
    case "projectLocation": return t("settings.workspaceSdkSourceProject");
    case "autoMatch": return t("settings.workspaceSdkSourceAuto");
    case "default": return t("settings.workspaceSdkSourceDefault");
    case "buildManaged": return t("settings.workspaceSdkSourceBuild");
    case "unresolved": return t("settings.workspaceSdkSourceUnresolved");
  }
}

function statusTone(status: ResolvedSdkStatus): string {
  if (status === "resolved" || status === "managed") {
    return "border-emerald-500/35 bg-emerald-500/10 text-emerald-500";
  }
  if (status === "missing" || status === "unresolved") {
    return "border-amber-500/35 bg-amber-500/10 text-amber-500";
  }
  return "border-red-500/35 bg-red-500/10 text-red-500";
}

function javaMajor(version: string | null): number | null {
  if (!version) return null;
  const numbers = version.match(/\d+/g)?.map(Number) ?? [];
  if (numbers.length === 0) return null;
  return numbers[0] === 1 ? numbers[1] ?? 1 : numbers[0]!;
}

function automaticToolingJava(registry: SdkRegistry): SdkInstallation | null {
  const defaultId = registry.defaults.find((entry) => entry.kind === "java")?.sdkId ?? null;
  return registry.installations
    .filter((sdk) => sdk.kind === "java" && sdk.status === "ready" && (javaMajor(sdk.version) ?? 0) >= 21)
    .sort((left, right) => {
      const defaultOrder = Number(right.id === defaultId) - Number(left.id === defaultId);
      if (defaultOrder !== 0) return defaultOrder;
      const versionOrder = (javaMajor(right.version) ?? 0) - (javaMajor(left.version) ?? 0);
      return versionOrder || left.name.localeCompare(right.name);
    })[0] ?? null;
}

function toolingJavaStatus(registry: SdkRegistry, scopePath: string): ResolvedSdkStatus {
  const binding = nearestManualBinding(registry, scopePath, "java", "tooling");
  const selected = binding
    ? registry.installations.find((sdk) => sdk.id === binding.sdkId) ?? null
    : automaticToolingJava(registry);
  if (!selected) return "unresolved";
  if (selected.status !== "ready") return selected.status;
  return (javaMajor(selected.version) ?? 0) >= 21 ? "resolved" : "incompatible";
}

function installationOptionLabel(installation: SdkInstallation, t: TranslateFn): string {
  const version = installation.version ?? t("settings.workspaceSdkVersionUnknown");
  return `${installation.name} · ${version} · ${installation.status}`;
}

function profileTestId(scopePath: string): string {
  let hash = 0;
  for (const char of normalizedPath(scopePath)) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

interface BindingRowProps {
  registry: SdkRegistry;
  resolved: ResolvedSdk;
  rootId: string;
  busyKey: string | null;
  onBindingChange: (
    key: string,
    scopePath: string,
    kind: SdkKind,
    role: SdkRole,
    sdkId: string,
  ) => void;
  t: TranslateFn;
}

function BindingRow({ registry, resolved, rootId, busyKey, onBindingChange, t }: BindingRowProps) {
  const { requirement } = resolved;
  const binding = nearestManualBinding(registry, resolved.scopePath, resolved.kind, resolved.role);
  const key = `${resolved.scopePath}:${resolved.kind}:${resolved.role}`;
  const candidates = registry.installations.filter((sdk) => sdk.kind === resolved.kind);
  const selectedId = binding?.sdkId ?? "";
  const selectedIsMissing = !!selectedId && !candidates.some((sdk) => sdk.id === selectedId);
  const automaticName = resolved.source !== "manualBinding" ? resolved.installation?.name : null;
  const constraint = requirement.constraint?.raw || t("settings.workspaceSdkAnyVersion");

  return (
    <div className="rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold text-[var(--taomni-code-text)]">
          {kindLabel(resolved.kind)} · {roleLabel(resolved.role, t)}
        </span>
        <span className="rounded bg-[var(--taomni-code-active-line-bg)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--taomni-code-muted)]">
          {constraint}
        </span>
        <span className={`ml-auto rounded border px-1.5 py-0.5 text-[9px] font-semibold ${statusTone(resolved.status)}`}>
          {statusLabel(resolved.status, t)}
        </span>
      </div>

      <div className="mt-1.5 grid gap-1.5 md:grid-cols-[minmax(180px,280px)_1fr]">
        <label className="relative block">
          <span className="sr-only">{kindLabel(resolved.kind)} {roleLabel(resolved.role, t)}</span>
          <select
            data-testid={`workspace-sdk-binding-${rootId}-${profileTestId(resolved.scopePath)}-${resolved.kind}-${resolved.role}`}
            className="h-7 w-full appearance-none rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 pr-7 text-[10px] text-[var(--taomni-code-text)] disabled:opacity-60"
            value={requirement.managedByBuild ? "" : selectedId}
            disabled={requirement.managedByBuild || busyKey !== null}
            onChange={(event) => onBindingChange(
              key,
              resolved.scopePath,
              resolved.kind,
              resolved.role,
              event.target.value,
            )}
          >
            <option value="">
              {requirement.managedByBuild
                ? t("settings.workspaceSdkManagedByBuild")
                : `${t("settings.workspaceSdkAutomatic")}${automaticName ? ` · ${automaticName}` : ""}`}
            </option>
            {selectedIsMissing && (
              <option value={selectedId}>{t("settings.workspaceSdkRemovedInstallation")}</option>
            )}
            {candidates.map((installation) => (
              <option key={installation.id} value={installation.id}>
                {installationOptionLabel(installation, t)}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1.5 h-3.5 w-3.5 text-[var(--taomni-code-muted)]" />
        </label>
        <div className="min-w-0 text-[9px] leading-4 text-[var(--taomni-code-muted)]">
          <span className="font-medium text-[var(--taomni-code-text)]">{sourceLabel(resolved.source, t)}</span>
          {` · ${resolved.reason}`}
          {binding && normalizedPath(binding.scopePath) !== normalizedPath(resolved.scopePath) && (
            <div className="truncate" title={binding.scopePath}>
              {t("settings.workspaceSdkInherited", { scope: binding.scopePath })}
            </div>
          )}
        </div>
      </div>

      {requirement.evidence.length > 0 && (
        <details className="mt-1.5 text-[9px] text-[var(--taomni-code-muted)]">
          <summary className="cursor-pointer select-none">{t("settings.workspaceSdkEvidence", { count: requirement.evidence.length })}</summary>
          <ul className="mt-1 space-y-1 border-l border-[var(--taomni-code-border)] pl-2">
            {requirement.evidence.map((evidence, index) => (
              <li key={`${evidence.sourcePath}:${evidence.key}:${index}`}>
                <span className="font-mono text-[var(--taomni-code-text)]">{evidence.sourcePath}</span>
                {` · ${evidence.key}=${evidence.value} · ${evidence.confidence}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

interface ToolingJavaRowProps {
  registry: SdkRegistry;
  scopePath: string;
  rootId: string;
  busyKey: string | null;
  onBindingChange: BindingRowProps["onBindingChange"];
  t: TranslateFn;
}

function ToolingJavaRow({ registry, scopePath, rootId, busyKey, onBindingChange, t }: ToolingJavaRowProps) {
  const binding = nearestManualBinding(registry, scopePath, "java", "tooling");
  const candidates = registry.installations.filter((sdk) => sdk.kind === "java");
  const automatic = automaticToolingJava(registry);
  const selectedId = binding?.sdkId ?? "";
  const status = toolingJavaStatus(registry, scopePath);
  const key = `${scopePath}:java:tooling`;

  return (
    <div className="rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold text-[var(--taomni-code-text)]">
          Java / JDK · {roleLabel("tooling", t)}
        </span>
        <span className="rounded bg-[var(--taomni-code-active-line-bg)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--taomni-code-muted)]">JDK 21+</span>
        <span className={`ml-auto rounded border px-1.5 py-0.5 text-[9px] font-semibold ${statusTone(status)}`}>
          {statusLabel(status, t)}
        </span>
      </div>
      <div className="mt-1.5 grid gap-1.5 md:grid-cols-[minmax(180px,280px)_1fr]">
        <label className="relative block">
          <span className="sr-only">Java / JDK {roleLabel("tooling", t)}</span>
          <select
            data-testid={`workspace-sdk-binding-${rootId}-${profileTestId(scopePath)}-java-tooling`}
            className="h-7 w-full appearance-none rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 pr-7 text-[10px] text-[var(--taomni-code-text)] disabled:opacity-60"
            value={selectedId}
            disabled={busyKey !== null}
            onChange={(event) => onBindingChange(key, scopePath, "java", "tooling", event.target.value)}
          >
            <option value="">
              {t("settings.workspaceSdkAutomatic")}{automatic ? ` · ${automatic.name}` : ""}
            </option>
            {!!selectedId && !candidates.some((sdk) => sdk.id === selectedId) && (
              <option value={selectedId}>{t("settings.workspaceSdkRemovedInstallation")}</option>
            )}
            {candidates.map((installation) => (
              <option key={installation.id} value={installation.id}>
                {installationOptionLabel(installation, t)}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1.5 h-3.5 w-3.5 text-[var(--taomni-code-muted)]" />
        </label>
        <div className="text-[9px] leading-4 text-[var(--taomni-code-muted)]">
          {t("settings.workspaceSdkToolingHint")}
          {binding && normalizedPath(binding.scopePath) !== normalizedPath(scopePath) && (
            <div className="truncate" title={binding.scopePath}>
              {t("settings.workspaceSdkInherited", { scope: binding.scopePath })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KotlinProfileDetails({ profile, t }: { profile: ProjectSdkProfile; t: TranslateFn }) {
  const kotlin = profile.kotlin;
  if (!kotlin) return null;
  const fields = [
    [t("settings.workspaceSdkPlatform"), kotlin.platform],
    [t("settings.workspaceSdkCompilerMode"), kotlin.compilerMode === "buildManaged"
      ? t("settings.workspaceSdkBuildManaged")
      : t("settings.workspaceSdkStandalone")],
    [t("settings.workspaceSdkCompilerVersion"), kotlin.compilerVersion],
    [t("settings.workspaceSdkLanguageVersion"), kotlin.languageVersion],
    [t("settings.workspaceSdkApiVersion"), kotlin.apiVersion],
    [t("settings.workspaceSdkJvmTarget"), kotlin.jvmTarget],
    [t("settings.workspaceSdkJavaToolchain"), kotlin.javaToolchain],
    [t("settings.workspaceSdkGradleLauncher"), kotlin.gradleLauncherJavaHome],
  ];
  return (
    <div data-testid={`workspace-kotlin-profile-${profileTestId(profile.scopePath)}`} className="mt-2 rounded border border-violet-500/25 bg-violet-500/5 p-2">
      <div className="mb-1.5 text-[10px] font-semibold text-violet-400">
        {t("settings.workspaceSdkKotlinTitle")}
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[9px] sm:grid-cols-2 xl:grid-cols-4">
        {fields.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[var(--taomni-code-muted)]">{label}</dt>
            <dd className="truncate font-mono text-[var(--taomni-code-text)]" title={value ?? undefined}>
              {value || t("settings.workspaceSdkNotSpecified")}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function WorkspaceSdkStatus({ roots }: WorkspaceSdkStatusProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [registry, setRegistry] = useState<SdkRegistry>(EMPTY_REGISTRY);
  const [rootStates, setRootStates] = useState<RootSdkState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    try {
      const nextRegistry = await sdkGetRegistry();
      const nextRootStates = await Promise.all(roots.map(async (root): Promise<RootSdkState> => {
        try {
          return { root, resolution: await sdkResolveWorkspace(root.path), error: null };
        } catch (reason) {
          return {
            root,
            resolution: null,
            error: reason instanceof Error ? reason.message : String(reason),
          };
        }
      }));
      if (requestRef.current !== request) return;
      setRegistry(nextRegistry);
      setRootStates(nextRootStates);
      setError(null);
    } catch (reason) {
      if (requestRef.current !== request) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setRootStates(roots.map((root) => ({ root, resolution: null, error: null })));
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [roots]);

  useEffect(() => {
    void load();
    return subscribeSdkRegistryChanged(() => { void load(); });
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const issueCount = useMemo(() => rootStates.reduce((count, state) => {
    if (state.error) return count + 1;
    if (!state.resolution) return count;
    const resolutionIssues = state.resolution.resolved.filter(
      (resolved) => resolved.status !== "resolved" && resolved.status !== "managed",
    ).length;
    const toolingIssues = state.resolution.analysis.profiles.filter((profile) => (
      profile.languages.includes("java")
      && toolingJavaStatus(registry, profile.scopePath) !== "resolved"
    )).length;
    return count + resolutionIssues + toolingIssues + state.resolution.analysis.warnings.length;
  }, error ? 1 : 0), [error, registry, rootStates]);

  const changeBinding = useCallback(async (
    key: string,
    scopePath: string,
    kind: SdkKind,
    role: SdkRole,
    sdkId: string,
  ) => {
    setBusyKey(key);
    setError(null);
    try {
      if (sdkId) {
        await sdkSaveWorkspaceBinding({ scopePath, kind, role, mode: "manual", sdkId });
      } else {
        const binding = nearestManualBinding(registry, scopePath, kind, role);
        if (binding) await sdkRemoveWorkspaceBinding(binding.scopePath, kind, role);
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyKey(null);
    }
  }, [load, registry]);

  const buttonText = loading
    ? t("settings.workspaceSdkButton")
    : issueCount > 0
      ? t("settings.workspaceSdkIssues", { count: issueCount })
      : t("settings.workspaceSdkReady");

  return (
    <>
      <button
        type="button"
        data-testid="code-workspace-sdk-status"
        aria-label={t("settings.workspaceSdkTitle")}
        title={t("settings.workspaceSdkTitle")}
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded border px-2 text-[10px] ${
          issueCount > 0
            ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
            : "border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[var(--taomni-code-muted)]"
        }`}
        onClick={() => setOpen(true)}
      >
        {loading
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : issueCount > 0
            ? <AlertTriangle className="h-3 w-3" />
            : <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
        {buttonText}
      </button>

      {open && (
        <div
          data-testid="workspace-sdk-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-sdk-dialog-title"
            className="flex h-[min(780px,92vh)] w-[min(1080px,96vw)] flex-col overflow-hidden rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3 py-2">
              <Wrench className="h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
              <div className="min-w-0 flex-1">
                <h2 id="workspace-sdk-dialog-title" className="text-[12px] font-semibold text-[var(--taomni-code-text)]">
                  {t("settings.workspaceSdkTitle")}
                </h2>
                <div className="text-[9px] text-[var(--taomni-code-muted)]">
                  {t("settings.workspaceSdkSubtitle")}
                </div>
              </div>
              <button
                type="button"
                data-testid="workspace-sdk-refresh"
                aria-label={t("settings.workspaceSdkRefresh")}
                title={t("settings.workspaceSdkRefresh")}
                disabled={loading || busyKey !== null}
                className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-50"
                onClick={() => void load()}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button
                type="button"
                data-testid="workspace-sdk-open-settings"
                className="inline-flex h-7 items-center gap-1 rounded px-2 text-[10px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={() => openSettingsSection("sdks")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t("settings.workspaceSdkOpenSettings")}
              </button>
              <button
                type="button"
                aria-label={t("settings.workspaceSdkClose")}
                className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-auto p-3">
              {error && (
                <div data-testid="workspace-sdk-error" className="mb-2 rounded border border-red-500/35 bg-red-500/10 px-2.5 py-2 text-[10px] text-red-400">
                  {error}
                </div>
              )}
              {loading && rootStates.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-12 text-[11px] text-[var(--taomni-code-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("settings.workspaceSdkLoading")}
                </div>
              ) : roots.length === 0 ? (
                <div className="py-12 text-center text-[11px] text-[var(--taomni-code-muted)]">
                  {t("settings.workspaceSdkNoRoots")}
                </div>
              ) : (
                <div className="space-y-3">
                  {rootStates.map(({ root, resolution, error: rootError }) => (
                    <article key={root.id} data-testid={`workspace-sdk-root-${root.id}`} className="rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/30 p-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[11px] font-semibold text-[var(--taomni-code-text)]">{root.name}</h3>
                          <div className="truncate font-mono text-[9px] text-[var(--taomni-code-muted)]" title={root.path}>{root.path}</div>
                        </div>
                        {resolution && (
                          <span className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[9px] text-[var(--taomni-code-muted)]">
                            {t("settings.workspaceSdkProfiles", { count: resolution.analysis.profiles.length })}
                          </span>
                        )}
                      </div>

                      {rootError && (
                        <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[9px] text-red-400">
                          {t("settings.workspaceSdkDetectionFailed")}: {rootError}
                        </div>
                      )}

                      {resolution?.analysis.warnings.map((warning) => (
                        <div key={warning} className="mt-2 flex gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[9px] text-amber-400">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {warning}
                        </div>
                      ))}

                      <div className="mt-2 space-y-2">
                        {resolution?.analysis.profiles.map((profile) => {
                          const profileResolved = resolution.resolved.filter(
                            (item) => normalizedPath(item.scopePath) === normalizedPath(profile.scopePath),
                          );
                          return (
                            <section key={profile.scopePath} className="rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] p-2.5">
                              <div className="flex flex-wrap items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <h4 className="truncate text-[11px] font-medium text-[var(--taomni-code-text)]">{profile.displayName}</h4>
                                  <div className="truncate font-mono text-[9px] text-[var(--taomni-code-muted)]" title={profile.scopePath}>
                                    {profile.relativePath || "."} · {profile.scopePath}
                                  </div>
                                </div>
                                <div className="flex flex-wrap justify-end gap-1">
                                  {profile.buildSystems.map((buildSystem) => (
                                    <span key={buildSystem} title={t("settings.workspaceSdkBuildSystems")} className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-400">{buildSystem}</span>
                                  ))}
                                  {profile.languages.map((language) => (
                                    <span key={language} title={t("settings.workspaceSdkLanguages")} className="rounded bg-[var(--taomni-code-active-line-bg)] px-1.5 py-0.5 text-[9px] text-[var(--taomni-code-muted)]">{kindLabel(language)}</span>
                                  ))}
                                </div>
                              </div>

                              <KotlinProfileDetails profile={profile} t={t} />

                              <div className="mt-2 text-[9px] font-semibold uppercase tracking-wide text-[var(--taomni-code-muted)]">
                                {t("settings.workspaceSdkRequirements")}
                              </div>
                              <div className="mt-1.5 space-y-1.5">
                                {profileResolved.map((resolved) => (
                                  <BindingRow
                                    key={`${resolved.kind}:${resolved.role}`}
                                    registry={registry}
                                    resolved={resolved}
                                    rootId={root.id}
                                    busyKey={busyKey}
                                    onBindingChange={changeBinding}
                                    t={t}
                                  />
                                ))}
                                {profile.languages.includes("java") && (
                                  <ToolingJavaRow
                                    registry={registry}
                                    scopePath={profile.scopePath}
                                    rootId={root.id}
                                    busyKey={busyKey}
                                    onBindingChange={changeBinding}
                                    t={t}
                                  />
                                )}
                                {profileResolved.length === 0 && !profile.languages.includes("java") && (
                                  <div className="rounded border border-dashed border-[var(--taomni-code-border)] px-2 py-3 text-center text-[9px] text-[var(--taomni-code-muted)]">
                                    {t("settings.workspaceSdkNoRequirements")}
                                  </div>
                                )}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
