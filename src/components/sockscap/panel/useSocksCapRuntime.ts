import { useCallback, useEffect, useRef, useState } from "react";
import {
  sockscapCapabilities,
  sockscapGetConfig,
  sockscapGfwlistStatus,
  sockscapLaunchedApps,
  sockscapStatsSnapshot,
  sockscapStatus,
  sockscapGetDomainRecords,
  sockscapHelperStatus,
  sockscapDetectLocalProxies,
  sockscapDetectTunConflicts,
  sockscapRedirectorInstallStatus,
  type LocalProxyCandidate,
  type DomainRecord,
  type GfwListStatus,
  type HelperStatus,
  type LaunchedAppInfo,
  type RedirectorInstallStatus,
  type SocksCapCapabilities,
  type SocksCapConfig,
  type SocksCapStatus,
  type StatsSnapshot,
} from "../../../lib/sockscap";
import { listSessions } from "../../../lib/ipc";
import { type MacosSetupGuideMode, hasCompletedMacosSetup, type SessionOpt, normalizeFrontendConfig, DEFAULT_CFG } from "./configuration";

export interface UseSocksCapRuntimeContext {
  report: (text: string, ok?: boolean) => void;
}

export function useSocksCapRuntime(context: UseSocksCapRuntimeContext) {
  const { report } = context;
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
  const [launchedApps, setLaunchedApps] = useState<LaunchedAppInfo[]>([]);
  const [tunConflicts, setTunConflicts] = useState<string[]>([]);
  const [tunWarningOpen, setTunWarningOpen] = useState(false);

  // Traffic rates and domain tracking state
  const [domainRecords, setDomainRecords] = useState<DomainRecord[]>([]);
  const [upSpeed, setUpSpeed] = useState(0);
  const [downSpeed, setDownSpeed] = useState(0);
  const lastBytesRef = useRef<{ up: number; down: number; ts: number; } | null>(null);
  const macosSetupAutoHandledRef = useRef(false);

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
        .catch(() => { });
    }, 1500);
    return () => clearInterval(timer);
  }, [status]);
  return { status, caps, redirectorInstall, cfg, setCfg, setStatus, setStats, setHelper, setGfw, setDomainRecords, setRedirectorInstall, setLaunchedApps, setMacosSetupError, setMacosSetupCompleted, setMacosSetupGuideMode, refresh, launchedApps, domainRecords, stats, helper, upSpeed, downSpeed, tunConflicts, setTunWarningOpen, detectedProxies, sessions, rescanLocalProxies, gfw, macosSetupGuideMode, macosSetupCompleted, macosSetupError, tunWarningOpen };
}
