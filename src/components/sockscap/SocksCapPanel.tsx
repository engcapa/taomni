import { useCallback, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  sockscapValidateMacosApp,
  sockscapListProcesses,
  type AppSelector,
  type ProcessInfo,
  type SocksCapConfig,
  type TargetTestResult,
  type UserRule,
} from "../../lib/sockscap";
import { type UpstreamConfigIssue } from "../../lib/sockscapPreflight";
import { type UpstreamChoice } from "./UpstreamSourcePicker";
import { useT } from "../../lib/i18n";
import { writeText } from "../../lib/clipboard";
import { open } from "@tauri-apps/plugin-dialog";
import { type Props, DEFAULT_PROFILE, profilesByPriority } from "./panel/configuration";
import { createSocksCapLifecycleActions } from "./panel/lifecycleActions";
import { createApplicationLaunch } from "./panel/applicationLaunch";
import { createProfileActions } from "./panel/createProfileActions";
import { createGfwActions } from "./panel/createGfwActions";
import { createTargetProbe } from "./panel/createTargetProbe";
import { createUpstreamPasswordActions } from "./panel/createUpstreamPasswordActions";
import { createUpstreamActions } from "./panel/createUpstreamActions";
import { createCoreParamsView } from "./panel/createCoreParamsView";
import { useRootlessApplicationDraft } from "./panel/useRootlessApplicationDraft";
import { useSocksCapRuntime } from "./panel/useSocksCapRuntime";
import { SocksCapView } from "./panel/SocksCapView";

export function SocksCapPanel({ onStatusMessage, onClose }: Props) {
  const t = useT();
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [launchingPath, setLaunchingPath] = useState<string | null>(null);
  const [stoppingPid, setStoppingPid] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; } | null>(null);
  const [testHost, setTestHost] = useState("www.google.com");
  const [testResult, setTestResult] = useState<TargetTestResult | null>(null);
  // Dedicated flag for in-flight tests so the test buttons lock (with a spinner)
  // independently of the global `busy` and the background status poll.
  const [testing, setTesting] = useState(false);
  // Full text of the last test, shown in a copyable modal (the status bar only
  // gets a short summary — long upstream diagnostics get truncated there).
  const [testDetail, setTestDetail] = useState<{ title: string; body: string; } | null>(null);
  const [testCopied, setTestCopied] = useState(false);
  const [newRule, setNewRule] = useState<UserRule>({
    pattern: "",
    action: "direct",
    comment: "",
  });
  const [showProcPicker, setShowProcPicker] = useState(false);
  const [password, setPassword] = useState("");
  const [storingPass, setStoringPass] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [uuidInput, setUuidInput] = useState("");
  const [wgKeyInput, setWgKeyInput] = useState("");
  const [subInput, setSubInput] = useState("");
  const [showSubImport, setShowSubImport] = useState(false);

  // Linux sudo prompt state. Keep the intent explicit so submitting a
  // recovery password can never accidentally start a new capture session.
  const [rootPromptIntent, setRootPromptIntent] = useState<"start" | "recover" | null>(null);
  const [rootPromptError, setRootPromptError] = useState<string | null>(null);
  const [rootPromptBusy, setRootPromptBusy] = useState(false);

  // Start-time pre-flight: probing upstreams before capture rewires the OS.
  const [probing, setProbing] = useState(false);
  // Active profiles whose upstream is unconfigured — blocks start entirely.
  const [configIssues, setConfigIssues] = useState<UpstreamConfigIssue[] | null>(null);
  // Upstreams that failed their reachability probe — offer force/cancel.
  const [probeFailures, setProbeFailures] = useState<
    { profileName: string; kind: string; error: string; }[] | null
  >(null);
  const [domainsExpanded, setDomainsExpanded] = useState(false);
  const [domainFilter, setDomainFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<"all" | "proxy" | "direct" | "block">("all");
  const [topNLimit, setTopNLimit] = useState(50);
  const startButtonRef = useRef<HTMLButtonElement | null>(null);

  // Resizable profile sidebar & ribbon collapse state
  const [sidebarWidth, setSidebarWidth] = useState(230);
  const [isRibbon, setIsRibbon] = useState(false);
  const isDraggingRef = useRef(false);

  const handleMouseDownSplitter = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;

    const onMouseMove = (moveEv: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = moveEv.clientX - startX;
      const nextW = startW + delta;
      if (nextW < 110) {
        setIsRibbon(true);
      } else {
        setIsRibbon(false);
        setSidebarWidth(Math.max(160, Math.min(420, nextW)));
      }
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  const report = useCallback(
    (text: string, ok = true) => {
      setMsg({ ok, text });
      onStatusMessage?.(text);
    },
    [onStatusMessage],
  );

  // Status bar / inline message is single-line and truncated, so collapse a
  // multi-line test result to its first non-empty line for the summary. The
  // full text goes to the copyable modal via openTestDetail.
  const summarize = (text: string): string => {
    const first = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return first || text.trim();
  };

  const openTestDetail = (title: string, body: string) => {
    setTestCopied(false);
    setTestDetail({ title, body });
  };

  const copyTestDetail = async () => {
    if (!testDetail) return;
    try {
      await writeText(testDetail.body);
      setTestCopied(true);
      report(t("common.copied"));
    } catch (e) {
      report(String(e), false);
    }
  };
  const runtime = useSocksCapRuntime({
    report,
  });
  const { cfg } = runtime;

  const running =
    runtime.status?.phase === "active" ||
    runtime.status?.phase === "degraded" ||
    runtime.status?.phase === "preparing";
  const linuxLaunchOnly =
    runtime.caps?.platform === "linux" && runtime.caps.linux?.launchOnly === true;
  const redirectorApprovalWaiting =
    runtime.caps?.platform === "macos" &&
    runtime.redirectorInstall?.systemExtensionState === "waitingForUser";

  // A capture session is an immutable snapshot on every platform. This also
  // covers the short Stopping phase so edits cannot race teardown.
  const locked = running || runtime.status?.phase === "stopping";

  const selectedProf = useMemo(() => {
    if (!cfg) return DEFAULT_PROFILE;
    return cfg.profiles.find((p) => p.id === cfg.selectedProfileId) || cfg.profiles[0] || DEFAULT_PROFILE;
  }, [cfg]);

  const activeProfiles = useMemo(() => {
    if (!cfg) return [DEFAULT_PROFILE];
    return profilesByPriority(
      cfg.profiles.filter((p) => p.enabled && cfg.activeProfileIds.includes(p.id)),
    ).map(({ profile }) => profile);
  }, [cfg]);

  const priorityOrderedProfiles = useMemo(
    () => (cfg ? profilesByPriority(cfg.profiles) : []),
    [cfg],
  );
  const {
    patchSelectedProfile,
    persistConfig,
    addProfile,
    selectProfile,
    onImportSubscription,
    toggleProfileActive,
    duplicateProfile,
    deleteProfile,
    moveProfilePriority,
    setProfilePriority,
  } = createProfileActions({
    locked,
    report,
    t,
    setCfg: runtime.setCfg,
    cfg: cfg,
    priorityOrderedProfiles,
    subInput,
    setBusy,
    setSubInput,
    setShowSubImport,
  });
  const {
    preflightAndStart,
    onStop,
    onRefreshStatus,
    onRecover,
    copyDiagnostics,
    refreshRedirectorApproval,
    installRedirector,
    continueMacosSetupToStart,
    onStart,
  } = createSocksCapLifecycleActions({
    setBusy,
    setStatus: runtime.setStatus,
    setStats: runtime.setStats,
    setHelper: runtime.setHelper,
    setGfw: runtime.setGfw,
    setDomainRecords: runtime.setDomainRecords,
    setRedirectorInstall: runtime.setRedirectorInstall,
    setLaunchedApps: runtime.setLaunchedApps,
    report,
    t,
    cfg: cfg,
    busy,
    probing,
    setConfigIssues,
    setProbing,
    linuxLaunchOnly,
    openTestDetail,
    setProbeFailures,
    caps: runtime.caps,
    setRootPromptIntent,
    setRootPromptError,
    setMacosSetupError: runtime.setMacosSetupError,
    setRootPromptBusy,
    setMacosSetupCompleted: runtime.setMacosSetupCompleted,
    setMacosSetupGuideMode: runtime.setMacosSetupGuideMode,
    refresh: runtime.refresh,
    startButtonRef,
  });
  const { onRefreshGfw, onImportGfw } = createGfwActions({
    cfg: cfg,
    locked,
    setBusy,
    setGfw: runtime.setGfw,
    report,
    t,
    setStatus: runtime.setStatus,
  });
  const { onTestTarget } = createTargetProbe({
    setTesting,
    testHost,
    setTestResult,
    t,
    report,
    openTestDetail,
  });
  const { storePassword, clearPassword } = createUpstreamPasswordActions({
    cfg: cfg,
    password,
    setStoringPass,
    t,
    report,
    patchSelectedProfile,
    selectedProf,
    setPassword,
  });
  const { storeUuid, patchUpstreamParams, storeWgKey, onImportShareLink, onTestUpstream } = createUpstreamActions({
    cfg: cfg,
    setTesting,
    t,
    selectedProf,
    password,
    report,
    summarize,
    openTestDetail,
    patchSelectedProfile,
    uuidInput,
    setBusy,
    setUuidInput,
    wgKeyInput,
    setWgKeyInput,
    shareLink,
    setShareLink,
    setPassword,
  });
  const { renderCoreParams } = createCoreParamsView({
    selectedProf,
    t,
    uuidInput,
    setUuidInput,
    storeUuid,
    busy,
    patchUpstreamParams,
    wgKeyInput,
    setWgKeyInput,
    storeWgKey,
    locked,
  });

  /** Detect a local proxy (Clash/v2rayN etc) and set it as the upstream in one
   *  click — no hand-filling host/port. Uses the first candidate found. */
  // Apply a picker choice to the selected profile's upstream.
  const onSelectUpstreamSource = (choice: UpstreamChoice) => {
    if (choice.source === "manual") {
      void patchSelectedProfile({
        upstream: { ...selectedProf.upstream, sessionId: "" },
      });
    } else if (choice.source === "session") {
      const s = choice.session;
      void patchSelectedProfile({
        upstream: {
          ...selectedProf.upstream,
          sessionId: s.id,
          host: s.host,
          port: s.port,
        },
      });
    } else {
      // Detected local proxy: adopt its detected kind + loopback host/port.
      const c = choice.candidate;
      void patchSelectedProfile({
        upstream: {
          ...selectedProf.upstream,
          kind: c.kind,
          sessionId: "",
          host: c.host,
          port: c.port,
        },
      });
    }
  };

  const loadProcesses = async () => {
    try {
      const list = await sockscapListProcesses();
      setProcesses(list);
      setShowProcPicker(true);
    } catch (e) {
      report(String(e), false);
    }
  };

  const addAppPath = async (
    path: string,
    name?: string,
  ): Promise<{ app: AppSelector; config: SocksCapConfig; } | null> => {
    if (!cfg || !path.trim()) return null;
    let candidate: AppSelector;
    try {
      candidate =
        runtime.caps?.platform === "macos"
          ? await sockscapValidateMacosApp(path)
          : { path, args: [], name: name || path.split(/[/\\]/).pop() || path };
    } catch (e) {
      report(String(e), false);
      return null;
    }
    const apps = [...selectedProf.apps];
    if (apps.some((a) => a.path.toLowerCase() === candidate.path.toLowerCase())) {
      return { app: candidate, config: cfg };
    }
    apps.push(candidate);
    const nextConfig = await patchSelectedProfile({ apps });
    return nextConfig ? { app: candidate, config: nextConfig } : null;
  };

  const pickMacosApplication = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "macOS Application", extensions: ["app"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      await addAppPath(selected);
    } catch (e) {
      report(String(e), false);
    }
  };

  const pickLinuxApplication = async () => {
    try {
      const selected = await open({ multiple: false });
      if (!selected || Array.isArray(selected)) return;
      await addAppPath(selected);
    } catch (e) {
      report(String(e), false);
    }
  };
  const rootlessDraft = useRootlessApplicationDraft({
    locked,
    report,
  });
  const {
    rootlessCommand,
    rootlessArguments,
    rootlessEnvironment,
    rootlessWorkingDirectory,
    rootlessPreCommand,
    rootlessLaunchShell,
    rootlessLaunchMode,
    editingRootlessAppKey,
    resetRootlessApplicationDraft,
  } = rootlessDraft;
  const { addRootlessApplication, onStopLaunchedApp, onRootlessLaunchApp } = createApplicationLaunch({
    cfg: cfg,
    locked,
    rootlessCommand,
    rootlessArguments,
    report,
    t,
    rootlessEnvironment,
    rootlessWorkingDirectory,
    rootlessPreCommand,
    rootlessLaunchShell,
    rootlessLaunchMode,
    selectedProf,
    editingRootlessAppKey,
    patchSelectedProfile,
    resetRootlessApplicationDraft,
    launchingPath,
    stoppingPid,
    setLaunchingPath,
    running,
    persistConfig,
    preflightAndStart,
    setLaunchedApps: runtime.setLaunchedApps,
    setStatus: runtime.setStatus,
    setStoppingPid,
    launchedApps: runtime.launchedApps,
    linuxLaunchOnly,
  });

  const addUserRule = async () => {
    if (!cfg || locked || !newRule.pattern.trim()) return;
    await patchSelectedProfile({
      userRules: [...selectedProf.userRules, { ...newRule, pattern: newRule.pattern.trim() }],
    });
    setNewRule({ pattern: "", action: "direct", comment: "" });
  };

  const filteredDomainRecords = useMemo(() => {
    let list = runtime.domainRecords;
    if (decisionFilter !== "all") {
      list = list.filter((r) => r.decision === decisionFilter);
    }
    if (domainFilter.trim()) {
      const q = domainFilter.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.domainOrIp.toLowerCase().includes(q) ||
          r.matchedRule?.toLowerCase().includes(q) ||
          r.profileName?.toLowerCase().includes(q) ||
          r.processName?.toLowerCase().includes(q) ||
          String(r.pid).includes(q),
      );
    }
    return list;
  }, [runtime.domainRecords, decisionFilter, domainFilter]);

  if (!cfg) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        {t("sockscap.loading")}
      </div>
    );
  }

  return <SocksCapView
    t={t}
    runtime={runtime}
    activeProfiles={activeProfiles}
    running={running}
    locked={locked}
    linuxLaunchOnly={linuxLaunchOnly}
    busy={busy}
    onStop={onStop}
    startButtonRef={startButtonRef}
    preflightAndStart={preflightAndStart}
    probing={probing}
    redirectorApprovalWaiting={redirectorApprovalWaiting}
    onRefreshStatus={onRefreshStatus}
    onRecover={onRecover}
    onClose={onClose}
    copyDiagnostics={copyDiagnostics}
    refreshRedirectorApproval={refreshRedirectorApproval}
    installRedirector={installRedirector}
    isRibbon={isRibbon}
    setIsRibbon={setIsRibbon}
    addProfile={addProfile}
    priorityOrderedProfiles={priorityOrderedProfiles}
    selectProfile={selectProfile}
    sidebarWidth={sidebarWidth}
    setShowSubImport={setShowSubImport}
    showSubImport={showSubImport}
    subInput={subInput}
    setSubInput={setSubInput}
    onImportSubscription={onImportSubscription}
    toggleProfileActive={toggleProfileActive}
    duplicateProfile={duplicateProfile}
    deleteProfile={deleteProfile}
    moveProfilePriority={moveProfilePriority}
    setProfilePriority={setProfilePriority}
    handleMouseDownSplitter={handleMouseDownSplitter}
    selectedProf={selectedProf}
    patchSelectedProfile={patchSelectedProfile}
    rootlessDraft={rootlessDraft}
    addRootlessApplication={addRootlessApplication}
    pickMacosApplication={pickMacosApplication}
    pickLinuxApplication={pickLinuxApplication}
    loadProcesses={loadProcesses}
    addAppPath={addAppPath}
    stoppingPid={stoppingPid}
    launchingPath={launchingPath}
    onStopLaunchedApp={onStopLaunchedApp}
    onRootlessLaunchApp={onRootlessLaunchApp}
    shareLink={shareLink}
    setShareLink={setShareLink}
    onImportShareLink={onImportShareLink}
    onSelectUpstreamSource={onSelectUpstreamSource}
    password={password}
    setPassword={setPassword}
    storePassword={storePassword}
    storingPass={storingPass}
    clearPassword={clearPassword}
    renderCoreParams={renderCoreParams}
    onTestUpstream={onTestUpstream}
    testing={testing}
    newRule={newRule}
    setNewRule={setNewRule}
    addUserRule={addUserRule}
    testHost={testHost}
    setTestHost={setTestHost}
    onTestTarget={onTestTarget}
    testResult={testResult}
    onRefreshGfw={onRefreshGfw}
    onImportGfw={onImportGfw}
    persistConfig={persistConfig}
    domainsExpanded={domainsExpanded}
    setDomainsExpanded={setDomainsExpanded}
    domainFilter={domainFilter}
    setDomainFilter={setDomainFilter}
    decisionFilter={decisionFilter}
    setDecisionFilter={setDecisionFilter}
    topNLimit={topNLimit}
    setTopNLimit={setTopNLimit}
    filteredDomainRecords={filteredDomainRecords}
    msg={msg}
    continueMacosSetupToStart={continueMacosSetupToStart}
    showProcPicker={showProcPicker}
    setShowProcPicker={setShowProcPicker}
    processes={processes}
    rootPromptIntent={rootPromptIntent}
    onStart={onStart}
    setRootPromptIntent={setRootPromptIntent}
    setRootPromptError={setRootPromptError}
    rootPromptError={rootPromptError}
    rootPromptBusy={rootPromptBusy}
    configIssues={configIssues}
    setConfigIssues={setConfigIssues}
    probeFailures={probeFailures}
    setProbeFailures={setProbeFailures}
    testDetail={testDetail}
    setTestDetail={setTestDetail}
    copyTestDetail={copyTestDetail}
    testCopied={testCopied}
  />;
}

export { SOCKSCAP_MACOS_SETUP_STORAGE_KEY } from "./panel/configuration";
