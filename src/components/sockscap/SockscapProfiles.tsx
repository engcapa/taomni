import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  FlaskConical,
  Network,
  Plus,
  Save,
  Server,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import type {
  SockscapAppSelectorKind,
  SockscapEgressKind,
  SockscapEgressSessionSummary,
  SockscapPersistedRoutingProfile,
  SockscapProcessSummary,
  SockscapProfileScope,
  SockscapRoutingProfileDraft,
  SockscapTestEgressResult,
} from "../../lib/sockscap";
import { useT } from "../../lib/i18n";
import {
  changeSockscapProfileScope,
  createSockscapProfileDraft,
  selectSockscapEgress,
  sockscapScopeSupported,
  validateSockscapProfileDraft,
} from "../../lib/sockscapProfiles";
import { useSockscapStore } from "../../stores/sockscapStore";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";

type ProcessPickerMode = "application" | "runtime";

export function SockscapProfiles() {
  const t = useT();
  const capabilities = useSockscapStore((state) => state.capabilities);
  const profiles = useSockscapStore((state) => state.profiles);
  const processes = useSockscapStore((state) => state.processes);
  const egressSessions = useSockscapStore((state) => state.egressSessions);
  const ruleSources = useSockscapStore((state) => state.ruleSources);
  const profileActionPending = useSockscapStore((state) => state.profileActionPending);
  const loadProcesses = useSockscapStore((state) => state.loadProcesses);
  const saveProfile = useSockscapStore((state) => state.saveProfile);
  const deleteProfile = useSockscapStore((state) => state.deleteProfile);
  const testEgress = useSockscapStore((state) => state.testEgress);
  const confirmDialog = useConfirmDialog();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SockscapRoutingProfileDraft | null>(null);
  const [baseline, setBaseline] = useState<SockscapRoutingProfileDraft | null>(null);
  const [revision, setRevision] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerMode, setPickerMode] = useState<ProcessPickerMode | null>(null);
  const [selectorKind, setSelectorKind] = useState<SockscapAppSelectorKind>("executable_path");
  const [selectorValue, setSelectorValue] = useState("");
  const [testHost, setTestHost] = useState("example.com");
  const [testPort, setTestPort] = useState(443);
  const [egressResult, setEgressResult] = useState<SockscapTestEgressResult | null>(null);

  const dirty = Boolean(draft && (revision === 0 || (baseline && JSON.stringify(draft) !== JSON.stringify(baseline))));
  const selectedEgress = useMemo(() => resolveEgress(draft, egressSessions), [draft, egressSessions]);

  useEffect(() => {
    if (draft || profiles.length === 0) return;
    const record = profiles.find((candidate) => candidate.profile.id === selectedId) ?? profiles[0];
    setSelectedId(record.profile.id);
    setDraft(cloneProfile(record.profile));
    setBaseline(cloneProfile(record.profile));
    setRevision(record.revision);
  }, [draft, profiles, selectedId]);

  const abandonChanges = async (): Promise<boolean> => {
    if (!dirty) return true;
    return confirmDialog.confirm({
      title: t("sockscap.unsavedTitle"),
      message: t("sockscap.unsavedMessage"),
      confirmLabel: t("sockscap.discardChanges"),
      danger: true,
    });
  };

  const openRecord = async (record: SockscapPersistedRoutingProfile) => {
    if (!(await abandonChanges())) return;
    setSelectedId(record.profile.id);
    setDraft(cloneProfile(record.profile));
    setBaseline(cloneProfile(record.profile));
    setRevision(record.revision);
    setLocalError(null);
    setNotice(null);
    setEgressResult(null);
  };

  const createProfile = async () => {
    if (!(await abandonChanges())) return;
    const next = createSockscapProfileDraft(undefined, t("sockscap.newProfileName"));
    setSelectedId(next.id);
    setDraft(next);
    setBaseline(cloneProfile(next));
    setRevision(0);
    setLocalError(null);
    setNotice(null);
    setEgressResult(null);
  };

  const updateDraft = (update: (current: SockscapRoutingProfileDraft) => SockscapRoutingProfileDraft) => {
    setDraft((current) => current ? update(current) : current);
    setLocalError(null);
    setNotice(null);
  };

  const handleSave = async () => {
    if (!draft) return;
    const issues = validateSockscapProfileDraft(draft, selectedEgress);
    if (issues.length > 0) {
      setLocalError(t("sockscap.profileValidationFailed", {
        fields: [...new Set(issues.map((issue) => profileFieldLabel(t, issue.field)))].join(", "),
      }));
      return;
    }
    try {
      const saved = await saveProfile(draft, revision);
      setSelectedId(saved.profile.id);
      setDraft(cloneProfile(saved.profile));
      setBaseline(cloneProfile(saved.profile));
      setRevision(saved.revision);
      setNotice(t("sockscap.profileSaved", { revision: saved.revision }));
      setLocalError(null);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  const handleDelete = async () => {
    if (!draft || revision === 0) return;
    const confirmed = await confirmDialog.confirm({
      title: t("sockscap.deleteProfileTitle"),
      message: t("sockscap.deleteProfileMessage", { name: draft.name }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteProfile(draft.id, revision);
      setSelectedId(null);
      setDraft(null);
      setBaseline(null);
      setRevision(0);
      setLocalError(null);
      setNotice(null);
      setEgressResult(null);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  const openPicker = (mode: ProcessPickerMode) => {
    setPickerMode(mode);
    if (!processes) void loadProcesses();
  };

  const addManualSelector = () => {
    const value = selectorValue.trim();
    if (!value) return;
    updateDraft((current) => ({
      ...current,
      appSelectors: current.appSelectors.some((selector) => selector.kind === selectorKind && selector.value === value)
        ? current.appSelectors
        : [...current.appSelectors, { kind: selectorKind, value }],
    }));
    setSelectorValue("");
  };

  const addProcess = (process: SockscapProcessSummary, mode: ProcessPickerMode) => {
    updateDraft((current) => {
      if (mode === "runtime") {
        const selector = { pid: process.pid, processStartTime: process.processStartTime };
        return {
          ...current,
          runtimeProcesses: current.runtimeProcesses.some((candidate) => candidate.pid === selector.pid
            && candidate.processStartTime === selector.processStartTime)
            ? current.runtimeProcesses
            : [...current.runtimeProcesses, selector],
        };
      }
      if (!process.executablePath) return current;
      return {
        ...current,
        appSelectors: current.appSelectors.some((candidate) => candidate.kind === "executable_path"
          && candidate.value === process.executablePath)
          ? current.appSelectors
          : [...current.appSelectors, { kind: "executable_path", value: process.executablePath }],
      };
    });
    setPickerMode(null);
  };

  const handleTestEgress = async () => {
    if (!draft || !selectedEgress) return;
    try {
      const result = await testEgress({
        sessionId: selectedEgress.id,
        targetHost: testHost.trim(),
        targetPort: testPort,
        timeoutMillis: 10_000,
        interactive: true,
        sshPoolOptions: draft.sshPoolOptions,
      });
      setEgressResult(result);
      setLocalError(result.ok ? null : result.issue?.message ?? t("sockscap.egressTestFailed"));
    } catch (error) {
      setEgressResult(null);
      setLocalError(errorMessage(error));
    }
  };

  return (
    <div className="mx-auto flex min-h-full max-w-[1500px] gap-4" data-testid="sockscap-profiles-page">
      <aside
        className="w-64 shrink-0 rounded-lg border p-3"
        style={{ background: "var(--taomni-card-bg)", borderColor: "var(--taomni-card-border)" }}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h1 className="text-[13px] font-semibold">{t("sockscap.profilesTitle")}</h1>
            <p className="mt-0.5 text-[10px] text-[var(--taomni-text-muted)]">
              {t("sockscap.profileCount", { count: profiles.length })}
            </p>
          </div>
          <button
            type="button"
            data-testid="sockscap-profile-new"
            onClick={() => void createProfile()}
            className="rounded-md border p-1.5"
            style={{ borderColor: "var(--taomni-input-border)" }}
            aria-label={t("sockscap.newProfile")}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-1.5">
          {profiles.map((record) => (
            <button
              key={record.profile.id}
              type="button"
              data-testid={`sockscap-profile-${record.profile.id}`}
              onClick={() => void openRecord(record)}
              className="w-full rounded-md border px-2.5 py-2 text-left"
              style={selectedId === record.profile.id
                ? { borderColor: "var(--taomni-accent)", background: "var(--taomni-selected)" }
                : { borderColor: "var(--taomni-card-border)" }}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${record.profile.enabled ? "bg-emerald-500" : "bg-slate-400"}`} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{record.profile.name}</span>
                <span className="text-[9px] text-[var(--taomni-text-muted)]">P{record.profile.priority}</span>
              </div>
              <div className="mt-1 truncate text-[9px] text-[var(--taomni-text-muted)]">
                {scopeLabel(t, record.profile.scope)} · r{record.revision}
              </div>
            </button>
          ))}
          {profiles.length === 0 && !draft && (
            <p className="rounded-md border border-dashed p-4 text-center text-[10px] text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-card-border)" }}>
              {t("sockscap.noProfiles")}
            </p>
          )}
        </div>
      </aside>

      <section className="min-w-0 flex-1">
        {!draft ? (
          <EmptyProfiles onCreate={() => void createProfile()} />
        ) : (
          <div className="space-y-4 pb-5">
            <div className="sticky -top-5 z-10 flex flex-wrap items-center justify-between gap-3 border-b py-3 backdrop-blur" style={{ background: "color-mix(in srgb, var(--taomni-bg) 92%, transparent)", borderColor: "var(--taomni-card-border)" }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-lg font-semibold">{draft.name || t("sockscap.newProfile")}</h1>
                  {dirty && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-semibold text-amber-700">{t("sockscap.unsaved")}</span>}
                </div>
                <p className="mt-0.5 text-[10px] text-[var(--taomni-text-muted)]">
                  {draft.id} · {t("sockscap.revision", { revision })} · {t("sockscap.newConnectionsOnly")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {revision > 0 && (
                  <EditorButton
                    testId="sockscap-profile-delete"
                    label={t("common.delete")}
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    disabled={profileActionPending !== null}
                    danger
                    onClick={() => void handleDelete()}
                  />
                )}
                <EditorButton
                  testId="sockscap-profile-save"
                  label={t("common.save")}
                  icon={<Save className="h-3.5 w-3.5" />}
                  disabled={profileActionPending !== null || !dirty}
                  primary
                  onClick={() => void handleSave()}
                />
              </div>
            </div>

            {localError && <EditorNotice tone="error">{localError}</EditorNotice>}
            {notice && <EditorNotice tone="success">{notice}</EditorNotice>}
            {!sockscapScopeSupported(capabilities, draft.scope) && (
              <EditorNotice tone="warning">
                {t("sockscap.scopeUnavailable", { scope: scopeLabel(t, draft.scope), detail: capabilities?.summary ?? "" })}
              </EditorNotice>
            )}

            <EditorCard title={t("sockscap.profileIdentityTitle")} icon={<Network className="h-4 w-4" />}>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px_140px]">
                <EditorField label={t("sockscap.profileName")}>
                  <input
                    data-testid="sockscap-profile-name"
                    value={draft.name}
                    maxLength={128}
                    onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
                    className={inputClass}
                  />
                </EditorField>
                <EditorField label={t("sockscap.priority")} hint={t("sockscap.priorityHint")}>
                  <input
                    data-testid="sockscap-profile-priority"
                    type="number"
                    min={0}
                    step={1}
                    value={draft.priority}
                    onChange={(event) => updateDraft((current) => ({ ...current, priority: numericValue(event.target.value) }))}
                    className={inputClass}
                  />
                </EditorField>
                <EditorField label={t("sockscap.profileState")}>
                  <label className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-[11px]" style={{ borderColor: "var(--taomni-input-border)" }}>
                    <input
                      data-testid="sockscap-profile-enabled"
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => updateDraft((current) => ({ ...current, enabled: event.target.checked }))}
                    />
                    {draft.enabled ? t("common.enabled") : t("common.disabled")}
                  </label>
                </EditorField>
              </div>
            </EditorCard>

            <EditorCard title={t("sockscap.captureScopeTitle")} icon={<ShieldAlert className="h-4 w-4" />}>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("sockscap.captureScopeTitle")}>
                {(["global", "applications", "runtime_processes"] as SockscapProfileScope[]).map((scope) => {
                  const supported = sockscapScopeSupported(capabilities, scope);
                  return (
                    <button
                      key={scope}
                      type="button"
                      data-testid={`sockscap-scope-${scope}`}
                      disabled={!supported && draft.scope !== scope}
                      onClick={() => updateDraft((current) => changeSockscapProfileScope(current, scope))}
                      className="rounded-md border px-3 py-2 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-45"
                      style={draft.scope === scope
                        ? { borderColor: "var(--taomni-accent)", background: "var(--taomni-selected)" }
                        : { borderColor: "var(--taomni-card-border)" }}
                    >
                      {scopeLabel(t, scope)}
                    </button>
                  );
                })}
              </div>

              {draft.scope === "global" && (
                <p className="mt-3 text-[11px] leading-5 text-[var(--taomni-text-muted)]">{t("sockscap.globalScopeDescription")}</p>
              )}
              {draft.scope === "applications" && (
                <div className="mt-4 space-y-3">
                  <SelectorRows
                    selectors={draft.appSelectors.map((selector, index) => ({
                      id: `${selector.kind}-${selector.value}`,
                      title: selectorKindLabel(t, selector.kind),
                      detail: selector.value,
                      onRemove: () => updateDraft((current) => ({
                        ...current,
                        appSelectors: current.appSelectors.filter((_, candidate) => candidate !== index),
                      })),
                    }))}
                    empty={t("sockscap.noApplicationSelectors")}
                  />
                  <div className="grid gap-2 md:grid-cols-[170px_minmax(0,1fr)_auto_auto]">
                    <select
                      aria-label={t("sockscap.selectorKind")}
                      value={selectorKind}
                      onChange={(event) => setSelectorKind(event.target.value as SockscapAppSelectorKind)}
                      className={inputClass}
                    >
                      <option value="executable_path">{t("sockscap.selectorExecutable")}</option>
                      <option value="macos_signing_identity">{t("sockscap.selectorSigningIdentity")}</option>
                      <option value="linux_cgroup">{t("sockscap.selectorCgroup")}</option>
                    </select>
                    <input
                      aria-label={t("sockscap.selectorValue")}
                      value={selectorValue}
                      onChange={(event) => setSelectorValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addManualSelector();
                        }
                      }}
                      placeholder={t("sockscap.selectorPlaceholder")}
                      className={inputClass}
                    />
                    <EditorButton label={t("common.add")} icon={<Plus className="h-3.5 w-3.5" />} disabled={!selectorValue.trim()} onClick={addManualSelector} />
                    <EditorButton testId="sockscap-pick-application" label={t("sockscap.chooseProcess")} disabled={!capabilities?.canStartAppGroup && capabilities !== null} onClick={() => openPicker("application")} />
                  </div>
                  <label className="flex items-center gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      checked={draft.includeChildren}
                      onChange={(event) => updateDraft((current) => ({ ...current, includeChildren: event.target.checked }))}
                    />
                    {t("sockscap.includeChildren")}
                  </label>
                </div>
              )}
              {draft.scope === "runtime_processes" && (
                <div className="mt-4 space-y-3">
                  <SelectorRows
                    selectors={draft.runtimeProcesses.map((selector, index) => {
                      const process = processes?.processes.find((candidate) => candidate.pid === selector.pid
                        && candidate.processStartTime === selector.processStartTime);
                      return {
                        id: `${selector.pid}-${selector.processStartTime}`,
                        title: process?.name ?? `PID ${selector.pid}`,
                        detail: `PID ${selector.pid} · ${t("sockscap.startToken", { token: selector.processStartTime })}`,
                        onRemove: () => updateDraft((current) => ({
                          ...current,
                          runtimeProcesses: current.runtimeProcesses.filter((_, candidate) => candidate !== index),
                        })),
                      };
                    })}
                    empty={t("sockscap.noRuntimeSelectors")}
                  />
                  <EditorButton
                    testId="sockscap-pick-runtime"
                    label={t("sockscap.chooseRunningProcess")}
                    icon={<Plus className="h-3.5 w-3.5" />}
                    disabled={!capabilities?.canAttachPid && capabilities !== null}
                    onClick={() => openPicker("runtime")}
                  />
                  <p className="text-[10px] text-[var(--taomni-text-muted)]">{t("sockscap.pidReuseNotice")}</p>
                </div>
              )}
            </EditorCard>

            <EditorCard title={t("sockscap.egressTitle")} icon={<Server className="h-4 w-4" />}>
              <div className="grid gap-3 md:grid-cols-2">
                <EditorField label={t("sockscap.egressKind")}>
                  <select
                    data-testid="sockscap-egress-kind"
                    value={draft.egressKind ?? ""}
                    onChange={(event) => {
                      const kind = event.target.value as SockscapEgressKind | "";
                      const candidate = kind ? egressSessions.find((session) => session.kind === kind) ?? null : null;
                      updateDraft((current) => selectSockscapEgress(current, candidate));
                      setEgressResult(null);
                    }}
                    className={inputClass}
                  >
                    <option value="">{t("sockscap.directOnly")}</option>
                    <option value="proxy_session" disabled={!egressSessions.some((session) => session.kind === "proxy_session")}>{t("sockscap.proxySession")}</option>
                    <option value="ssh_jump" disabled={!egressSessions.some((session) => session.kind === "ssh_jump")}>{t("sockscap.sshJumpSession")}</option>
                  </select>
                </EditorField>
                <EditorField label={t("sockscap.savedEgressSession")}>
                  <select
                    data-testid="sockscap-egress-session"
                    value={draft.egressRefId ?? ""}
                    disabled={!draft.egressKind}
                    onChange={(event) => {
                      const candidate = egressSessions.find((session) => session.id === event.target.value) ?? null;
                      updateDraft((current) => selectSockscapEgress(current, candidate));
                      setEgressResult(null);
                    }}
                    className={inputClass}
                  >
                    {egressSessions.filter((session) => session.kind === draft.egressKind).map((session) => (
                      <option key={session.id} value={session.id}>{session.name} · {session.endpointHost}:{session.endpointPort}</option>
                    ))}
                  </select>
                </EditorField>
              </div>

              {selectedEgress ? (
                <div className="mt-3 space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <SummaryCell label={t("sockscap.protocol")} value={selectedEgress.protocol.replaceAll("_", " ")} />
                    <SummaryCell label={t("sockscap.authentication")} value={selectedEgress.authKind.replaceAll("_", " ")} />
                    <SummaryCell label="DNS" value={selectedEgress.remoteDns ? t("sockscap.remoteDns") : t("sockscap.localDns")} />
                    <SummaryCell label="UDP / QUIC" value={selectedEgress.tcpOnly ? t("sockscap.tcpOnly") : t("sockscap.upstreamDependent")} />
                  </div>
                  {selectedEgress.issue && <EditorNotice tone={selectedEgress.issue.userActionRequired ? "warning" : "error"}>{selectedEgress.issue.message}</EditorNotice>}
                  {draft.egressKind === "ssh_jump" && (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <NumberField label={t("sockscap.sshControlConnections")} value={draft.sshPoolOptions.maxControlConnections} min={1} max={16} onChange={(value) => updateDraft((current) => ({ ...current, sshPoolOptions: { ...current.sshPoolOptions, maxControlConnections: value } }))} />
                      <NumberField label={t("sockscap.sshChannels")} value={draft.sshPoolOptions.maxChannelsPerConnection} min={1} max={4096} onChange={(value) => updateDraft((current) => ({ ...current, sshPoolOptions: { ...current.sshPoolOptions, maxChannelsPerConnection: value } }))} />
                      <NumberField label={t("sockscap.sshKeepalive")} value={draft.sshPoolOptions.keepaliveSeconds} min={1} max={3600} onChange={(value) => updateDraft((current) => ({ ...current, sshPoolOptions: { ...current.sshPoolOptions, keepaliveSeconds: value } }))} />
                      <NumberField label={t("sockscap.sshConnectTimeout")} value={draft.sshPoolOptions.connectTimeoutSeconds} min={1} max={300} onChange={(value) => updateDraft((current) => ({ ...current, sshPoolOptions: { ...current.sshPoolOptions, connectTimeoutSeconds: value } }))} />
                    </div>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <EditorField label={t("sockscap.testHost")} compact>
                      <input value={testHost} onChange={(event) => setTestHost(event.target.value)} className={`${inputClass} w-52`} />
                    </EditorField>
                    <EditorField label={t("sockscap.port")} compact>
                      <input type="number" min={1} max={65535} value={testPort} onChange={(event) => setTestPort(numericValue(event.target.value))} className={`${inputClass} w-24`} />
                    </EditorField>
                    <EditorButton
                      testId="sockscap-egress-test"
                      label={t("sockscap.testEgress")}
                      icon={<FlaskConical className="h-3.5 w-3.5" />}
                      disabled={profileActionPending !== null || !testHost.trim() || testPort < 1 || testPort > 65535}
                      onClick={() => void handleTestEgress()}
                    />
                  </div>
                  {egressResult && (
                    <EditorNotice tone={egressResult.ok ? "success" : "error"}>
                      {egressResult.ok
                        ? t("sockscap.egressTestPassed", { elapsed: egressResult.elapsedMillis })
                        : egressResult.issue?.message ?? t("sockscap.egressTestFailed")}
                    </EditorNotice>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[10px] text-[var(--taomni-text-muted)]">{t("sockscap.directOnlyDescription")}</p>
              )}
            </EditorCard>

            <div className="grid gap-4 xl:grid-cols-2">
              <EditorCard title={t("sockscap.routingRulesTitle")} icon={<Network className="h-4 w-4" />}>
                <div className="space-y-2">
                  {ruleSources.map((view) => {
                    const source = view.record.source;
                    const selected = draft.ruleSourceIds.includes(source.id);
                    const selectedIndex = draft.ruleSourceIds.indexOf(source.id);
                    return (
                      <div key={source.id} className="flex items-start gap-2 rounded-md border p-2.5" style={{ borderColor: "var(--taomni-card-border)" }}>
                        <input
                          aria-label={source.name}
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => updateDraft((current) => ({
                            ...current,
                            ruleSourceIds: event.target.checked
                              ? [...current.ruleSourceIds, source.id]
                              : current.ruleSourceIds.filter((id) => id !== source.id),
                          }))}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-medium">{source.name}</span>
                          <span className="block truncate text-[9px] text-[var(--taomni-text-muted)]">
                            {source.kind.replaceAll("_", " ")} · {view.state?.parseStats
                              ? t("sockscap.ruleCount", { count: view.state.parseStats.totalLines })
                              : t("sockscap.noLastGood")}
                          </span>
                        </span>
                        {selected && (
                          <span className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              aria-label={t("sockscap.moveRuleSourceUp", { name: source.name })}
                              disabled={selectedIndex <= 0}
                              onClick={() => updateDraft((current) => ({
                                ...current,
                                ruleSourceIds: moveItem(current.ruleSourceIds, selectedIndex, selectedIndex - 1),
                              }))}
                              className="rounded p-1 disabled:opacity-30"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              aria-label={t("sockscap.moveRuleSourceDown", { name: source.name })}
                              disabled={selectedIndex < 0 || selectedIndex >= draft.ruleSourceIds.length - 1}
                              onClick={() => updateDraft((current) => ({
                                ...current,
                                ruleSourceIds: moveItem(current.ruleSourceIds, selectedIndex, selectedIndex + 1),
                              }))}
                              className="rounded p-1 disabled:opacity-30"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {ruleSources.length === 0 && <p className="text-[10px] text-[var(--taomni-text-muted)]">{t("sockscap.noRuleSources")}</p>}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <PolicySelect label={t("sockscap.defaultAction")} value={draft.defaultAction} options={routeActionOptions(t)} onChange={(value) => updateDraft((current) => ({ ...current, defaultAction: value as SockscapRoutingProfileDraft["defaultAction"] }))} />
                  <PolicySelect label={t("sockscap.unknownDomainAction")} value={draft.unknownDomainAction} options={routeActionOptions(t)} onChange={(value) => updateDraft((current) => ({ ...current, unknownDomainAction: value as SockscapRoutingProfileDraft["unknownDomainAction"] }))} />
                </div>
              </EditorCard>

              <EditorCard title={t("sockscap.advancedPoliciesTitle")} icon={<ShieldAlert className="h-4 w-4" />}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <PolicySelect label={t("sockscap.failureAction")} value={draft.egressFailureAction} options={[
                    ["fail_open", t("sockscap.failOpen")],
                    ["fail_closed", t("sockscap.failClosed")],
                  ]} onChange={(value) => updateDraft((current) => ({ ...current, egressFailureAction: value as SockscapRoutingProfileDraft["egressFailureAction"] }))} />
                  <PolicySelect label="UDP / QUIC" value={draft.udpPolicy} options={[
                    ["proxy_if_supported", t("sockscap.proxyIfSupported")],
                    ["direct", "DIRECT"],
                    ["block", "BLOCK"],
                  ]} onChange={(value) => updateDraft((current) => ({ ...current, udpPolicy: value as SockscapRoutingProfileDraft["udpPolicy"] }))} />
                  <PolicySelect label={t("sockscap.dnsMode")} value={draft.dnsMode} options={[
                    ["system_capture", t("sockscap.systemCapture")],
                    ["virtual_dns", t("sockscap.virtualDns")],
                    ["strict_proxy", t("sockscap.strictProxy")],
                  ]} onChange={(value) => updateDraft((current) => ({ ...current, dnsMode: value as SockscapRoutingProfileDraft["dnsMode"] }))} />
                  <PolicySelect label={t("sockscap.localNetwork")} value={draft.localNetworkPolicy.lanAction} options={[
                    ["direct", "DIRECT"],
                    ["rules", t("sockscap.followRules")],
                    ["block", "BLOCK"],
                  ]} onChange={(value) => updateDraft((current) => ({ ...current, localNetworkPolicy: { lanAction: value as SockscapRoutingProfileDraft["localNetworkPolicy"]["lanAction"] } }))} />
                </div>
                {selectedEgress?.tcpOnly && draft.udpPolicy === "proxy_if_supported" && (
                  <EditorNotice tone="warning">{t("sockscap.tcpOnlyUdpWarning")}</EditorNotice>
                )}
              </EditorCard>
            </div>

            <EditorCard title={t("sockscap.statisticsPrivacyTitle")} icon={<CheckCircle2 className="h-4 w-4" />}>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <PolicySelect label={t("sockscap.collectionMode")} value={draft.statsPrivacy.collectionMode} options={[
                  ["persisted", t("sockscap.persistedStats")],
                  ["session_only", t("sockscap.sessionOnlyStats")],
                  ["disabled", t("common.disabled")],
                ]} onChange={(value) => updateDraft((current) => ({ ...current, statsPrivacy: { ...current.statsPrivacy, collectionMode: value as SockscapRoutingProfileDraft["statsPrivacy"]["collectionMode"] } }))} />
                <NumberField label={t("sockscap.minuteRetention")} value={draft.statsPrivacy.minuteRetentionDays} min={1} max={365} onChange={(value) => updateDraft((current) => ({ ...current, statsPrivacy: { ...current.statsPrivacy, minuteRetentionDays: value } }))} />
                <NumberField label={t("sockscap.hourlyRetention")} value={draft.statsPrivacy.hourlyRetentionDays} min={1} max={3650} onChange={(value) => updateDraft((current) => ({ ...current, statsPrivacy: { ...current.statsPrivacy, hourlyRetentionDays: value } }))} />
                <EditorField label={t("sockscap.domainAggregation")}>
                  <label className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-[10px]" style={{ borderColor: "var(--taomni-input-border)" }}>
                    <input type="checkbox" checked={draft.statsPrivacy.domainAggregationEnabled} onChange={(event) => updateDraft((current) => ({ ...current, statsPrivacy: { ...current.statsPrivacy, domainAggregationEnabled: event.target.checked } }))} />
                    {draft.statsPrivacy.domainAggregationEnabled ? t("common.enabled") : t("common.disabled")}
                  </label>
                </EditorField>
                <NumberField label={t("sockscap.domainRetention")} value={draft.statsPrivacy.domainRetentionDays} min={1} max={365} disabled={!draft.statsPrivacy.domainAggregationEnabled} onChange={(value) => updateDraft((current) => ({ ...current, statsPrivacy: { ...current.statsPrivacy, domainRetentionDays: value } }))} />
              </div>
              <p className="mt-3 text-[10px] leading-4 text-[var(--taomni-text-muted)]">{t("sockscap.privacyBoundary")}</p>
            </EditorCard>
          </div>
        )}
      </section>

      {pickerMode && (
        <ProcessPicker
          mode={pickerMode}
          catalog={processes?.processes ?? null}
          truncated={processes?.truncated ?? false}
          onChoose={(process) => addProcess(process, pickerMode)}
          onClose={() => setPickerMode(null)}
        />
      )}
      {confirmDialog.render}
    </div>
  );
}

function EmptyProfiles({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-dashed" style={{ borderColor: "var(--taomni-card-border)" }}>
      <div className="max-w-sm text-center">
        <Network className="mx-auto h-8 w-8 text-[var(--taomni-accent)]" />
        <h2 className="mt-3 text-[14px] font-semibold">{t("sockscap.noProfiles")}</h2>
        <p className="mt-1 text-[11px] text-[var(--taomni-text-muted)]">{t("sockscap.noProfilesDescription")}</p>
        <div className="mt-4 flex justify-center">
          <EditorButton label={t("sockscap.newProfile")} icon={<Plus className="h-3.5 w-3.5" />} primary disabled={false} onClick={onCreate} />
        </div>
      </div>
    </div>
  );
}

function ProcessPicker({
  mode,
  catalog,
  truncated,
  onChoose,
  onClose,
}: {
  mode: ProcessPickerMode;
  catalog: SockscapProcessSummary[] | null;
  truncated: boolean;
  onChoose: (process: SockscapProcessSummary) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const filtered = (catalog ?? []).filter((process) => {
    const needle = query.trim().toLowerCase();
    return !needle || process.name.toLowerCase().includes(needle)
      || process.executablePath?.toLowerCase().includes(needle)
      || String(process.pid).includes(needle);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/45 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div role="dialog" aria-modal="true" aria-label={t("sockscap.processPickerTitle")} className="flex max-h-[76vh] w-[680px] flex-col rounded-lg border shadow-xl" style={{ background: "var(--taomni-bg)", borderColor: "var(--taomni-card-border)" }}>
        <header className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--taomni-card-border)" }}>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold">{mode === "runtime" ? t("sockscap.chooseRunningProcess") : t("sockscap.rememberApplication")}</h2>
            <p className="mt-0.5 text-[9px] text-[var(--taomni-text-muted)]">{mode === "runtime" ? t("sockscap.runtimePickerDescription") : t("sockscap.applicationPickerDescription")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")}><X className="h-4 w-4" /></button>
        </header>
        <div className="p-3">
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("sockscap.searchProcesses")} className={inputClass} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {catalog === null ? (
            <p className="py-10 text-center text-[11px] text-[var(--taomni-text-muted)]">{t("common.loading")}</p>
          ) : (
            <div className="space-y-1.5">
              {filtered.map((process) => {
                const allowed = mode === "runtime" ? process.selectable : process.rememberable && Boolean(process.executablePath);
                return (
                  <button
                    key={`${process.pid}-${process.processStartTime}`}
                    type="button"
                    data-testid={`sockscap-process-${process.pid}`}
                    disabled={!allowed}
                    onClick={() => onChoose(process)}
                    className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45"
                    style={{ borderColor: "var(--taomni-card-border)" }}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--taomni-selected)] text-[10px] font-semibold">{process.name.slice(0, 2).toUpperCase()}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium">{process.name}</span>
                      <span className="block truncate text-[9px] text-[var(--taomni-text-muted)]">PID {process.pid} · {process.executablePath ?? process.issueCode ?? t("sockscap.pathUnavailable")}</span>
                    </span>
                    <span className="text-[9px] text-[var(--taomni-text-muted)]">{t("sockscap.startToken", { token: process.processStartTime })}</span>
                  </button>
                );
              })}
              {filtered.length === 0 && <p className="py-10 text-center text-[11px] text-[var(--taomni-text-muted)]">{t("sockscap.noProcesses")}</p>}
            </div>
          )}
          {truncated && <p className="mt-2 text-[9px] text-amber-700">{t("sockscap.processListTruncated")}</p>}
        </div>
      </div>
    </div>
  );
}

function EditorCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border" style={{ background: "var(--taomni-card-bg)", borderColor: "var(--taomni-card-border)" }}>
      <header className="flex items-center gap-2 border-b px-4 py-3 text-[12px] font-semibold" style={{ borderColor: "var(--taomni-card-border)" }}>
        <span className="text-[var(--taomni-accent)]">{icon}</span>{title}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function EditorField({ label, hint, compact = false, children }: { label: string; hint?: string; compact?: boolean; children: ReactNode }) {
  return (
    <label className={`block ${compact ? "w-auto" : "min-w-0"}`}>
      <span className="mb-1 flex items-center gap-1 text-[10px] font-medium">{label}{hint && <span className="font-normal text-[var(--taomni-text-muted)]">· {hint}</span>}</span>
      {children}
    </label>
  );
}

function NumberField({ label, value, min, max, disabled = false, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <EditorField label={label}>
      <input type="number" min={min} max={max} step={1} disabled={disabled} value={value} onChange={(event) => onChange(numericValue(event.target.value))} className={inputClass} />
    </EditorField>
  );
}

function PolicySelect({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <EditorField label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>
        {options.map(([option, name]) => <option key={option} value={option}>{name}</option>)}
      </select>
    </EditorField>
  );
}

function SelectorRows({ selectors, empty }: { selectors: Array<{ id: string; title: string; detail: string; onRemove: () => void }>; empty: string }) {
  const t = useT();
  if (selectors.length === 0) return <p className="rounded-md border border-dashed p-3 text-center text-[10px] text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-card-border)" }}>{empty}</p>;
  return (
    <div className="space-y-1.5">
      {selectors.map((selector) => (
        <div key={selector.id} className="flex items-center gap-2 rounded-md border px-3 py-2" style={{ borderColor: "var(--taomni-card-border)" }}>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium">{selector.title}</div>
            <div className="truncate text-[9px] text-[var(--taomni-text-muted)]">{selector.detail}</div>
          </div>
          <button type="button" onClick={selector.onRemove} aria-label={t("common.remove")}><X className="h-3.5 w-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2" style={{ borderColor: "var(--taomni-card-border)" }}>
      <div className="text-[9px] uppercase tracking-wide text-[var(--taomni-text-muted)]">{label}</div>
      <div className="mt-1 truncate text-[10px] font-semibold capitalize">{value}</div>
    </div>
  );
}

function EditorNotice({ tone, children }: { tone: "warning" | "error" | "success"; children: ReactNode }) {
  const styles = tone === "success"
    ? { background: "var(--taomni-success-bg)", color: "var(--taomni-success-text)", borderColor: "rgba(16,185,129,.35)" }
    : tone === "warning"
      ? { background: "var(--taomni-warning-bg)", color: "var(--taomni-warning-text)", borderColor: "var(--taomni-warning-border)" }
      : { background: "rgba(220,38,38,.1)", color: "#b91c1c", borderColor: "rgba(220,38,38,.35)" };
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return <div className="mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[10px] leading-4" style={styles}><Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />{children}</div>;
}

function EditorButton({ label, icon, testId, disabled, primary = false, danger = false, onClick }: { label: string; icon?: ReactNode; testId?: string; disabled: boolean; primary?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-[10px] font-medium disabled:cursor-not-allowed disabled:opacity-45"
      style={primary
        ? { background: "var(--taomni-accent)", borderColor: "var(--taomni-accent)", color: "white" }
        : danger
          ? { borderColor: "rgba(220,38,38,.45)", color: "#b91c1c" }
          : { borderColor: "var(--taomni-input-border)", background: "var(--taomni-button-from)" }}
    >
      {icon}{label}
    </button>
  );
}

const inputClass = "h-8 w-full rounded-md border bg-transparent px-2.5 text-[11px] outline-none focus:border-[var(--taomni-accent)] disabled:cursor-not-allowed disabled:opacity-45";

function cloneProfile(profile: SockscapRoutingProfileDraft): SockscapRoutingProfileDraft {
  return structuredClone(profile);
}

function resolveEgress(profile: SockscapRoutingProfileDraft | null, sessions: SockscapEgressSessionSummary[]): SockscapEgressSessionSummary | null {
  if (!profile?.egressRefId) return null;
  return sessions.find((session) => session.id === profile.egressRefId && session.kind === profile.egressKind) ?? null;
}

function numericValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Translator = ReturnType<typeof useT>;

function scopeLabel(t: Translator, scope: SockscapProfileScope): string {
  if (scope === "global") return t("sockscap.scopeGlobal");
  if (scope === "applications") return t("sockscap.scopeApplications");
  return t("sockscap.scopeRuntime");
}

function selectorKindLabel(t: Translator, kind: SockscapAppSelectorKind): string {
  if (kind === "executable_path") return t("sockscap.selectorExecutable");
  if (kind === "macos_signing_identity") return t("sockscap.selectorSigningIdentity");
  return t("sockscap.selectorCgroup");
}

function profileFieldLabel(t: Translator, field: string): string {
  if (field === "name") return t("sockscap.profileName");
  if (field === "priority") return t("sockscap.priority");
  if (field === "appSelectors") return t("sockscap.scopeApplications");
  if (field === "runtimeProcesses") return t("sockscap.scopeRuntime");
  if (field === "egress") return t("sockscap.egressTitle");
  if (field === "sshPoolOptions") return t("sockscap.sshPoolOptions");
  if (field === "statsPrivacy") return t("sockscap.statisticsPrivacyTitle");
  return field;
}

function routeActionOptions(t: Translator): Array<[string, string]> {
  return [["direct", "DIRECT"], ["proxy", "PROXY"], ["block", "BLOCK"]].map(([value, label]) => [value, value === "proxy" ? `${label} · ${t("sockscap.requiresEgress")}` : label]);
}
