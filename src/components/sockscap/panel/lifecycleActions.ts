import { sockscapGfwlistStatus, sockscapRecover, sockscapSetConfig, sockscapStart, sockscapLaunchedApps, sockscapStatsSnapshot, sockscapStatus, sockscapStop, sockscapGetDomainRecords, sockscapHelperStatus, sockscapTestUpstream, sockscapTestCoreUpstream, sockscapDiagnostics, sockscapInstallRedirector, sockscapRedirectorInstallStatus, upstreamRequiresCore, type DomainRecord, type GfwListStatus, type HelperStatus, type LaunchedAppInfo, type RedirectorInstallStatus, type SocksCapCapabilities, type SocksCapConfig, type SocksCapStatus, type StatsSnapshot } from "../../../lib/sockscap";
import { collectProbeTargets, collectUpstreamConfigIssues, type ProbeTarget, type UpstreamConfigIssue } from "../../../lib/sockscapPreflight";
import { writeText } from "../../../lib/clipboard";
import { type MacosSetupGuideMode, needsStartElevation, SOCKSCAP_MACOS_SETUP_STORAGE_KEY, isRootRequiredError, isSudoAuthenticationError, needsRecoveryElevation } from "./configuration";


export interface CreateSocksCapLifecycleActionsContext {
  setBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setStatus: import("react").Dispatch<import("react").SetStateAction<SocksCapStatus | null>>;
  setStats: import("react").Dispatch<import("react").SetStateAction<StatsSnapshot | null>>;
  setHelper: import("react").Dispatch<import("react").SetStateAction<HelperStatus | null>>;
  setGfw: import("react").Dispatch<import("react").SetStateAction<GfwListStatus | null>>;
  setDomainRecords: import("react").Dispatch<import("react").SetStateAction<DomainRecord[]>>;
  setRedirectorInstall: import("react").Dispatch<import("react").SetStateAction<RedirectorInstallStatus | null>>;
  setLaunchedApps: import("react").Dispatch<import("react").SetStateAction<LaunchedAppInfo[]>>;
  report: (text: string, ok?: boolean) => void;
  t: import("../../../lib/i18n").TranslateFn;
  cfg: SocksCapConfig | null;
  busy: boolean;
  probing: boolean;
  setConfigIssues: import("react").Dispatch<import("react").SetStateAction<UpstreamConfigIssue[] | null>>;
  setProbing: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  linuxLaunchOnly: boolean;
  openTestDetail: (title: string, body: string) => void;
  setProbeFailures: import("react").Dispatch<import("react").SetStateAction<{ profileName: string; kind: string; error: string; }[] | null>>;
  caps: SocksCapCapabilities | null;
  setRootPromptIntent: import("react").Dispatch<import("react").SetStateAction<"start" | "recover" | null>>;
  setRootPromptError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setMacosSetupError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setRootPromptBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setMacosSetupCompleted: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setMacosSetupGuideMode: import("react").Dispatch<import("react").SetStateAction<MacosSetupGuideMode | null>>;
  refresh: () => Promise<void>;
  startButtonRef: import("react").RefObject<HTMLButtonElement | null>;
}

export function createSocksCapLifecycleActions(context: CreateSocksCapLifecycleActionsContext) {
  const { setBusy, setStatus, setStats, setHelper, setGfw, setDomainRecords, setRedirectorInstall, setLaunchedApps, report, t, cfg, busy, probing, setConfigIssues, setProbing, linuxLaunchOnly, openTestDetail, setProbeFailures, caps, setRootPromptIntent, setRootPromptError, setMacosSetupError, setRootPromptBusy, setMacosSetupCompleted, setMacosSetupGuideMode, refresh, startButtonRef } = context;

  const onRefreshStatus = async () => {
    setBusy(true);
    try {
      const [st, sn, hp, gf, drs, ri, launched] = await Promise.all([
        sockscapStatus().catch(() => null),
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
        sockscapGfwlistStatus().catch(() => null),
        sockscapGetDomainRecords().catch(() => null),
        sockscapRedirectorInstallStatus().catch(() => null),
        sockscapLaunchedApps().catch(() => []),
      ]);
      if (st) setStatus(st);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
      if (gf) setGfw(gf);
      if (drs) setDomainRecords(drs);
      if (ri) setRedirectorInstall(ri);
      setLaunchedApps(launched);
      report(t("sockscap.statusRefreshed"));
    } finally {
      setBusy(false);
    }
  };

  // Probe a single upstream the same way the "Test upstream" button does —
  // core kinds spin up a throwaway xray sidecar; native kinds dial directly.
  // Uses the stored passwordRef (what a real start dials with), not the typed
  // password. Throws on failure so the caller can collect it.
  const probeUpstream = async (target: ProbeTarget): Promise<void> => {
    const u = target.upstream;
    if (upstreamRequiresCore(u.kind)) {
      await sockscapTestCoreUpstream({
        upstream: u,
        testHost: "www.google.com",
        testPort: 443,
      });
    } else {
      await sockscapTestUpstream({
        kind: u.kind,
        host: u.host || "127.0.0.1",
        port: u.port || 1080,
        username: u.username,
        password: u.passwordRef || undefined,
        sessionId: u.sessionId || undefined,
        testHost: "www.google.com",
        testPort: 443,
      });
    }
  };

  // Start button entry point: reject unconfigured upstreams, probe configured
  // ones, and only then start. A probe failure surfaces a force/cancel prompt.
  const preflightAndStart = async (
    configOverride?: SocksCapConfig,
  ): Promise<boolean> => {
    const startConfig = configOverride ?? cfg;
    if (!startConfig || busy || probing) return false;

    // 1) Empty upstream(s) → block start, tell the user which profile.
    const issues = collectUpstreamConfigIssues(startConfig);
    if (issues.length > 0) {
      setConfigIssues(issues);
      return false;
    }

    // 2) Probe every configured active upstream in parallel.
    const targets = collectProbeTargets(startConfig);
    if (targets.length === 0) {
      return onStart(undefined, startConfig);
    }
    setProbing(true);
    try {
      const results = await Promise.all(
        targets.map((tg) =>
          probeUpstream(tg).then(
            () => null,
            (e) => ({
              profileName: tg.profileName,
              kind: tg.kind as string,
              error: String(e),
            }),
          ),
        ),
      );
      const failures = results.filter(
        (r): r is { profileName: string; kind: string; error: string } => r !== null,
      );
      if (failures.length > 0) {
        if (linuxLaunchOnly) {
          const detail = failures
            .map((failure) => `${failure.profileName} (${failure.kind}): ${failure.error}`)
            .join("\n\n");
          openTestDetail(t("sockscap.rootlessProbeFailedTitle"), detail);
          report(t("sockscap.rootlessProbeFailed"), false);
        } else {
          setProbeFailures(failures);
        }
        return false;
      }
    } finally {
      setProbing(false);
    }

    // 3) All probes passed → start.
    if (needsStartElevation(caps)) {
      setRootPromptIntent("start");
      setRootPromptError(null);
      return false;
    }
    return onStart(undefined, startConfig);
  };

  const onStart = async (
    sudoPassword?: string,
    configOverride?: SocksCapConfig,
  ): Promise<boolean> => {
    const startConfig = configOverride ?? cfg;
    if (!startConfig) return false;
    setMacosSetupError(null);
    if (sudoPassword) {
      setRootPromptBusy(true);
      setRootPromptError(null);
    } else {
      setBusy(true);
    }
    try {
      await sockscapSetConfig(startConfig);
      const st = await sockscapStart(sudoPassword);
      setStatus(st);
      setRootPromptIntent(null);
      setRootPromptError(null);
      if (
        caps?.platform === "macos" &&
        (st.phase === "active" || st.phase === "degraded")
      ) {
        setMacosSetupCompleted(true);
        setMacosSetupGuideMode(null);
        try {
          window.localStorage.setItem(SOCKSCAP_MACOS_SETUP_STORAGE_KEY, "complete");
        } catch {
          // Setup completion is still retained for this session when storage is unavailable.
        }
      }
      report(st.message || t("sockscap.started"), st.phase !== "idle");
      const [gf, sn, hp, launched] = await Promise.all([
        sockscapGfwlistStatus().catch(() => null),
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
        sockscapLaunchedApps().catch(() => []),
      ]);
      setGfw(gf);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
      setLaunchedApps(launched);
      return true;
    } catch (e) {
      const errStr = String(e);
      const needsPassword = needsStartElevation(caps);
      if (needsPassword && !sudoPassword && isRootRequiredError(errStr)) {
        setRootPromptIntent("start");
        setRootPromptError(null);
      } else if (needsPassword && sudoPassword && isSudoAuthenticationError(errStr)) {
        setRootPromptIntent("start");
        setRootPromptError(t("sockscap.rootPromptIncorrectPassword"));
      } else {
        if (sudoPassword) setRootPromptIntent(null);
        if (caps?.platform === "macos") {
          const latestInstall = await sockscapRedirectorInstallStatus().catch(() => null);
          if (latestInstall) setRedirectorInstall(latestInstall);
          const lower = errStr.toLowerCase();
          if (
            latestInstall?.state === "pendingSystemApproval" ||
            lower.includes("redirector") ||
            lower.includes("system extension") ||
            lower.includes("network configuration")
          ) {
            setMacosSetupGuideMode("onboarding");
          }
        }
        report(errStr, false);
      }
      return false;
    } finally {
      setBusy(false);
      setRootPromptBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      const st = await sockscapStop();
      setStatus(st);
      const [sn, hp] = await Promise.all([
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
      ]);
      if (sn) setStats(sn);
      if (hp) setHelper(hp);
      setLaunchedApps([]);
      report(t("sockscap.stopped"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onRecover = async (sudoPassword?: string) => {
    if (sudoPassword) {
      setRootPromptBusy(true);
      setRootPromptError(null);
    } else {
      setBusy(true);
    }
    try {
      await sockscapRecover(sudoPassword);
      setRootPromptIntent(null);
      setRootPromptError(null);
      await refresh();
      report(t("sockscap.recovered"));
    } catch (e) {
      const errStr = String(e);
      const needsPassword = needsRecoveryElevation(caps?.platform);
      if (needsPassword && !sudoPassword && isRootRequiredError(errStr)) {
        setRootPromptIntent("recover");
        setRootPromptError(null);
      } else if (needsPassword && sudoPassword && isSudoAuthenticationError(errStr)) {
        setRootPromptIntent("recover");
        setRootPromptError(t("sockscap.rootPromptIncorrectPassword"));
      } else {
        if (sudoPassword) setRootPromptIntent(null);
        report(errStr, false);
      }
    } finally {
      setBusy(false);
      setRootPromptBusy(false);
    }
  };

  const copyDiagnostics = async () => {
    try {
      const diagnostics = await sockscapDiagnostics();
      await writeText(JSON.stringify(diagnostics, null, 2));
      report(t("sockscap.diagnosticsCopied"));
    } catch (e) {
      report(String(e), false);
    }
  };

  const installRedirector = async () => {
    setBusy(true);
    setMacosSetupError(null);
    try {
      const install = await sockscapInstallRedirector();
      setRedirectorInstall(install);
      await refresh();
      report(install.message);
    } catch (e) {
      const error = String(e);
      setMacosSetupError(error);
      report(error, false);
    } finally {
      setBusy(false);
    }
  };

  const refreshRedirectorApproval = async () => {
    setBusy(true);
    setMacosSetupError(null);
    try {
      const install = await sockscapRedirectorInstallStatus();
      setRedirectorInstall(install);
      report(t("sockscap.statusRefreshed"));
    } catch (e) {
      const error = String(e);
      setMacosSetupError(error);
      report(error, false);
    } finally {
      setBusy(false);
    }
  };

  const continueMacosSetupToStart = () => {
    setMacosSetupGuideMode(null);
    window.requestAnimationFrame(() => startButtonRef.current?.focus());
  };
  return { preflightAndStart, onStop, onRefreshStatus, onRecover, copyDiagnostics, refreshRedirectorApproval, installRedirector, continueMacosSetupToStart, onStart };
}
