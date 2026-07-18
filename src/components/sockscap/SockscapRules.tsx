import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  FileInput,
  FileKey2,
  FlaskConical,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import type {
  SockscapCustomRuleDraft,
  SockscapPersistedRoutingProfile,
  SockscapRefreshOutcome,
  SockscapRuleSourceDraft,
  SockscapRuleSourceKind,
  SockscapRuleSourceView,
  SockscapTestTargetResult,
} from "../../lib/sockscap";
import { useT } from "../../lib/i18n";
import {
  buildSockscapTestTargetRequest,
  createSockscapCustomRuleDraft,
  createSockscapRuleSourceDraft,
  type SockscapTargetDraft,
  validateSockscapCustomRules,
  validateSockscapRuleSourceDraft,
  validateSockscapTargetDraft,
} from "../../lib/sockscapRules";
import { useSockscapStore } from "../../stores/sockscapStore";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";

const defaultTarget: SockscapTargetDraft = {
  appIdentity: "",
  appSelectorKind: "executable_path",
  pid: null,
  processStartTime: null,
  target: "example.com",
  port: 443,
  protocol: "tcp",
  hostnameSource: "platform_remote_hostname",
  hardBypass: false,
};

const MAX_RULE_PAYLOAD_BYTES = 5 * 1024 * 1024;

export function SockscapRules() {
  const t = useT();
  const ruleSources = useSockscapStore((state) => state.ruleSources);
  const profiles = useSockscapStore((state) => state.profiles);
  const egressSessions = useSockscapStore((state) => state.egressSessions);
  const ruleActionPending = useSockscapStore((state) => state.ruleActionPending);
  const profileActionPending = useSockscapStore((state) => state.profileActionPending);
  const saveRuleSource = useSockscapStore((state) => state.saveRuleSource);
  const deleteRuleSource = useSockscapStore((state) => state.deleteRuleSource);
  const refreshRuleSource = useSockscapStore((state) => state.refreshRuleSource);
  const importRuleSource = useSockscapStore((state) => state.importRuleSource);
  const saveProfile = useSockscapStore((state) => state.saveProfile);
  const testTarget = useSockscapStore((state) => state.testTarget);
  const confirmDialog = useConfirmDialog();

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState<SockscapRuleSourceDraft | null>(null);
  const [sourceBaseline, setSourceBaseline] = useState<SockscapRuleSourceDraft | null>(null);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [refreshOutcome, setRefreshOutcome] = useState<SockscapRefreshOutcome | null>(null);

  const [overrideProfileId, setOverrideProfileId] = useState<string | null>(null);
  const [overrideProfile, setOverrideProfile] = useState<SockscapPersistedRoutingProfile | null>(null);
  const [overrideRules, setOverrideRules] = useState<SockscapCustomRuleDraft[]>([]);
  const [overrideBaseline, setOverrideBaseline] = useState<SockscapCustomRuleDraft[]>([]);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overrideNotice, setOverrideNotice] = useState<string | null>(null);

  const [targetDraft, setTargetDraft] = useState<SockscapTargetDraft>(defaultTarget);
  const [targetResult, setTargetResult] = useState<SockscapTestTargetResult | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);

  const sourceDirty = Boolean(sourceDraft && (sourceRevision === 0
    || (sourceBaseline && JSON.stringify(sourceDraft) !== JSON.stringify(sourceBaseline))));
  const overrideDirty = Boolean(overrideProfile && JSON.stringify(overrideRules) !== JSON.stringify(overrideBaseline));
  const selectedSourceView = useMemo(
    () => ruleSources.find((view) => view.record.source.id === selectedSourceId) ?? null,
    [ruleSources, selectedSourceId],
  );

  useEffect(() => {
    if (sourceDraft || ruleSources.length === 0) return;
    loadSource(ruleSources[0]);
  }, [ruleSources, sourceDraft]);

  useEffect(() => {
    if (overrideProfile || profiles.length === 0) return;
    loadOverrideProfile(profiles[0]);
  }, [overrideProfile, profiles]);

  const canDiscard = async (dirty: boolean): Promise<boolean> => {
    if (!dirty) return true;
    return confirmDialog.confirm({
      title: t("sockscap.unsavedTitle"),
      message: t("sockscap.unsavedRulesMessage"),
      confirmLabel: t("sockscap.discardChanges"),
      danger: true,
    });
  };

  function loadSource(view: SockscapRuleSourceView) {
    setSelectedSourceId(view.record.source.id);
    setSourceDraft(clone(view.record.source));
    setSourceBaseline(clone(view.record.source));
    setSourceRevision(view.record.revision);
    setSourceError(null);
    setSourceNotice(null);
    setRefreshOutcome(null);
    setPayload("");
  }

  const selectSource = async (view: SockscapRuleSourceView) => {
    if (!(await canDiscard(sourceDirty))) return;
    loadSource(view);
  };

  const createSource = async (kind: Exclude<SockscapRuleSourceKind, "gfwlist_official">) => {
    if (!(await canDiscard(sourceDirty))) return;
    const draft = createSockscapRuleSourceDraft(
      kind,
      undefined,
      kind === "custom_url" ? t("sockscap.newUrlSource") : t("sockscap.newLocalSource"),
    );
    setSelectedSourceId(draft.id);
    setSourceDraft(draft);
    setSourceBaseline(clone(draft));
    setSourceRevision(0);
    setSourceError(null);
    setSourceNotice(null);
    setRefreshOutcome(null);
    setPayload("");
  };

  const handleSaveSource = async () => {
    if (!sourceDraft) return;
    const issues = validateSockscapRuleSourceDraft(sourceDraft);
    if (issues.length > 0) {
      setSourceError(t("sockscap.ruleSourceValidationFailed", {
        fields: [...new Set(issues.map((issue) => ruleSourceFieldLabel(t, issue.field)))].join(", "),
      }));
      return;
    }
    try {
      const saved = await saveRuleSource(sourceDraft, sourceRevision);
      setSourceDraft(clone(saved.source));
      setSourceBaseline(clone(saved.source));
      setSourceRevision(saved.revision);
      setSelectedSourceId(saved.source.id);
      setSourceNotice(t("sockscap.ruleSourceSaved", { revision: saved.revision }));
      setSourceError(null);
    } catch (error) {
      setSourceError(errorMessage(error));
    }
  };

  const handleDeleteSource = async () => {
    if (!sourceDraft || sourceRevision === 0 || sourceDraft.kind === "gfwlist_official") return;
    const confirmed = await confirmDialog.confirm({
      title: t("sockscap.deleteRuleSourceTitle"),
      message: t("sockscap.deleteRuleSourceMessage", { name: sourceDraft.name }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteRuleSource(sourceDraft.id, sourceRevision);
      setSelectedSourceId(null);
      setSourceDraft(null);
      setSourceBaseline(null);
      setSourceRevision(0);
      setSourceError(null);
      setSourceNotice(null);
      setRefreshOutcome(null);
    } catch (error) {
      setSourceError(errorMessage(error));
    }
  };

  const handleRefresh = async () => {
    if (!sourceDraft || sourceRevision === 0) return;
    try {
      const outcome = await refreshRuleSource(sourceDraft.id);
      setRefreshOutcome(outcome);
      setSourceError(outcome.ok || outcome.usedLastGood ? null : outcome.error ?? t("sockscap.ruleRefreshFailed"));
      setSourceNotice(outcome.ok
        ? (outcome.notModified ? t("sockscap.ruleNotModified") : t("sockscap.ruleRefreshSucceeded"))
        : outcome.usedLastGood ? t("sockscap.ruleUsingLastGood") : null);
    } catch (error) {
      setSourceError(errorMessage(error));
    }
  };

  const handleImport = async () => {
    if (!sourceDraft || sourceRevision === 0 || !payload.trim()) return;
    try {
      const outcome = await importRuleSource(sourceDraft.id, payload);
      setRefreshOutcome(outcome);
      setSourceError(outcome.ok ? null : outcome.error ?? t("sockscap.ruleImportFailed"));
      setSourceNotice(outcome.ok ? t("sockscap.ruleImportSucceeded") : null);
    } catch (error) {
      setSourceError(errorMessage(error));
    }
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_RULE_PAYLOAD_BYTES) {
        setSourceError(t("sockscap.rulePayloadTooLarge"));
        return;
      }
      setPayload(await file.text());
      setSourceNotice(t("sockscap.localPayloadLoaded", { name: file.name }));
      setSourceError(null);
    } catch (error) {
      setSourceError(errorMessage(error));
    } finally {
      event.target.value = "";
    }
  };

  function loadOverrideProfile(record: SockscapPersistedRoutingProfile) {
    setOverrideProfileId(record.profile.id);
    setOverrideProfile(record);
    setOverrideRules(clone(record.profile.customRules));
    setOverrideBaseline(clone(record.profile.customRules));
    setOverrideError(null);
    setOverrideNotice(null);
  }

  const selectOverrideProfile = async (profileId: string) => {
    if (!(await canDiscard(overrideDirty))) return;
    const record = profiles.find((candidate) => candidate.profile.id === profileId);
    if (record) loadOverrideProfile(record);
  };

  const saveOverrides = async () => {
    if (!overrideProfile) return;
    if (validateSockscapCustomRules(overrideRules).length > 0) {
      setOverrideError(t("sockscap.manualRuleValidationFailed"));
      return;
    }
    try {
      const saved = await saveProfile(
        { ...overrideProfile.profile, customRules: overrideRules },
        overrideProfile.revision,
      );
      setOverrideProfile(saved);
      setOverrideRules(clone(saved.profile.customRules));
      setOverrideBaseline(clone(saved.profile.customRules));
      setOverrideNotice(t("sockscap.manualRulesSaved", { revision: saved.revision }));
      setOverrideError(null);
    } catch (error) {
      setOverrideError(errorMessage(error));
    }
  };

  const runTargetTest = async () => {
    const issues = validateSockscapTargetDraft(targetDraft);
    if (issues.length > 0) {
      setTargetError(t("sockscap.targetValidationFailed"));
      return;
    }
    try {
      const result = await testTarget(buildSockscapTestTargetRequest(targetDraft));
      setTargetResult(result);
      setTargetError(null);
    } catch (error) {
      setTargetResult(null);
      setTargetError(errorMessage(error));
    }
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 pb-5" data-testid="sockscap-rules-page">
      <div>
        <h1 className="text-xl font-semibold">{t("sockscap.rulesTitle")}</h1>
        <p className="mt-1 text-[12px] text-[var(--taomni-text-muted)]">{t("sockscap.rulesDescription")}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <RuleCard title={t("sockscap.ruleSourcesTitle")} icon={<FileKey2 className="h-4 w-4" />}>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <RuleButton testId="sockscap-rule-source-new-url" label={t("sockscap.addUrlSource")} icon={<Plus className="h-3.5 w-3.5" />} disabled={ruleActionPending !== null} onClick={() => void createSource("custom_url")} />
            <RuleButton testId="sockscap-rule-source-new-local" label={t("sockscap.addLocalSource")} icon={<Plus className="h-3.5 w-3.5" />} disabled={ruleActionPending !== null} onClick={() => void createSource("local_file")} />
          </div>
          <div className="space-y-1.5">
            {ruleSources.map((view) => (
              <button
                key={view.record.source.id}
                type="button"
                data-testid="sockscap-rule-source-row"
                data-source-id={view.record.source.id}
                onClick={() => void selectSource(view)}
                className="w-full rounded-md border px-3 py-2 text-left"
                style={selectedSourceId === view.record.source.id
                  ? { borderColor: "var(--taomni-accent)", background: "var(--taomni-selected)" }
                  : { borderColor: "var(--taomni-card-border)" }}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${view.state?.lastError ? "bg-amber-500" : view.record.source.enabled ? "bg-emerald-500" : "bg-slate-400"}`} />
                  <span className="min-w-0 flex-1 truncate text-[10px] font-medium">{view.record.source.name}</span>
                  <span className="text-[8px] uppercase text-[var(--taomni-text-muted)]">{view.record.source.kind.replaceAll("_", " ")}</span>
                </div>
                <div className="mt-1 truncate text-[9px] text-[var(--taomni-text-muted)]">
                  {view.state?.lastSuccessUnix ? formatTime(view.state.lastSuccessUnix) : t("sockscap.noLastGood")}
                </div>
              </button>
            ))}
            {ruleSources.length === 0 && !sourceDraft && <p className="py-8 text-center text-[10px] text-[var(--taomni-text-muted)]">{t("sockscap.noRuleSources")}</p>}
          </div>
        </RuleCard>

        <RuleCard title={sourceDraft?.name ?? t("sockscap.ruleSourceEditor")} icon={<RefreshCw className="h-4 w-4" />}>
          {!sourceDraft ? (
            <p className="py-12 text-center text-[11px] text-[var(--taomni-text-muted)]">{t("sockscap.selectOrCreateRuleSource")}</p>
          ) : (
            <div className="space-y-4">
              {sourceError && <RuleNotice tone="error">{sourceError}</RuleNotice>}
              {sourceNotice && <RuleNotice tone="success">{sourceNotice}</RuleNotice>}
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_160px]">
                <RuleField label={t("sockscap.ruleSourceName")}>
                  <input data-testid="sockscap-rule-source-name" value={sourceDraft.name} disabled={sourceDraft.kind === "gfwlist_official"} maxLength={128} onChange={(event) => setSourceDraft({ ...sourceDraft, name: event.target.value })} className={inputClass} />
                </RuleField>
                <RuleField label={t("sockscap.ruleSourceState")}>
                  <label className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-[10px]" style={{ borderColor: "var(--taomni-input-border)" }}>
                    <input data-testid="sockscap-rule-source-enabled" type="checkbox" checked={sourceDraft.enabled} disabled={sourceDraft.kind === "gfwlist_official"} onChange={(event) => setSourceDraft({ ...sourceDraft, enabled: event.target.checked })} />
                    {sourceDraft.enabled ? t("common.enabled") : t("common.disabled")}
                  </label>
                </RuleField>
                <RuleField label={t("sockscap.refreshIntervalHours")}>
                  <input data-testid="sockscap-rule-source-interval" type="number" min={0.25} max={720} step={0.25} disabled={sourceDraft.kind === "gfwlist_official"} value={sourceDraft.refreshIntervalSeconds / 3600} onChange={(event) => setSourceDraft({ ...sourceDraft, refreshIntervalSeconds: Math.round(numberValue(event.target.value) * 3600) })} className={inputClass} />
                </RuleField>
              </div>
              <div className="flex items-end gap-2">
                <RuleField label={t("sockscap.ruleSourceId")}>
                  <input value={sourceDraft.id} disabled className={inputClass} />
                </RuleField>
                <RuleField label={t("sockscap.ruleSourceKind")}>
                  <input value={sourceDraft.kind.replaceAll("_", " ")} disabled className={inputClass} />
                </RuleField>
              </div>
              {sourceDraft.kind === "custom_url" && (
                <RuleField label={t("sockscap.ruleSourceUrl")}>
                  <input data-testid="sockscap-rule-source-url" value={sourceDraft.url ?? ""} onChange={(event) => setSourceDraft({ ...sourceDraft, url: event.target.value })} className={inputClass} />
                </RuleField>
              )}
              <div className="flex flex-wrap gap-2">
                {sourceDraft.kind !== "gfwlist_official" && (
                  <RuleButton testId="sockscap-rule-source-save" label={t("common.save")} icon={<Save className="h-3.5 w-3.5" />} disabled={ruleActionPending !== null || !sourceDirty} primary onClick={() => void handleSaveSource()} />
                )}
                {sourceRevision > 0 && sourceDraft.kind !== "local_file" && (
                  <RuleButton testId="sockscap-rule-source-refresh" label={t("sockscap.refreshNow")} icon={<RefreshCw className={`h-3.5 w-3.5 ${ruleActionPending === "refresh_source" ? "animate-spin" : ""}`} />} disabled={ruleActionPending !== null || sourceDirty} onClick={() => void handleRefresh()} />
                )}
                {sourceRevision > 0 && sourceDraft.kind !== "gfwlist_official" && (
                  <RuleButton testId="sockscap-rule-source-delete" label={t("common.delete")} icon={<Trash2 className="h-3.5 w-3.5" />} disabled={ruleActionPending !== null} danger onClick={() => void handleDeleteSource()} />
                )}
              </div>

              {selectedSourceView?.state && <RuleSourceStateView view={selectedSourceView} />}

              {sourceRevision > 0 && sourceDraft.kind !== "gfwlist_official" && (
                <div className="rounded-md border p-3" style={{ borderColor: "var(--taomni-card-border)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-[11px] font-semibold">{t("sockscap.importRulePayload")}</h3>
                      <p className="text-[9px] text-[var(--taomni-text-muted)]">{t("sockscap.importRulePayloadDescription")}</p>
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[9px]" style={{ borderColor: "var(--taomni-input-border)" }}>
                      <FileInput className="h-3.5 w-3.5" />{t("sockscap.chooseLocalFile")}
                      <input data-testid="sockscap-rule-file" type="file" accept=".txt,.list,text/plain" className="sr-only" onChange={(event) => void readFile(event)} />
                    </label>
                  </div>
                  <textarea data-testid="sockscap-rule-payload" value={payload} onChange={(event) => setPayload(event.target.value)} rows={5} placeholder={t("sockscap.rulePayloadPlaceholder")} className={`${inputClass} mt-3 h-auto resize-y py-2 font-mono`} />
                  <div className="mt-2">
                    <RuleButton testId="sockscap-rule-source-import" label={t("sockscap.importAndCompile")} icon={<FileInput className="h-3.5 w-3.5" />} disabled={ruleActionPending !== null || sourceDirty || !payload.trim()} onClick={() => void handleImport()} />
                  </div>
                </div>
              )}
              {refreshOutcome && <RefreshReport outcome={refreshOutcome} />}
            </div>
          )}
        </RuleCard>
      </div>

      <RuleCard title={t("sockscap.manualOverridesTitle")} icon={<ShieldCheck className="h-4 w-4" />}>
        {profiles.length === 0 ? (
          <p className="py-8 text-center text-[10px] text-[var(--taomni-text-muted)]">{t("sockscap.noProfiles")}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <RuleField label={t("sockscap.routingProfile")}>
                <select data-testid="sockscap-manual-profile" value={overrideProfileId ?? ""} onChange={(event) => void selectOverrideProfile(event.target.value)} className={`${inputClass} min-w-64`}>
                  {profiles.map((record) => <option key={record.profile.id} value={record.profile.id}>{record.profile.name} · r{record.revision}</option>)}
                </select>
              </RuleField>
              <div className="flex gap-2">
                <RuleButton testId="sockscap-manual-rule-add" label={t("sockscap.addManualRule")} icon={<Plus className="h-3.5 w-3.5" />} disabled={profileActionPending !== null} onClick={() => setOverrideRules((current) => [...current, createSockscapCustomRuleDraft()])} />
                <RuleButton testId="sockscap-manual-rules-save" label={t("common.save")} icon={<Save className="h-3.5 w-3.5" />} disabled={profileActionPending !== null || !overrideDirty} primary onClick={() => void saveOverrides()} />
              </div>
            </div>
            {overrideError && <RuleNotice tone="error">{overrideError}</RuleNotice>}
            {overrideNotice && <RuleNotice tone="success">{overrideNotice}</RuleNotice>}
            <p className="text-[9px] text-[var(--taomni-text-muted)]">{t("sockscap.firstMatchNotice")}</p>
            <div className="space-y-1.5">
              {overrideRules.map((rule, index) => (
                <div key={rule.id} data-testid="sockscap-manual-rule-row" data-rule-index={index} className="grid gap-2 rounded-md border p-2 md:grid-cols-[32px_110px_150px_minmax(0,1fr)_92px]" style={{ borderColor: "var(--taomni-card-border)" }}>
                  <label className="flex items-center justify-center"><input data-testid="sockscap-manual-rule-enabled" type="checkbox" aria-label={t("sockscap.ruleEnabled", { index: index + 1 })} checked={rule.enabled} onChange={(event) => updateRule(setOverrideRules, index, { enabled: event.target.checked })} /></label>
                  <select data-testid="sockscap-manual-rule-action" aria-label={t("sockscap.ruleAction", { index: index + 1 })} value={rule.action} onChange={(event) => updateRule(setOverrideRules, index, { action: event.target.value as SockscapCustomRuleDraft["action"] })} className={inputClass}>
                    <option value="direct">DIRECT</option><option value="proxy">PROXY</option><option value="block">BLOCK</option>
                  </select>
                  <select data-testid="sockscap-manual-rule-kind" aria-label={t("sockscap.ruleKind", { index: index + 1 })} value={rule.kind} onChange={(event) => updateRule(setOverrideRules, index, { kind: event.target.value as SockscapCustomRuleDraft["kind"] })} className={inputClass}>
                    <option value="domain_suffix">domain suffix</option><option value="domain_exact">domain exact</option><option value="domain_keyword">domain keyword</option><option value="ip_cidr">IP / CIDR</option>
                  </select>
                  <input data-testid={`sockscap-manual-rule-pattern-${index}`} data-rule-index={index} aria-label={t("sockscap.rulePattern", { index: index + 1 })} value={rule.pattern} onChange={(event) => updateRule(setOverrideRules, index, { pattern: event.target.value })} placeholder="example.com" className={inputClass} />
                  <div className="flex items-center justify-end gap-0.5">
                    <IconButton testId="sockscap-manual-rule-up" label={t("sockscap.moveRuleEarlier")} disabled={index === 0} onClick={() => setOverrideRules((current) => moveItem(current, index, index - 1))}><ArrowUp className="h-3.5 w-3.5" /></IconButton>
                    <IconButton testId="sockscap-manual-rule-down" label={t("sockscap.moveRuleLater")} disabled={index === overrideRules.length - 1} onClick={() => setOverrideRules((current) => moveItem(current, index, index + 1))}><ArrowDown className="h-3.5 w-3.5" /></IconButton>
                    <IconButton testId="sockscap-manual-rule-remove" label={t("common.remove")} disabled={false} onClick={() => setOverrideRules((current) => current.filter((_, candidate) => candidate !== index))}><Trash2 className="h-3.5 w-3.5" /></IconButton>
                  </div>
                </div>
              ))}
              {overrideRules.length === 0 && <p className="rounded-md border border-dashed py-6 text-center text-[10px] text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-card-border)" }}>{t("sockscap.noManualRules")}</p>}
            </div>
          </div>
        )}
      </RuleCard>

      <RuleCard title={t("sockscap.targetTesterTitle")} icon={<FlaskConical className="h-4 w-4" />}>
        <p className="mb-3 text-[10px] text-[var(--taomni-text-muted)]">{t("sockscap.targetTesterDescription")}</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <RuleField label={t("sockscap.applicationIdentity")}>
            <input data-testid="sockscap-target-app" value={targetDraft.appIdentity} onChange={(event) => setTargetDraft({ ...targetDraft, appIdentity: event.target.value })} placeholder={t("sockscap.optional")} className={inputClass} />
          </RuleField>
          <RuleField label={t("sockscap.selectorKind")}>
            <select data-testid="sockscap-target-selector-kind" value={targetDraft.appSelectorKind ?? "executable_path"} onChange={(event) => setTargetDraft({ ...targetDraft, appSelectorKind: event.target.value as SockscapTargetDraft["appSelectorKind"] })} className={inputClass}>
              <option value="executable_path">{t("sockscap.selectorExecutable")}</option><option value="macos_signing_identity">{t("sockscap.selectorSigningIdentity")}</option><option value="linux_cgroup">{t("sockscap.selectorCgroup")}</option>
            </select>
          </RuleField>
          <RuleField label="PID">
            <input data-testid="sockscap-target-pid" type="number" min={1} value={targetDraft.pid ?? ""} onChange={(event) => setTargetDraft({ ...targetDraft, pid: optionalNumber(event.target.value) })} placeholder={t("sockscap.optional")} className={inputClass} />
          </RuleField>
          <RuleField label={t("sockscap.processStartToken")}>
            <input data-testid="sockscap-target-process-start" type="number" min={1} value={targetDraft.processStartTime ?? ""} onChange={(event) => setTargetDraft({ ...targetDraft, processStartTime: optionalNumber(event.target.value) })} placeholder={t("sockscap.optional")} className={inputClass} />
          </RuleField>
          <RuleField label={t("sockscap.hostnameOrIp")}>
            <input data-testid="sockscap-target-host" value={targetDraft.target} onChange={(event) => setTargetDraft({ ...targetDraft, target: event.target.value })} className={inputClass} />
          </RuleField>
          <RuleField label={t("sockscap.port")}>
            <input data-testid="sockscap-target-port" type="number" min={1} max={65535} value={targetDraft.port} onChange={(event) => setTargetDraft({ ...targetDraft, port: numberValue(event.target.value) })} className={inputClass} />
          </RuleField>
          <RuleField label={t("sockscap.protocol")}>
            <select data-testid="sockscap-target-protocol" value={targetDraft.protocol} onChange={(event) => setTargetDraft({ ...targetDraft, protocol: event.target.value as SockscapTargetDraft["protocol"] })} className={inputClass}>
              <option value="tcp">TCP</option><option value="udp">UDP</option><option value="quic">QUIC</option>
            </select>
          </RuleField>
          <RuleField label={t("sockscap.hostnameSource")}>
            <select data-testid="sockscap-target-hostname-source" value={targetDraft.hostnameSource ?? "unknown"} onChange={(event) => setTargetDraft({ ...targetDraft, hostnameSource: event.target.value as SockscapTargetDraft["hostnameSource"] })} className={inputClass}>
              <option value="platform_remote_hostname">platform remote hostname</option><option value="fake_ip_dns_map">Fake-IP DNS map</option><option value="tls_sni">TLS SNI</option><option value="http_host">HTTP Host</option><option value="ip_only">IP only</option><option value="unknown">unknown</option>
            </select>
          </RuleField>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[10px]"><input data-testid="sockscap-target-hard-bypass" type="checkbox" checked={targetDraft.hardBypass} onChange={(event) => setTargetDraft({ ...targetDraft, hardBypass: event.target.checked })} />{t("sockscap.forceHardBypass")}</label>
          <RuleButton testId="sockscap-target-run" label={t("sockscap.runTargetTest")} icon={<FlaskConical className="h-3.5 w-3.5" />} disabled={ruleActionPending !== null} primary onClick={() => void runTargetTest()} />
        </div>
        {targetError && <RuleNotice tone="error">{targetError}</RuleNotice>}
        {targetResult && (
          <TargetResult
            result={targetResult}
            egress={resolveTargetEgress(targetResult, profiles, egressSessions)}
          />
        )}
      </RuleCard>
      {confirmDialog.render}
    </div>
  );
}

function RuleSourceStateView({ view }: { view: SockscapRuleSourceView }) {
  const t = useT();
  const state = view.state;
  if (!state) return <RuleNotice tone="warning">{t("sockscap.noLastGoodState")}</RuleNotice>;
  return (
    <div className="rounded-md border p-3" style={{ borderColor: "var(--taomni-card-border)" }} data-testid="sockscap-rule-source-state">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StateCell label={t("sockscap.lastSuccess")} value={state.lastSuccessUnix ? formatTime(state.lastSuccessUnix) : "—"} />
        <StateCell label={t("sockscap.activeMirror")} value={state.lastMirror ?? view.record.source.url ?? "—"} />
        <StateCell label="SHA-256" value={state.lastSha256 ? `${state.lastSha256.slice(0, 12)}…` : "—"} />
        <StateCell label={t("sockscap.nextRefresh")} value={state.refreshAfterUnix ? formatTime(state.refreshAfterUnix) : "—"} />
      </div>
      {state.parseStats && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StateCell label={t("sockscap.totalLines")} value={String(state.parseStats.totalLines)} />
          <StateCell label="PROXY" value={String(state.parseStats.proxyRules)} />
          <StateCell label="DIRECT" value={String(state.parseStats.directRules)} />
          <StateCell label={t("sockscap.unsupportedRules")} value={String(state.parseStats.unsupported)} />
          <StateCell label={t("sockscap.commentsIgnored")} value={String(state.parseStats.ignoredComments)} />
        </div>
      )}
      {state.lastError && <RuleNotice tone="warning">{state.lastError}</RuleNotice>}
    </div>
  );
}

function RefreshReport({ outcome }: { outcome: SockscapRefreshOutcome }) {
  const t = useT();
  return (
    <div className="rounded-md border p-3" style={{ borderColor: "var(--taomni-card-border)" }} data-testid="sockscap-refresh-report">
      <div className="flex items-center gap-2 text-[10px] font-semibold">
        {outcome.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-amber-600" />}
        {outcome.ok ? t("sockscap.compiledSnapshotReady") : outcome.usedLastGood ? t("sockscap.lastGoodPreserved") : t("sockscap.ruleRefreshFailed")}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <StateCell label={t("sockscap.activeMirror")} value={outcome.mirror ?? "—"} />
        <StateCell label="SHA-256" value={outcome.sha256 ? `${outcome.sha256.slice(0, 12)}…` : "—"} />
        <StateCell label={t("sockscap.cacheOutcome")} value={outcome.notModified ? "HTTP 304" : outcome.usedLastGood ? "last-good" : outcome.ok ? "atomic replace" : "rejected"} />
      </div>
      {outcome.report && (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StateCell label="PROXY" value={String(outcome.report.proxyRules.length)} />
            <StateCell label="DIRECT" value={String(outcome.report.directRules.length)} />
            <StateCell label={t("sockscap.unsupportedRules")} value={String(outcome.report.unsupported.length)} />
            <StateCell label={t("sockscap.totalLines")} value={String(outcome.report.totalLines)} />
          </div>
          {outcome.report.unsupported.length > 0 && (
            <div className="mt-2 space-y-1">
              {outcome.report.unsupported.slice(0, 5).map((rule, index) => (
                <div key={`${rule.original}-${index}`} className="rounded bg-black/5 px-2 py-1 font-mono text-[9px]">
                  {rule.original} · {rule.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {outcome.error && <RuleNotice tone="warning">{outcome.error}</RuleNotice>}
    </div>
  );
}

function TargetResult({ result, egress }: { result: SockscapTestTargetResult; egress: string | null }) {
  const t = useT();
  const decision = result.decision;
  return (
    <div className="mt-4 rounded-md border p-3" style={{ borderColor: "var(--taomni-card-border)" }} data-testid="sockscap-target-result">
      <div className="space-y-1.5">
        <DecisionStep index={1} title={t("sockscap.decisionSafety")} detail={decision?.matchedStage === "hard_bypass" ? t("sockscap.hardBypassMatched") : t("sockscap.hardBypassNotMatched")} />
        <DecisionStep index={2} title={t("sockscap.decisionProfile")} detail={result.selectedProfileName ? `${result.selectedProfileName} · ${result.selectionReason}` : result.selectionReason} />
        <DecisionStep index={3} title={t("sockscap.decisionHostname")} detail={decision?.hostnameSource.replaceAll("_", " ") ?? t("sockscap.noDecision")} />
        <DecisionStep index={4} title={t("sockscap.decisionRule")} detail={decision ? `${decision.matchedStage}${decision.matchedRuleOriginal ? ` · ${decision.matchedRuleOriginal}` : ""}${decision.matchedRuleSourceId ? ` · ${decision.matchedRuleSourceId}` : ""}` : t("sockscap.noDecision")} />
        <DecisionStep
          index={5}
          title={t("sockscap.decisionFinal")}
          detail={decision
            ? `${decision.action.toUpperCase()}${decision.action === "proxy" && egress ? ` · ${egress}` : ""}`
            : t("sockscap.noDecision")}
          final
        />
      </div>
      {result.conflicts.length > 0 && (
        <RuleNotice tone="error">{result.conflicts.map((conflict) => `${conflict.profileA}/${conflict.profileB}: ${conflict.reason}`).join("; ")}</RuleNotice>
      )}
      {result.notes.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[9px] text-[var(--taomni-text-muted)]">
          {result.notes.map((note, index) => <li key={`${note}-${index}`}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}

function DecisionStep({ index, title, detail, final = false }: { index: number; title: string; detail: string; final?: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-md border px-3 py-2" style={{ borderColor: final ? "var(--taomni-accent)" : "var(--taomni-card-border)", background: final ? "var(--taomni-selected)" : undefined }}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/5 text-[9px] font-semibold">{index}</span>
      <span className="min-w-0 flex-1"><strong className="block text-[10px]">{title}</strong><span className="block break-words text-[9px] text-[var(--taomni-text-muted)]">{detail}</span></span>
    </div>
  );
}

function StateCell({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded bg-black/[0.035] px-2 py-1.5"><span className="block text-[8px] uppercase tracking-wide text-[var(--taomni-text-muted)]">{label}</span><strong className="mt-0.5 block truncate text-[9px]">{value}</strong></div>;
}

function RuleCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border" style={{ background: "var(--taomni-card-bg)", borderColor: "var(--taomni-card-border)" }}>
      <header className="flex items-center gap-2 border-b px-4 py-3 text-[12px] font-semibold" style={{ borderColor: "var(--taomni-card-border)" }}><span className="text-[var(--taomni-accent)]">{icon}</span>{title}</header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function RuleField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1 block text-[9px] font-medium">{label}</span>{children}</label>;
}

function RuleButton({ label, icon, testId, disabled, primary = false, danger = false, onClick }: { label: string; icon?: ReactNode; testId?: string; disabled: boolean; primary?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" data-testid={testId} disabled={disabled} onClick={onClick} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-[9px] font-medium disabled:cursor-not-allowed disabled:opacity-45" style={primary ? { background: "var(--taomni-accent)", borderColor: "var(--taomni-accent)", color: "white" } : danger ? { borderColor: "rgba(220,38,38,.45)", color: "#b91c1c" } : { borderColor: "var(--taomni-input-border)", background: "var(--taomni-button-from)" }}>{icon}{label}</button>
  );
}

function IconButton({ label, disabled, onClick, children, testId }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return <button type="button" data-testid={testId} aria-label={label} disabled={disabled} onClick={onClick} className="rounded p-1 disabled:opacity-30">{children}</button>;
}

function RuleNotice({ tone, children }: { tone: "success" | "warning" | "error"; children: ReactNode }) {
  const style = tone === "success"
    ? { background: "var(--taomni-success-bg)", color: "var(--taomni-success-text)", borderColor: "rgba(16,185,129,.35)" }
    : tone === "warning"
      ? { background: "var(--taomni-warning-bg)", color: "var(--taomni-warning-text)", borderColor: "var(--taomni-warning-border)" }
      : { background: "rgba(220,38,38,.1)", color: "#b91c1c", borderColor: "rgba(220,38,38,.35)" };
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return <div className="mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[9px] leading-4" style={style}><Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />{children}</div>;
}

const inputClass = "h-8 w-full rounded-md border bg-transparent px-2.5 text-[10px] outline-none focus:border-[var(--taomni-accent)] disabled:cursor-not-allowed disabled:opacity-50";

function updateRule(
  setRules: React.Dispatch<React.SetStateAction<SockscapCustomRuleDraft[]>>,
  index: number,
  patch: Partial<SockscapCustomRuleDraft>,
) {
  setRules((current) => current.map((rule, candidate) => candidate === index ? { ...rule, ...patch } : rule));
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: string): number | null {
  return value.trim() ? numberValue(value) : null;
}

function formatTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveTargetEgress(
  result: SockscapTestTargetResult,
  profiles: SockscapPersistedRoutingProfile[],
  sessions: Array<{ id: string; name: string; protocol: string }>,
): string | null {
  if (!result.selectedProfileId) return null;
  const profile = profiles.find((record) => record.profile.id === result.selectedProfileId)?.profile;
  if (!profile?.egressRefId) return null;
  const session = sessions.find((candidate) => candidate.id === profile.egressRefId);
  return session ? `${session.name} · ${session.protocol.replaceAll("_", " ")}` : profile.egressRefId;
}

type Translator = ReturnType<typeof useT>;

function ruleSourceFieldLabel(t: Translator, field: string): string {
  if (field === "name") return t("sockscap.ruleSourceName");
  if (field === "url") return t("sockscap.ruleSourceUrl");
  if (field === "refreshIntervalSeconds") return t("sockscap.refreshIntervalHours");
  if (field === "kind") return t("sockscap.ruleSourceKind");
  return t("sockscap.ruleSourceId");
}
