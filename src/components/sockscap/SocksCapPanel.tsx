import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Network,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  sockscapCapabilities,
  sockscapGetConfig,
  sockscapGfwlistStatus,
  sockscapImportRules,
  sockscapListProcesses,
  sockscapRefreshGfwlist,
  sockscapRecover,
  sockscapSetConfig,
  sockscapStart,
  sockscapStatsSnapshot,
  sockscapStatus,
  sockscapStop,
  sockscapHelperProbeWindivert,
  sockscapHelperStart,
  sockscapHelperStatus,
  sockscapHelperStop,
  sockscapTestTarget,
  sockscapTestUpstream,
  type Decision,
  type HelperStatus,
  type GfwListStatus,
  type ProcessInfo,
  type RuleMode,
  type ScopeMode,
  type SocksCapCapabilities,
  type SocksCapConfig,
  type SocksCapStatus,
  type StatsSnapshot,
  type TargetTestResult,
  type UpstreamKind,
  type UserRule,
} from "../../lib/sockscap";
import { listSessions } from "../../lib/ipc";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  onStatusMessage?: (msg: string) => void;
  onClose?: () => void;
}

const DEFAULT_CFG: SocksCapConfig = {
  enabled: false,
  mode: "global",
  apps: [],
  upstream: {
    kind: "socks5",
    sessionId: "",
    host: "127.0.0.1",
    port: 1080,
    username: "",
    passwordRef: "",
  },
  ruleMode: "gfwList",
  gfwlist: {
    enabled: true,
    url: "https://cdn.jsdelivr.net/gh/gfwlist/gfwlist/gfwlist.txt",
    autoRefreshHours: 24,
  },
  userRules: [],
  bypassCidrs: [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
  ],
  defaultAction: "direct",
  restoreOnLogin: false,
};

type SessionOpt = { id: string; name: string; host: string; port: number; kind: "proxy" | "ssh" };

function phaseTone(phase: string): string {
  switch (phase) {
    case "active":
      return "text-emerald-500";
    case "degraded":
      return "text-amber-500";
    case "preparing":
    case "stopping":
      return "text-sky-500";
    case "recoveryRequired":
      return "text-red-500";
    default:
      return "text-[var(--taomni-text-muted)]";
  }
}

export function SocksCapPanel({ onStatusMessage, onClose }: Props) {
  const t = useT();
  const [cfg, setCfg] = useState<SocksCapConfig | null>(null);
  const [caps, setCaps] = useState<SocksCapCapabilities | null>(null);
  const [status, setStatus] = useState<SocksCapStatus | null>(null);
  const [gfw, setGfw] = useState<GfwListStatus | null>(null);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [sessions, setSessions] = useState<SessionOpt[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testHost, setTestHost] = useState("www.google.com");
  const [testResult, setTestResult] = useState<TargetTestResult | null>(null);
  const [newRule, setNewRule] = useState<UserRule>({
    pattern: "",
    action: "direct",
    comment: "",
  });
  const [showProcPicker, setShowProcPicker] = useState(false);
  const [helper, setHelper] = useState<HelperStatus | null>(null);

  const report = useCallback(
    (text: string, ok = true) => {
      setMsg({ ok, text });
      onStatusMessage?.(text);
    },
    [onStatusMessage],
  );

  const refresh = useCallback(async () => {
    try {
      const [c, cap, st, gf, sn, hp] = await Promise.all([
        sockscapGetConfig().catch(() => DEFAULT_CFG),
        sockscapCapabilities().catch(() => null),
        sockscapStatus().catch(() => null),
        sockscapGfwlistStatus().catch(() => null),
        sockscapStatsSnapshot().catch(() => null),
        sockscapHelperStatus().catch(() => null),
      ]);
      setCfg({ ...DEFAULT_CFG, ...c, upstream: { ...DEFAULT_CFG.upstream, ...c.upstream } });
      setCaps(cap);
      setStatus(st);
      setGfw(gf);
      setStats(sn);
      setHelper(hp);
    } catch (e) {
      report(String(e), false);
    }
  }, [report]);

  useEffect(() => {
    void refresh();
    listSessions()
      .then((all) => {
        const opts: SessionOpt[] = [];
        for (const s of all) {
          if (s.session_type === "Proxy") {
            opts.push({ id: s.id, name: s.name, host: s.host, port: s.port, kind: "proxy" });
          } else if (s.session_type === "SSH") {
            opts.push({ id: s.id, name: s.name, host: s.host, port: s.port, kind: "ssh" });
          }
        }
        setSessions(opts);
      })
      .catch(() => {});
  }, [refresh]);

  const persist = async (next: SocksCapConfig) => {
    setCfg(next);
    try {
      await sockscapSetConfig(next);
      report(t("sockscap.saved"));
    } catch (e) {
      report(String(e), false);
    }
  };

  const patch = async (partial: Partial<SocksCapConfig>) => {
    if (!cfg) return;
    await persist({ ...cfg, ...partial });
  };

  const running = useMemo(
    () => status && ["active", "degraded", "preparing"].includes(status.phase),
    [status],
  );

  const onStart = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      await sockscapSetConfig(cfg);
      const st = await sockscapStart();
      setStatus(st);
      report(st.message || t("sockscap.started"), st.phase !== "idle");
      const gf = await sockscapGfwlistStatus().catch(() => null);
      setGfw(gf);
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      const st = await sockscapStop();
      setStatus(st);
      report(t("sockscap.stopped"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onRecover = async () => {
    setBusy(true);
    try {
      await sockscapRecover();
      await refresh();
      report(t("sockscap.recovered"));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onRefreshGfw = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      const res = await sockscapRefreshGfwlist(cfg.gfwlist.url);
      setGfw(res);
      if (res.error) report(res.error, false);
      else report(t("sockscap.gfwRefreshed", { count: String(res.ruleCount) }));
      const st = await sockscapStatus().catch(() => null);
      setStatus(st);
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onImportGfw = async () => {
    try {
      if (!isTauriRuntime()) {
        report(t("sockscap.importDesktopOnly"), false);
        return;
      }
      const selected = await open({
        multiple: false,
        filters: [{ name: "GFWList / AutoProxy", extensions: ["txt", "conf", "list"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      setBusy(true);
      const res = await sockscapImportRules(selected);
      setGfw(res);
      report(t("sockscap.gfwImported", { count: String(res.ruleCount) }));
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onTestTarget = async () => {
    setBusy(true);
    try {
      if (cfg) await sockscapSetConfig(cfg);
      const res = await sockscapTestTarget(testHost.trim(), 443);
      setTestResult(res);
      report(
        t("sockscap.testTargetResult", {
          host: res.host,
          decision: res.decision,
          reason: res.reason,
        }),
      );
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
    }
  };

  const onTestUpstream = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      const u = cfg.upstream;
      const text = await sockscapTestUpstream({
        kind: u.kind,
        host: u.host || "127.0.0.1",
        port: u.port || 1080,
        username: u.username,
        testHost: "www.google.com",
        testPort: 443,
      });
      report(text);
    } catch (e) {
      report(String(e), false);
    } finally {
      setBusy(false);
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

  const addAppPath = async (path: string, name?: string) => {
    if (!cfg || !path.trim()) return;
    const apps = [...cfg.apps];
    if (apps.some((a) => a.path.toLowerCase() === path.toLowerCase())) return;
    apps.push({ path, name: name || path.split(/[/\\]/).pop() || path });
    await patch({ apps });
  };

  const addUserRule = async () => {
    if (!cfg || !newRule.pattern.trim()) return;
    await patch({
      userRules: [...cfg.userRules, { ...newRule, pattern: newRule.pattern.trim() }],
    });
    setNewRule({ pattern: "", action: "direct", comment: "" });
  };

  if (!cfg) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        {t("sockscap.loading")}
      </div>
    );
  }

  const proxySessions = sessions.filter((s) => s.kind === "proxy");
  const sshSessions = sessions.filter((s) => s.kind === "ssh");

  return (
    <div
      className="relative h-full flex flex-col bg-[var(--taomni-panel)] text-[var(--taomni-text)]"
      data-testid="sockscap-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--taomni-divider)] shrink-0">
        <Shield className="w-5 h-5 text-[var(--taomni-accent)]" />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold">{t("sockscap.title")}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("sockscap.subtitle")}</div>
        </div>
        <div className={`text-[11px] font-medium ${phaseTone(status?.phase ?? "idle")}`}>
          {status ? t(`sockscap.phase.${status.phase}`) : t("sockscap.phase.idle")}
          {status?.captureBackend ? ` · ${status.captureBackend}` : ""}
        </div>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-[var(--taomni-text-muted)]" />}
        {running ? (
          <button
            type="button"
            data-testid="sockscap-stop"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[12px] bg-red-600/90 text-white hover:bg-red-600"
            onClick={() => void onStop()}
            disabled={busy}
          >
            <Square className="w-3.5 h-3.5" />
            {t("sockscap.stop")}
          </button>
        ) : (
          <button
            type="button"
            data-testid="sockscap-start"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
            onClick={() => void onStart()}
            disabled={busy}
          >
            <Play className="w-3.5 h-3.5" />
            {t("sockscap.start")}
          </button>
        )}
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
          onClick={() => void onRecover()}
          disabled={busy}
          title={t("sockscap.recover")}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        {onClose && (
          <button
            type="button"
            className="p-1.5 rounded hover:bg-[var(--taomni-hover)]"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Banner */}
      {caps && (
        <div
          className={`px-4 py-2 text-[11px] border-b border-[var(--taomni-divider)] flex gap-2 items-start ${
            caps.globalTcp
              ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
          }`}
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">
              {caps.globalTcp
                ? `${caps.captureBackend} · ${caps.platform}`
                : t("sockscap.captureNotReady")}
            </div>
            <div className="opacity-90">
              {caps.notes?.[0] ?? t("sockscap.captureNotReadyHint")}
              {caps.privilegedRequired ? ` · ${t("sockscap.helper.start")}` : ""}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Scope */}
        <Section title={t("sockscap.section.scope")}>
          <div className="flex gap-2">
            {(["global", "apps"] as ScopeMode[]).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`sockscap-mode-${m}`}
                className={`px-3 py-1.5 rounded text-[12px] border ${
                  cfg.mode === m
                    ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)]"
                    : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                }`}
                onClick={() => void patch({ mode: m })}
              >
                {t(`sockscap.mode.${m}`)}
              </button>
            ))}
          </div>
          {cfg.mode === "apps" && (
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                  onClick={() => void loadProcesses()}
                >
                  <Plus className="w-3 h-3" />
                  {t("sockscap.pickProcess")}
                </button>
                <ManualAppAdd onAdd={(path) => void addAppPath(path)} />
              </div>
              {cfg.apps.length === 0 ? (
                <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("sockscap.appsEmpty")}</div>
              ) : (
                <ul className="space-y-1">
                  {cfg.apps.map((a) => (
                    <li
                      key={a.path}
                      className="flex items-center gap-2 text-[12px] px-2 py-1 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
                    >
                      <span className="flex-1 truncate" title={a.path}>
                        {a.name || a.path}
                      </span>
                      <button
                        type="button"
                        className="p-1 hover:text-red-500"
                        onClick={() =>
                          void patch({ apps: cfg.apps.filter((x) => x.path !== a.path) })
                        }
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>

        {/* Upstream */}
        <Section title={t("sockscap.section.upstream")}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label={t("sockscap.upstreamKind")}>
              <select
                className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                value={cfg.upstream.kind}
                onChange={(e) =>
                  void patch({
                    upstream: {
                      ...cfg.upstream,
                      kind: e.target.value as UpstreamKind,
                      sessionId: "",
                    },
                  })
                }
              >
                <option value="http">HTTP CONNECT</option>
                <option value="socks5">SOCKS5</option>
                <option value="ssh">SSH (single hop)</option>
              </select>
            </Field>
            <Field label={t("sockscap.upstreamSession")}>
              <select
                className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                value={cfg.upstream.sessionId || ""}
                onChange={(e) => {
                  const id = e.target.value;
                  const s = sessions.find((x) => x.id === id);
                  void patch({
                    upstream: {
                      ...cfg.upstream,
                      sessionId: id,
                      host: s?.host ?? cfg.upstream.host,
                      port: s?.port ?? cfg.upstream.port,
                    },
                  });
                }}
              >
                <option value="">{t("sockscap.manualUpstream")}</option>
                {(cfg.upstream.kind === "ssh" ? sshSessions : proxySessions).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.host}:{s.port})
                  </option>
                ))}
              </select>
            </Field>
            {!cfg.upstream.sessionId && (
              <>
                <Field label={t("sockscap.host")}>
                  <input
                    className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                    value={cfg.upstream.host || ""}
                    onChange={(e) =>
                      setCfg({ ...cfg, upstream: { ...cfg.upstream, host: e.target.value } })
                    }
                    onBlur={() => void persist(cfg)}
                  />
                </Field>
                <Field label={t("sockscap.port")}>
                  <input
                    type="number"
                    className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                    value={cfg.upstream.port || 0}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        upstream: { ...cfg.upstream, port: Number(e.target.value) || 0 },
                      })
                    }
                    onBlur={() => void persist(cfg)}
                  />
                </Field>
                <Field label={t("sockscap.username")}>
                  <input
                    className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                    value={cfg.upstream.username || ""}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        upstream: { ...cfg.upstream, username: e.target.value },
                      })
                    }
                    onBlur={() => void persist(cfg)}
                  />
                </Field>
              </>
            )}
          </div>
          <div className="mt-2">
            <button
              type="button"
              className="text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              onClick={() => void onTestUpstream()}
              disabled={busy || cfg.upstream.kind === "ssh"}
            >
              {t("sockscap.testUpstream")}
            </button>
            {cfg.upstream.kind === "ssh" && (
              <span className="ml-2 text-[10px] text-[var(--taomni-text-muted)]">
                {t("sockscap.sshTestLater")}
              </span>
            )}
          </div>
        </Section>

        {/* Rules */}
        <Section title={t("sockscap.section.rules")}>
          <div className="flex flex-wrap gap-2 mb-3">
            {(["gfwList", "proxyAll", "off"] as RuleMode[]).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`sockscap-rule-mode-${m}`}
                className={`px-3 py-1.5 rounded text-[12px] border ${
                  cfg.ruleMode === m
                    ? "border-[var(--taomni-accent)] bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)]"
                    : "border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                }`}
                onClick={() => void patch({ ruleMode: m })}
              >
                {t(`sockscap.ruleMode.${m}`)}
              </button>
            ))}
          </div>

          {cfg.ruleMode === "gfwList" && (
            <div className="space-y-2 mb-3 p-3 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]">
              <Field label={t("sockscap.gfwUrl")}>
                <input
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel)]"
                  value={cfg.gfwlist.url}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      gfwlist: { ...cfg.gfwlist, url: e.target.value },
                    })
                  }
                  onBlur={() => void persist(cfg)}
                />
              </Field>
              <div className="flex flex-wrap gap-2 items-center text-[11px]">
                <button
                  type="button"
                  data-testid="sockscap-refresh-gfw"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                  onClick={() => void onRefreshGfw()}
                  disabled={busy}
                >
                  <RefreshCw className="w-3 h-3" />
                  {t("sockscap.refreshGfw")}
                </button>
                <button
                  type="button"
                  className="px-2 py-1 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
                  onClick={() => void onImportGfw()}
                  disabled={busy}
                >
                  {t("sockscap.importGfw")}
                </button>
                <span className="text-[var(--taomni-text-muted)]">
                  {gfw?.loaded
                    ? t("sockscap.gfwStatus", {
                        count: String(gfw.ruleCount),
                        skipped: String(gfw.skipped),
                        when: gfw.lastRefresh || "—",
                      })
                    : t("sockscap.gfwNotLoaded")}
                </span>
              </div>
              <Field label={t("sockscap.defaultAction")}>
                <select
                  className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel)]"
                  value={cfg.defaultAction}
                  onChange={(e) => void patch({ defaultAction: e.target.value as Decision })}
                >
                  <option value="direct">{t("sockscap.decision.direct")}</option>
                  <option value="proxy">{t("sockscap.decision.proxy")}</option>
                  <option value="block">{t("sockscap.decision.block")}</option>
                </select>
              </Field>
            </div>
          )}

          <div className="text-[12px] font-medium mb-1">{t("sockscap.userRules")}</div>
          <div className="flex flex-wrap gap-2 mb-2">
            <input
              className="flex-1 min-w-[140px] text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
              placeholder={t("sockscap.rulePatternPh")}
              value={newRule.pattern}
              onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
            />
            <select
              className="text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
              value={newRule.action}
              onChange={(e) =>
                setNewRule({
                  ...newRule,
                  action: e.target.value as UserRule["action"],
                })
              }
            >
              <option value="direct">{t("sockscap.decision.direct")}</option>
              <option value="proxy">{t("sockscap.decision.proxy")}</option>
              <option value="block">{t("sockscap.decision.block")}</option>
            </select>
            <button
              type="button"
              className="px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              onClick={() => void addUserRule()}
            >
              {t("sockscap.addRule")}
            </button>
          </div>
          {cfg.userRules.length > 0 && (
            <ul className="space-y-1 mb-3">
              {cfg.userRules.map((r, i) => (
                <li
                  key={`${r.pattern}-${i}`}
                  className="flex items-center gap-2 text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)]"
                >
                  <span className="font-mono flex-1 truncate">{r.pattern}</span>
                  <span className="text-[var(--taomni-text-muted)]">{r.action}</span>
                  <button
                    type="button"
                    className="p-1 hover:text-red-500"
                    onClick={() =>
                      void patch({
                        userRules: cfg.userRules.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2 items-end">
            <Field label={t("sockscap.testTarget")}>
              <input
                data-testid="sockscap-test-host"
                className="w-full min-w-[180px] text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
                value={testHost}
                onChange={(e) => setTestHost(e.target.value)}
              />
            </Field>
            <button
              type="button"
              data-testid="sockscap-test-target"
              className="px-3 py-1.5 rounded text-[12px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              onClick={() => void onTestTarget()}
              disabled={busy}
            >
              {t("sockscap.runTest")}
            </button>
            {testResult && (
              <div className="text-[11px] text-[var(--taomni-text-muted)]">
                → <span className="font-medium text-[var(--taomni-text)]">{testResult.decision}</span>
                {" · "}
                {testResult.reason}
                {testResult.matchedRule ? ` (${testResult.matchedRule})` : ""}
              </div>
            )}
          </div>
        </Section>

        {/* Elevated helper / WinDivert spike */}
        <Section title={t("sockscap.helper.title")}>
          <div className="flex flex-wrap gap-2 items-center text-[11px] mb-2">
            <span className="text-[var(--taomni-text-muted)]">
              {helper?.running
                ? `${helper.endpoint ?? "…"} · ${
                    helper.elevated ? t("sockscap.helper.elevated") : t("sockscap.helper.notElevated")
                  }${helper.pid ? ` · pid ${helper.pid}` : ""}`
                : t("sockscap.helper.notRunning")}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="sockscap-helper-start"
              className="px-2 py-1 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    const st = await sockscapHelperStart();
                    setHelper(st);
                    report(
                      st.elevated
                        ? t("sockscap.helper.elevated")
                        : st.message || t("sockscap.helper.status"),
                    );
                  } catch (e) {
                    report(String(e), false);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {t("sockscap.helper.start")}
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              disabled={busy || !helper?.running}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    await sockscapHelperStop();
                    setHelper(await sockscapHelperStatus());
                    report(t("sockscap.helper.notRunning"));
                  } catch (e) {
                    report(String(e), false);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {t("sockscap.stop")}
            </button>
            <button
              type="button"
              data-testid="sockscap-windivert-probe"
              className="px-2 py-1 rounded border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
              disabled={busy || !helper?.running}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    const res = await sockscapHelperProbeWindivert("false");
                    report(`${t("sockscap.helper.windivertOk")}: ${JSON.stringify(res)}`);
                  } catch (e) {
                    report(`${t("sockscap.helper.windivertFail")}: ${String(e)}`, false);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {t("sockscap.helper.windivertProbe")}
            </button>
          </div>
          <div className="mt-2 text-[10px] text-[var(--taomni-text-muted)]">
            Place WinDivert.dll / .sys under src-tauri/resources/sockscap/windows/ (see README there).
          </div>
        </Section>

        {/* Stats / status message */}
        <Section title={t("sockscap.section.status")}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
            <Stat
              icon={<Activity className="w-3.5 h-3.5" />}
              label={t("sockscap.stats.flows")}
              value={String(stats?.flowsTotal ?? 0)}
            />
            <Stat label={t("sockscap.stats.proxy")} value={String(stats?.flowsProxy ?? 0)} />
            <Stat label={t("sockscap.stats.direct")} value={String(stats?.flowsDirect ?? 0)} />
            <Stat label={t("sockscap.stats.block")} value={String(stats?.flowsBlock ?? 0)} />
          </div>
          {status?.message && (
            <div className="mt-2 text-[11px] text-[var(--taomni-text-muted)] flex gap-1 items-start">
              <Network className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {status.message}
            </div>
          )}
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
        </Section>
      </div>

      {showProcPicker && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20">
          <div className="w-[min(520px,90vw)] max-h-[70vh] flex flex-col rounded-lg bg-[var(--taomni-panel)] border border-[var(--taomni-divider)] shadow-xl">
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
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--taomni-divider)] p-3">
      <h3 className="text-[12px] font-semibold mb-2">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[11px]">
      <div className="text-[var(--taomni-text-muted)] mb-1">{label}</div>
      {children}
    </label>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded border border-[var(--taomni-divider)] px-2 py-1.5 bg-[var(--taomni-bg)]">
      <div className="text-[var(--taomni-text-muted)] flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="text-[14px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ManualAppAdd({ onAdd }: { onAdd: (path: string) => void }) {
  const t = useT();
  const [path, setPath] = useState("");
  return (
    <div className="flex gap-1 flex-1 min-w-[200px]">
      <input
        className="flex-1 text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
        placeholder={t("sockscap.appPathPh")}
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <button
        type="button"
        className="px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
        onClick={() => {
          if (path.trim()) {
            onAdd(path.trim());
            setPath("");
          }
        }}
      >
        {t("common.add")}
      </button>
    </div>
  );
}
