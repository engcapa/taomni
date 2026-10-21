import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, Info, Loader2, PanelLeftOpen, Plus, RefreshCw, Shield, X } from "lucide-react";
import { sockscapCapabilities, sockscapGetConfig, sockscapValidateMacosApp, sockscapGfwlistStatus, sockscapListProcesses, sockscapLaunchedApps, sockscapStatsSnapshot, sockscapStatus, sockscapGetDomainRecords, sockscapHelperStatus, sockscapDetectLocalProxies, sockscapDetectTunConflicts, sockscapRedirectorInstallStatus, type AppSelector, type LocalProxyCandidate, type DomainRecord, type GfwListStatus, type HelperStatus, type LaunchedAppInfo, type ProcessInfo, type RedirectorInstallStatus, type SocksCapCapabilities, type SocksCapConfig, type SocksCapStatus, type StatsSnapshot, type TargetTestResult, type UserRule } from "../../lib/sockscap";
import { type UpstreamConfigIssue } from "../../lib/sockscapPreflight";
import { SocksCapRootPrompt } from "./SocksCapRootPrompt";
import { SocksCapMacosSetupGuide } from "./SocksCapMacosSetupGuide";
import { type UpstreamChoice } from "./UpstreamSourcePicker";
import { listSessions } from "../../lib/ipc";
import { useT } from "../../lib/i18n";
import { writeText } from "../../lib/clipboard";
import { open } from "@tauri-apps/plugin-dialog";
import { type Props, type MacosSetupGuideMode, hasCompletedMacosSetup, type SessionOpt, normalizeFrontendConfig, DEFAULT_CFG, DEFAULT_PROFILE, profilesByPriority } from "./panel/configuration";
import { Field } from "./panel/Field";
import { Section } from "./panel/Section";
import { createSocksCapLifecycleActions } from "./panel/lifecycleActions";
import { createApplicationLaunch } from "./panel/applicationLaunch";
import { SocksCapHeader } from "./panel/SocksCapHeader";
import { ProfileSidebar } from "./panel/ProfileSidebar";
import { ApplicationsSection } from "./panel/ApplicationsSection";
import { UpstreamSection } from "./panel/UpstreamSection";
import { RulesSection } from "./panel/RulesSection";
import { TrafficSection } from "./panel/TrafficSection";
import { createProfileActions } from "./panel/createProfileActions";
import { createGfwActions } from "./panel/createGfwActions";
import { createTargetProbe } from "./panel/createTargetProbe";
import { createUpstreamPasswordActions } from "./panel/createUpstreamPasswordActions";
import { createUpstreamActions } from "./panel/createUpstreamActions";
import { createCoreParamsView } from "./panel/createCoreParamsView";
import { useRootlessApplicationDraft } from "./panel/useRootlessApplicationDraft";












export function SocksCapPanel({ onStatusMessage, onClose }: Props) {
  const t = useT();
  const [cfg, setCfg] = useState<SocksCapConfig | null>(null);
  const [caps, setCaps] = useState<SocksCapCapabilities | null>(null);
  const [status, setStatus] = useState<SocksCapStatus | null>(null);
  const [gfw, setGfw] = useState<GfwListStatus | null>(null);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [helper, setHelper] = useState<HelperStatus | null>(null);
  const [redirectorInstall, setRedirectorInstall] = useState<RedirectorInstallStatus | null>(null);
  const [macosSetupGuideMode, setMacosSetupGuideMode] =
    useState<MacosSetupGuideMode | null>(null);
  const [macosSetupCompleted, setMacosSetupCompleted] = useState(hasCompletedMacosSetup);
  const [macosSetupError, setMacosSetupError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionOpt[]>([]);
  const [detectedProxies, setDetectedProxies] = useState<LocalProxyCandidate[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [launchedApps, setLaunchedApps] = useState<LaunchedAppInfo[]>([]);
  const [launchingPath, setLaunchingPath] = useState<string | null>(null);
  const [stoppingPid, setStoppingPid] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testHost, setTestHost] = useState("www.google.com");
  const [testResult, setTestResult] = useState<TargetTestResult | null>(null);
  // Dedicated flag for in-flight tests so the test buttons lock (with a spinner)
  // independently of the global `busy` and the background status poll.
  const [testing, setTesting] = useState(false);
  // Full text of the last test, shown in a copyable modal (the status bar only
  // gets a short summary — long upstream diagnostics get truncated there).
  const [testDetail, setTestDetail] = useState<{ title: string; body: string } | null>(null);
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
  const [tunConflicts, setTunConflicts] = useState<string[]>([]);
  const [tunWarningOpen, setTunWarningOpen] = useState(false);
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
    { profileName: string; kind: string; error: string }[] | null
  >(null);

  // Traffic rates and domain tracking state
  const [domainRecords, setDomainRecords] = useState<DomainRecord[]>([]);
  const [domainsExpanded, setDomainsExpanded] = useState(false);
  const [domainFilter, setDomainFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<"all" | "proxy" | "direct" | "block">("all");
  const [topNLimit, setTopNLimit] = useState(50);
  const [upSpeed, setUpSpeed] = useState(0);
  const [downSpeed, setDownSpeed] = useState(0);
  const lastBytesRef = useRef<{ up: number; down: number; ts: number } | null>(null);
  const macosSetupAutoHandledRef = useRef(false);
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

  // Re-run local-proxy detection and refresh the picker's "detected" group.
  // Errors are reported but non-fatal (detection is best-effort). Declared here
  // (above the mount effect) so it can be an effect dependency.
  const rescanLocalProxies = useCallback(async () => {
    try {
      const detected = await sockscapDetectLocalProxies();
      setDetectedProxies(Array.isArray(detected) ? detected : []);
    } catch (e) {
      report(String(e), false);
    }
  }, [report]);

  const refresh = useCallback(async () => {
    try {
      const [c, cp, st, gf, sn, hp, drs, ri, launched] = await Promise.all([
        sockscapGetConfig().then(normalizeFrontendConfig).catch(() => DEFAULT_CFG),
        sockscapCapabilities().catch(() => null),
        sockscapStatus().catch(() => null),
        sockscapGfwlistStatus().catch(() => null),
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
        sockscapGetDomainRecords().catch(() => null),
        sockscapRedirectorInstallStatus().catch(() => null),
        sockscapLaunchedApps().catch(() => []),
      ]);
      setCfg(c);
      setCaps(cp);
      setStatus(st);
      setGfw(gf);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
      if (drs) setDomainRecords(drs);
      setRedirectorInstall(ri);
      setLaunchedApps(launched);
    } catch (e) {
      report(String(e), false);
    }
  }, [report]);

  useEffect(() => {
    void refresh();
    listSessions()
      .then((arr) => {
        // Only SSH and Proxy sessions can serve as an upstream. Everything else
        // (Local shells, File/folder, RDP/VNC, databases, object storage, mail…)
        // has no proxy endpoint to dial, so keep them out of the picker.
        const mapped: SessionOpt[] = arr.flatMap((s) => {
          const kind: "ssh" | "proxy" | null =
            s.session_type === "SSH" ? "ssh" : s.session_type === "Proxy" ? "proxy" : null;
          if (!kind) return [];
          return [{ id: s.id, name: s.name, host: s.host, port: s.port, kind, groupPath: s.group_path }];
        });
        setSessions(mapped);
      })
      .catch(() => setSessions([]));
    // Warn if a TUN-mode client is active (collides with global capture).
    sockscapDetectTunConflicts()
      .then((conflicts) => setTunConflicts(Array.isArray(conflicts) ? conflicts : []))
      .catch(() => setTunConflicts([]));
    // Populate the upstream picker's "detected local proxies" group.
    void rescanLocalProxies();
  }, [refresh, rescanLocalProxies]);

  useEffect(() => {
    if (
      caps?.platform !== "macos" ||
      !redirectorInstall ||
      macosSetupAutoHandledRef.current
    ) {
      return;
    }
    macosSetupAutoHandledRef.current = true;
    if (!macosSetupCompleted && redirectorInstall.state !== "ready") {
      setMacosSetupGuideMode("onboarding");
    }
  }, [caps?.platform, macosSetupCompleted, redirectorInstall]);

  useEffect(() => {
    if (!tunWarningOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTunWarningOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tunWarningOpen]);

  useEffect(() => {
    if (!status || status.phase === "idle") {
      lastBytesRef.current = null;
      setUpSpeed(0);
      setDownSpeed(0);
      return;
    }
    const timer = setInterval(() => {
      Promise.all([
        sockscapStatsSnapshot().catch(() => null),
        sockscapStatus().catch(() => null),
        sockscapHelperStatus().catch(() => null),
        sockscapGetDomainRecords().catch(() => null),
        sockscapLaunchedApps().catch(() => null),
      ])
        .then(([sn, st, hp, drs, launched]) => {
          if (st) setStatus(st);
          if (hp) setHelper(hp);
          if (drs) setDomainRecords(drs);
          if (launched) setLaunchedApps(launched);
          if (sn) {
            const now = Date.now();
            if (lastBytesRef.current) {
              const dt = (now - lastBytesRef.current.ts) / 1000;
              if (dt > 0.3) {
                const dup = Math.max(0, sn.bytesUp - lastBytesRef.current.up);
                const ddown = Math.max(0, sn.bytesDown - lastBytesRef.current.down);
                setUpSpeed(dup / dt);
                setDownSpeed(ddown / dt);
              }
            }
            lastBytesRef.current = { up: sn.bytesUp, down: sn.bytesDown, ts: now };
            setStats(sn);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [status]);

  const running =
    status?.phase === "active" ||
    status?.phase === "degraded" ||
    status?.phase === "preparing";
  const linuxLaunchOnly =
    caps?.platform === "linux" && caps.linux?.launchOnly === true;
  const redirectorApprovalWaiting =
    caps?.platform === "macos" &&
    redirectorInstall?.systemExtensionState === "waitingForUser";

  // A capture session is an immutable snapshot on every platform. This also
  // covers the short Stopping phase so edits cannot race teardown.
  const locked = running || status?.phase === "stopping";

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
  const { patchSelectedProfile, persistConfig, addProfile, selectProfile, onImportSubscription, toggleProfileActive, duplicateProfile, deleteProfile, moveProfilePriority, setProfilePriority } = createProfileActions({
    locked,
    report,
    t,
    setCfg,
    cfg,
    priorityOrderedProfiles,
    subInput,
    setBusy,
    setSubInput,
    setShowSubImport,
  });
  const { preflightAndStart, onStop, onRefreshStatus, onRecover, copyDiagnostics, refreshRedirectorApproval, installRedirector, continueMacosSetupToStart, onStart } = createSocksCapLifecycleActions({
    setBusy,
    setStatus,
    setStats,
    setHelper,
    setGfw,
    setDomainRecords,
    setRedirectorInstall,
    setLaunchedApps,
    report,
    t,
    cfg,
    busy,
    probing,
    setConfigIssues,
    setProbing,
    linuxLaunchOnly,
    openTestDetail,
    setProbeFailures,
    caps,
    setRootPromptIntent,
    setRootPromptError,
    setMacosSetupError,
    setRootPromptBusy,
    setMacosSetupCompleted,
    setMacosSetupGuideMode,
    refresh,
    startButtonRef,
  });
  const { onRefreshGfw, onImportGfw } = createGfwActions({
    cfg,
    locked,
    setBusy,
    setGfw,
    report,
    t,
    setStatus,
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
    cfg,
    password,
    setStoringPass,
    t,
    report,
    patchSelectedProfile,
    selectedProf,
    setPassword,
  });
  const { storeUuid, patchUpstreamParams, storeWgKey, onImportShareLink, onTestUpstream } = createUpstreamActions({
    cfg,
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
  ): Promise<{ app: AppSelector; config: SocksCapConfig } | null> => {
    if (!cfg || !path.trim()) return null;
    let candidate: AppSelector;
    try {
      candidate =
        caps?.platform === "macos"
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
  const { rootlessCommand, rootlessArguments, rootlessEnvironment, rootlessWorkingDirectory, rootlessPreCommand, rootlessLaunchShell, rootlessLaunchMode, editingRootlessAppKey, resetRootlessApplicationDraft } = rootlessDraft;
  const { addRootlessApplication, onStopLaunchedApp, onRootlessLaunchApp } = createApplicationLaunch({
    cfg,
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
    setLaunchedApps,
    setStatus,
    setStoppingPid,
    launchedApps,
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
    let list = domainRecords;
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
  }, [domainRecords, decisionFilter, domainFilter]);

  if (!cfg) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        {t("sockscap.loading")}
      </div>
    );
  }

  return (
    <div
      className="sockscap-panel relative h-full flex flex-col bg-[var(--taomni-panel-bg)] text-[var(--taomni-text)]"
      data-testid="sockscap-panel"
    >
      {/* Header */}
      <SocksCapHeader
  t={t}
  caps={caps}
  activeProfiles={activeProfiles}
  stats={stats}
  helper={helper}
  running={running}
  upSpeed={upSpeed}
  downSpeed={downSpeed}
  locked={locked}
  linuxLaunchOnly={linuxLaunchOnly}
  tunConflicts={tunConflicts}
  setTunWarningOpen={setTunWarningOpen}
  status={status}
  busy={busy}
  onStop={onStop}
  startButtonRef={startButtonRef}
  preflightAndStart={preflightAndStart}
  probing={probing}
  redirectorApprovalWaiting={redirectorApprovalWaiting}
  setMacosSetupError={setMacosSetupError}
  setMacosSetupGuideMode={setMacosSetupGuideMode}
  onRefreshStatus={onRefreshStatus}
  onRecover={onRecover}
  onClose={onClose}
/>

      {status?.phase === "recoveryRequired" && caps?.platform === "macos" && (
        <div className="px-4 py-3 bg-red-500/10 border-b border-red-500/30 text-[11px] text-red-700 dark:text-red-300">
          <div className="font-semibold">{t("sockscap.manualRecoveryTitle")}</div>
          <div className="mt-1">{status.message}</div>
          <ol className="mt-2 ml-4 list-decimal space-y-1">
            <li>{t("sockscap.manualRecoveryStep1")}</li>
            <li>{t("sockscap.manualRecoveryStep2")}</li>
            <li>{t("sockscap.manualRecoveryStep3")}</li>
          </ol>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded border border-red-500/40 hover:bg-red-500/10"
            onClick={() => void copyDiagnostics()}
          >
            <Copy className="w-3 h-3" />
            {t("sockscap.copyDiagnostics")}
          </button>
        </div>
      )}

      {caps?.platform === "macos" && redirectorInstall?.state !== "ready" && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-[11px] flex flex-wrap items-center justify-between gap-2 text-amber-800 dark:text-amber-300">
          <span>{redirectorInstall?.message || t("sockscap.redirectorMissing")}</span>
          <button
            type="button"
            data-testid="sockscap-redirector-action"
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-50"
            disabled={
              busy ||
              (redirectorInstall?.state !== "pendingSystemApproval" &&
                (!redirectorInstall?.resourceAvailable ||
                  redirectorInstall?.state === "conflict"))
            }
            onClick={() =>
              void (redirectorInstall?.state === "pendingSystemApproval"
                ? refreshRedirectorApproval()
                : installRedirector())
            }
          >
            {busy ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : redirectorInstall?.state === "pendingSystemApproval" ? (
              <RefreshCw className="w-3 h-3" />
            ) : (
              <Shield className="w-3 h-3" />
            )}
            {redirectorInstall?.state === "pendingSystemApproval"
              ? t("sockscap.refreshRedirectorApproval")
              : t("sockscap.installRedirector")}
          </button>
        </div>
      )}

      {linuxLaunchOnly && (
        <div
          data-testid="sockscap-launch-only-banner"
          className="px-4 py-2 bg-sky-500/10 border-b border-sky-500/30 text-[11px] text-sky-800 dark:text-sky-300"
          title={caps.linux?.transparentUnavailableReason || undefined}
        >
          <div className="flex items-start gap-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">
                {t("sockscap.launchOnlyTitle")}
              </div>
              <div>{t("sockscap.launchOnlyDescription")}</div>
              {caps.linux?.containerized && (
                <div className="mt-0.5">{t("sockscap.launchOnlyContainer")}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Dual-Column Content Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left Column: Profile Manager Sidebar */}
        {!linuxLaunchOnly &&
          (isRibbon ? (
            <div
            className="w-[52px] shrink-0 flex flex-col items-center bg-[var(--taomni-panel-bg)] py-3 px-1 space-y-3 border-r border-[var(--taomni-divider)] select-none"
            data-testid="sockscap-profile-list"
          >
            <div className="flex flex-col items-center gap-1 shrink-0 pb-2 border-b border-[var(--taomni-divider)] w-full">
              <button
                type="button"
                className="p-1.5 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] transition-colors"
                onClick={() => setIsRibbon(false)}
                title={t("sockscap.expandProfiles")}
                aria-label={t("sockscap.expandProfiles")}
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
              <button
                type="button"
                data-testid="sockscap-add-profile"
                className="p-1.5 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => void addProfile()}
                disabled={locked}
                title={locked ? t("sockscap.lockedTooltip") : t("sockscap.newProfileTooltip")}
                aria-label={t("sockscap.newProfileTooltip")}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 flex-1 overflow-y-auto w-full flex flex-col items-center">
              {priorityOrderedProfiles.map(({ profile: p }) => {
                const isSelected = p.id === cfg.selectedProfileId;
                const isActive = p.enabled && cfg.activeProfileIds.includes(p.id);
                return (
                  <div
                    key={p.id}
                    data-testid={`sockscap-profile-item-${p.id}`}
                    className={`w-9 h-9 rounded-lg border flex items-center justify-center relative cursor-pointer transition-all ${
                      isSelected
                        ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/20 shadow-sm"
                        : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] bg-[var(--taomni-bg)]"
                    }`}
                    onClick={() => selectProfile(p.id)}
                    onDoubleClick={() => setIsRibbon(false)}
                    title={`${p.name} - ${p.mode === "global" ? t("sockscap.scopeGlobal") : t("sockscap.appsBound", { count: p.apps.length })} (${isActive ? t("sockscap.activeTooltipActive") : t("sockscap.activeTooltipInactive")})`}
                  >
                    <span className="text-base select-none">{p.icon || "🛡️"}</span>
                    {isActive && (
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 absolute -top-0.5 -right-0.5 ring-2 ring-[var(--taomni-panel-bg)]" />
                    )}
                  </div>
                );
              })}
            </div>
            </div>
          ) : (
            <ProfileSidebar
  sidebarWidth={sidebarWidth}
  t={t}
  addProfile={addProfile}
  locked={locked}
  setIsRibbon={setIsRibbon}
  setShowSubImport={setShowSubImport}
  showSubImport={showSubImport}
  subInput={subInput}
  setSubInput={setSubInput}
  onImportSubscription={onImportSubscription}
  busy={busy}
  priorityOrderedProfiles={priorityOrderedProfiles}
  cfg={cfg}
  selectProfile={selectProfile}
  toggleProfileActive={toggleProfileActive}
  duplicateProfile={duplicateProfile}
  deleteProfile={deleteProfile}
  moveProfilePriority={moveProfilePriority}
  setProfilePriority={setProfilePriority}
/>
          ))}

        {/* Resizable Handle / Splitter */}
        {!linuxLaunchOnly && !isRibbon && (
          <div
            className="w-1 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/40 active:bg-[var(--taomni-accent)] transition-colors shrink-0 z-10 self-stretch"
            onMouseDown={handleMouseDownSplitter}
            title="Drag to resize panel"
          />
        )}

        {/* Right Column: Selected Profile Detail & Inspector */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {linuxLaunchOnly && (
            <section
              data-testid="sockscap-rootless-mode"
              className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3"
            >
              <div className="text-[13px] font-semibold">
                {t("sockscap.rootlessModeTitle")}
              </div>
              <p className="mt-1 text-[11px] leading-5 text-[var(--taomni-text-muted)]">
                {t("sockscap.rootlessModeDescription")}
              </p>
              {caps?.linux?.containerized && (
                <p className="mt-1 text-[11px] text-sky-700 dark:text-sky-300">
                  {t("sockscap.launchOnlyContainer")}
                </p>
              )}
            </section>
          )}

          {/* Profile Basic info header */}
          {!linuxLaunchOnly && (
            <Section sectionId="profile" title={t("sockscap.editProfileTitle", { name: selectedProf.name })}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label={t("sockscap.profileNameLabel")}>
                  <input
                    className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
                    value={selectedProf.name}
                    disabled={locked}
                    title={locked ? t("sockscap.lockedTooltip") : undefined}
                    onChange={(e) => void patchSelectedProfile({ name: e.target.value })}
                  />
                </Field>
                <Field label={t("sockscap.profileIconLabel")}>
                  <div className="flex gap-1.5">
                    {["🎮", "💻", "🎬", "🌐", "⚡", "🛡️"].map((ic) => (
                      <button
                        key={ic}
                        type="button"
                        disabled={locked}
                        title={locked ? t("sockscap.lockedTooltip") : undefined}
                        className={`px-2 py-1 rounded text-[13px] border disabled:opacity-50 disabled:cursor-not-allowed ${
                          selectedProf.icon === ic
                            ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/20"
                            : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                        }`}
                        onClick={() => void patchSelectedProfile({ icon: ic })}
                      >
                        {ic}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            </Section>
          )}

          {/* Scope Mode */}
          <ApplicationsSection
  draft={rootlessDraft}
  linuxLaunchOnly={linuxLaunchOnly}
  t={t}
  caps={caps}
  locked={locked}
  selectedProf={selectedProf}
  patchSelectedProfile={patchSelectedProfile}

  addRootlessApplication={addRootlessApplication}


  pickMacosApplication={pickMacosApplication}
  pickLinuxApplication={pickLinuxApplication}
  loadProcesses={loadProcesses}
  addAppPath={addAppPath}
  launchedApps={launchedApps}
  cfg={cfg}
  stoppingPid={stoppingPid}
  launchingPath={launchingPath}
  onStopLaunchedApp={onStopLaunchedApp}
  running={running}
  busy={busy}
  probing={probing}
  onRootlessLaunchApp={onRootlessLaunchApp}

/>

          {/* Upstream */}
          <UpstreamSection
  t={t}
  linuxLaunchOnly={linuxLaunchOnly}
  detectedProxies={detectedProxies}
  selectedProf={selectedProf}
  locked={locked}
  patchSelectedProfile={patchSelectedProfile}
  shareLink={shareLink}
  setShareLink={setShareLink}
  onImportShareLink={onImportShareLink}
  busy={busy}
  sessions={sessions}
  onSelectUpstreamSource={onSelectUpstreamSource}
  rescanLocalProxies={rescanLocalProxies}
  password={password}
  setPassword={setPassword}
  storePassword={storePassword}
  storingPass={storingPass}
  clearPassword={clearPassword}
  renderCoreParams={renderCoreParams}
  onTestUpstream={onTestUpstream}
  testing={testing}
/>

          {/* Rules Strategy */}
          <RulesSection
  t={t}
  linuxLaunchOnly={linuxLaunchOnly}
  locked={locked}
  selectedProf={selectedProf}
  patchSelectedProfile={patchSelectedProfile}
  newRule={newRule}
  setNewRule={setNewRule}
  addUserRule={addUserRule}
/>

          {/* Test Target Dry-run */}
          {!linuxLaunchOnly && (
            <Section sectionId="test" title={t("sockscap.section.test")}>
              <div className="flex gap-2 items-center">
                <input
                  data-testid="sockscap-test-host"
                  className="flex-1 text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                  value={testHost}
                  onChange={(e) => setTestHost(e.target.value)}
                />
                <button
                  type="button"
                  data-testid="sockscap-test-target"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={() => void onTestTarget()}
                  disabled={busy || testing}
                >
                  {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {testing ? t("sockscap.testing") : t("sockscap.testTarget")}
                </button>
              </div>
              {testResult && (
                <div className="mt-2 p-2 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)] text-[11px]">
                  <span className="font-semibold">{testResult.host}: </span>
                  <span className="uppercase font-medium text-[var(--taomni-accent)]">
                    {testResult.decision}
                  </span>{" "}
                  · {testResult.reason}
                </div>
              )}
            </Section>
          )}

          {/* Global GFWList & Shared Controls */}
          <Section
            sectionId="gfwlist"
            title={t("sockscap.gfwListTitle")}
            defaultExpanded={linuxLaunchOnly}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-[var(--taomni-text-muted)]">
                {gfw?.loaded
                  ? t("sockscap.gfwStatus", {
                      count: String(gfw.ruleCount),
                      skipped: String(gfw.skipped),
                      when: gfw.lastRefresh
                        ? new Date(gfw.lastRefresh).toLocaleString()
                        : t("common.justNow"),
                    })
                  : t("sockscap.gfwNotLoaded")}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="sockscap-refresh-gfw"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => void onRefreshGfw()}
                  disabled={busy || locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                >
                  <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} />
                  {t("sockscap.refreshGfw")}
                </button>
                <button
                  type="button"
                  data-testid="sockscap-import-gfw"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => void onImportGfw()}
                  disabled={busy || locked}
                  title={locked ? t("sockscap.lockedTooltip") : undefined}
                >
                  {t("sockscap.importGfw")}
                </button>
              </div>
            </div>

            {/* Session-level QUIC blocking (forces QUIC→TCP so capture can proxy it). */}
            <label
              className="mt-3 flex items-start gap-2 text-[12px] cursor-pointer select-none"
              title={locked ? t("sockscap.lockedTooltip") : undefined}
            >
              <input
                type="checkbox"
                data-testid="sockscap-block-quic"
                checked={cfg.blockQuic ?? true}
                disabled={locked || busy}
                onChange={(e) => {
                  if (!cfg) return;
                  void persistConfig({ ...cfg, blockQuic: e.target.checked });
                }}
                className="mt-0.5 rounded border-[var(--taomni-divider)] text-[var(--taomni-accent)] focus:ring-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <span className="flex-1">
                <span className="font-medium text-[var(--taomni-text)]">
                  {t("sockscap.blockQuic")}
                </span>
                <span className="block text-[11px] text-[var(--taomni-text-muted)]">
                  {t("sockscap.blockQuicHint")}
                </span>
              </span>
            </label>
          </Section>

          {/* Captured Domains & Traffic Table */}
          <TrafficSection
  domainsExpanded={domainsExpanded}
  setDomainsExpanded={setDomainsExpanded}
  domainRecords={domainRecords}
  domainFilter={domainFilter}
  setDomainFilter={setDomainFilter}
  decisionFilter={decisionFilter}
  setDecisionFilter={setDecisionFilter}
  topNLimit={topNLimit}
  setTopNLimit={setTopNLimit}
  setDomainRecords={setDomainRecords}
  filteredDomainRecords={filteredDomainRecords}
  locked={locked}
  t={t}
  cfg={cfg}
  selectedProf={selectedProf}
  patchSelectedProfile={patchSelectedProfile}
/>

          {msg && (
            <div
              className={`mt-2 text-[11px] flex gap-1 items-start ${
                msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"
              }`}
            >
              {msg.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              )}
              {msg.text}
            </div>
          )}
        </div>
      </div>

      {macosSetupGuideMode && caps?.platform === "macos" && (
        <SocksCapMacosSetupGuide
          mode={macosSetupGuideMode}
          installStatus={redirectorInstall}
          captureReady={status?.phase === "active" || status?.phase === "degraded"}
          completed={macosSetupCompleted}
          busy={busy}
          error={macosSetupError}
          onClose={() => setMacosSetupGuideMode(null)}
          onInstall={() => void installRedirector()}
          onRefreshApproval={() => void refreshRedirectorApproval()}
          onContinueToStart={continueMacosSetupToStart}
        />
      )}

      {showProcPicker && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20">
          <div className="w-[min(520px,90vw)] max-h-[70vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--taomni-divider)]">
              <div className="text-[13px] font-semibold">{t("sockscap.pickProcess")}</div>
              <button type="button" className="p-1" onClick={() => setShowProcPicker(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-2">
              {processes.length === 0 ? (
                <div className="text-[11px] text-[var(--taomni-text-muted)] p-2">
                  {t("sockscap.processesEmpty")}
                </div>
              ) : (
                processes.map((p) => (
                  <button
                    key={`${p.pid}-${p.path}`}
                    type="button"
                    className="w-full text-left px-2 py-1.5 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
                    onClick={() => {
                      void addAppPath(p.path || p.name, p.name);
                      setShowProcPicker(false);
                    }}
                  >
                    <div className="font-medium">{p.name || p.pid}</div>
                    <div className="text-[var(--taomni-text-muted)] truncate">{p.path}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {tunWarningOpen && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
          onClick={() => setTunWarningOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sockscap-tun-warning-title"
            data-testid="sockscap-tun-warning-dialog"
            className="w-[min(520px,92vw)] rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <h2 id="sockscap-tun-warning-title" className="flex-1 text-[13px] font-semibold">
                {t("sockscap.tunConflictTitle")}
              </h2>
              <button
                type="button"
                data-testid="sockscap-tun-warning-close"
                className="p-1 rounded text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
                aria-label={t("common.close")}
                onClick={() => setTunWarningOpen(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="px-4 py-3 text-[12px] leading-5 text-[var(--taomni-text-muted)]">
              {t("sockscap.tunConflictWarning", { adapters: tunConflicts.join(", ") })}
            </p>
          </div>
        </div>
      )}

      {rootPromptIntent && (
        <SocksCapRootPrompt
          subtitle={
            rootPromptIntent === "recover"
              ? t("sockscap.rootPromptRecoverSubtitle")
              : undefined
          }
          onSubmit={(password) => {
            if (rootPromptIntent === "recover") void onRecover(password);
            else void onStart(password);
          }}
          onCancel={() => {
            setRootPromptIntent(null);
            setRootPromptError(null);
          }}
          error={rootPromptError}
          busy={rootPromptBusy}
        />
      )}

      {/* Pre-flight: an active profile's upstream is empty → cannot start. */}
      {configIssues && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
          data-testid="sockscap-config-issue-dialog"
        >
          <div className="w-[min(480px,92vw)] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <div className="text-[13px] font-semibold">
                {t("sockscap.configIssueTitle")}
              </div>
            </div>
            <div className="px-4 py-3 space-y-2 text-[12px]">
              <div className="text-[var(--taomni-text-muted)]">
                {t("sockscap.configIssueIntro")}
              </div>
              <ul className="space-y-1.5">
                {configIssues.map((iss) => (
                  <li
                    key={iss.profileId}
                    className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                  >
                    <X className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                    <span>
                      <span className="font-semibold">{iss.profileName}</span>
                      {" — "}
                      {t(`sockscap.${iss.reasonKey}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--taomni-divider)]">
              <button
                type="button"
                data-testid="sockscap-config-issue-ok"
                className="px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
                onClick={() => setConfigIssues(null)}
              >
                {t("common.ok")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-flight: upstream probe failed → force start or cancel. */}
      {probeFailures && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-30"
          data-testid="sockscap-probe-fail-dialog"
        >
          <div className="w-[min(560px,92vw)] max-h-[75vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--taomni-divider)]">
              <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
              <div className="text-[13px] font-semibold">
                {t("sockscap.probeFailTitle")}
              </div>
            </div>
            <div className="px-4 py-3 space-y-2 text-[12px] overflow-auto">
              <div className="text-[var(--taomni-text-muted)]">
                {t("sockscap.probeFailIntro")}
              </div>
              <ul className="space-y-1.5">
                {probeFailures.map((f, i) => (
                  <li
                    key={`${f.profileName}-${i}`}
                    className="px-2 py-1.5 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                  >
                    <div className="font-semibold flex items-center gap-1.5">
                      <span>{f.profileName}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] uppercase bg-[var(--taomni-hover)] font-mono">
                        {f.kind}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-red-500 break-words whitespace-pre-wrap">
                      {f.error}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="text-[11px] text-[var(--taomni-text-muted)]">
                {t("sockscap.probeFailHint")}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--taomni-divider)]">
              <button
                type="button"
                data-testid="sockscap-probe-fail-cancel"
                className="px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                onClick={() => setProbeFailures(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                data-testid="sockscap-probe-fail-force"
                className="px-3 py-1.5 rounded text-[12px] bg-amber-600 text-white hover:bg-amber-500"
                onClick={() => {
                  setProbeFailures(null);
                  void onStart();
                }}
              >
                {t("sockscap.probeFailForce")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full test result — status bar only shows a summary; this shows the
          complete text and lets the user copy it. */}
      {testDetail && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-20"
          data-testid="sockscap-test-detail"
        >
          <div className="w-[min(620px,92vw)] max-h-[75vh] flex flex-col rounded-lg bg-[var(--taomni-panel-bg)] border border-[var(--taomni-divider)] shadow-xl">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--taomni-divider)]">
              <div className="text-[13px] font-semibold truncate">{testDetail.title}</div>
              <button
                type="button"
                className="p-1 rounded hover:bg-[var(--taomni-hover)]"
                onClick={() => setTestDetail(null)}
                aria-label={t("common.close")}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <pre
                data-testid="sockscap-test-detail-body"
                className="whitespace-pre-wrap break-words text-[11px] font-mono text-[var(--taomni-text)] leading-relaxed"
              >
                {testDetail.body}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[var(--taomni-divider)]">
              <button
                type="button"
                data-testid="sockscap-test-detail-copy"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                onClick={() => void copyTestDetail()}
              >
                {testCopied ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {testCopied ? t("common.copied") : t("common.copy")}
              </button>
              <button
                type="button"
                data-testid="sockscap-test-detail-close"
                className="px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
                onClick={() => setTestDetail(null)}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}











export { SOCKSCAP_MACOS_SETUP_STORAGE_KEY } from "./panel/configuration";
