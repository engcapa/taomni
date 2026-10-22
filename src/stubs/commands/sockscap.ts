

export async function invokeSockscap<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    // ---------- SocksCap (browser preview: config/rules dry-run only) ----------
    case "sockscap_capabilities": {
      return {
        platform: "browser",
        globalTcp: false,
        appFilter: false,
        captureBackend: "none",
        notes: ["Browser preview — rules engine stub only; no OS capture."],
        privilegedRequired: false,
      } as T;
    }

    case "sockscap_redirector_install_status": {
      throw new Error("Mitmproxy Redirector installation is only available on macOS.");
    }

    case "sockscap_install_redirector": {
      throw new Error("Mitmproxy Redirector installation is only available on macOS.");
    }

    case "sockscap_get_config": {
      let cfg: Record<string, unknown> | null = null;
      try {
        const raw = localStorage.getItem("taomni.sockscap.config.v1");
        if (raw) cfg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* fallthrough */
      }
      if (!cfg) {
        cfg = {
          enabled: false,
          activeProfileIds: ["default"],
          selectedProfileId: "default",
          profiles: [
            {
              id: "default",
              name: "默认方案",
              icon: "🎮",
              enabled: true,
              priority: 0,
              mode: "global",
              apps: [],
              upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080, username: "", passwordRef: "" },
              ruleMode: "gfwList",
              userRules: [],
              defaultAction: "direct",
            },
          ],
          mode: "global",
          apps: [],
          upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080, username: "", passwordRef: "" },
          ruleMode: "gfwList",
          gfwlist: {
            enabled: true,
            url: "https://cdn.jsdelivr.net/gh/gfwlist/gfwlist/gfwlist.txt",
            autoRefreshHours: 24,
          },
          userRules: [],
          bypassCidrs: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
          defaultAction: "direct",
          restoreOnLogin: false,
          blockQuic: true,
        };
      }
      if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {
        cfg.profiles = [
          {
            id: "default",
            name: "默认方案",
            icon: "🎮",
            enabled: true,
            priority: 0,
            mode: cfg.mode ?? "global",
            apps: cfg.apps ?? [],
            upstream: cfg.upstream ?? { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 },
            ruleMode: cfg.ruleMode ?? "gfwList",
            userRules: cfg.userRules ?? [],
            defaultAction: cfg.defaultAction ?? "direct",
          },
        ];
      }
      if (!Array.isArray(cfg.activeProfileIds) || cfg.activeProfileIds.length === 0) {
        const profList = cfg.profiles as Array<Record<string, unknown>>;
        cfg.activeProfileIds = [String(profList[0]?.id ?? "default")];
      }
      if (!cfg.selectedProfileId) {
        const profList = cfg.profiles as Array<Record<string, unknown>>;
        cfg.selectedProfileId = String(profList[0]?.id ?? "default");
      }
      return cfg as T;
    }

    case "sockscap_validate_macos_app": {
      throw new Error("macOS application validation requires the desktop build.");
    }

    case "sockscap_set_config": {
      localStorage.setItem("taomni.sockscap.config.v1", JSON.stringify(args?.config ?? {}));
      return undefined as T;
    }

    case "sockscap_gfwlist_status": {
      return {
        loaded: false,
        ruleCount: 0,
        skipped: 0,
        lastRefresh: null,
        source: "",
        error: null,
      } as T;
    }

    case "sockscap_refresh_gfwlist":

    case "sockscap_import_rules": {
      return {
        loaded: true,
        ruleCount: 0,
        skipped: 0,
        lastRefresh: new Date().toISOString(),
        source: "browser-stub",
        error: "GFWList fetch/import requires the desktop build.",
      } as T;
    }

    case "sockscap_test_target": {
      const host = String(args?.host ?? "");
      const hit = /google|github|twitter|facebook|youtube/i.test(host);
      return {
        host,
        port: Number(args?.port ?? 443),
        decision: hit ? "proxy" : "direct",
        reason: hit ? "browser stub heuristic" : "browser stub default",
        matchedRule: hit ? "||stub" : null,
      } as T;
    }

    case "sockscap_status": {
      return {
        phase: "idle",
        message: "browser preview",
        ruleCount: 0,
        captureBackend: "none",
      } as T;
    }

    case "sockscap_diagnostics": {
      return {
        generatedAt: Math.floor(Date.now() / 1000),
        status: { phase: "idle", message: "browser preview", ruleCount: 0, captureBackend: "none" },
        capabilities: {
          platform: "browser",
          globalTcp: false,
          appFilter: false,
          captureBackend: "none",
          notes: ["Browser preview"],
          privilegedRequired: false,
        },
        stats: {
          flowsTotal: 0,
          flowsProxy: 0,
          flowsDirect: 0,
          flowsBlock: 0,
          bytesUp: 0,
          bytesDown: 0,
        },
        recoveryJournal: null,
        redirector: null,
        manualRecoverySteps: [],
      } as T;
    }

    case "sockscap_start": {
      return {
        phase: "degraded",
        message: "Browser preview — capture unavailable; use desktop build for SocksCap.",
        ruleCount: 0,
        captureBackend: "none",
      } as T;
    }

    case "sockscap_launch_app":
      throw new Error("Launching applications through SocksCap requires the Linux desktop build.");

    case "sockscap_launch_terminal_app":
      throw new Error("Launching terminal applications through SocksCap requires the Linux desktop build.");

    case "sockscap_launched_apps":
      return [] as T;

    case "sockscap_stop_launched_app":
      return undefined as T;

    case "sockscap_stop": {
      return {
        phase: "idle",
        message: "stopped",
        ruleCount: 0,
        captureBackend: "none",
      } as T;
    }

    case "sockscap_recover":
      return undefined as T;

    case "sockscap_stats_snapshot": {
      return {
        flowsTotal: 0,
        flowsProxy: 0,
        flowsDirect: 0,
        flowsBlock: 0,
        bytesUp: 0,
        bytesDown: 0,
        lastFlowAt: null,
        quicFlowsDropped: 0,
        udpDirectDatagrams: 0,
        lastQuicDropAt: null,
        scopeMismatchFlows: 0,
        flowFailures: 0,
        dnsAnswersLearned: 0,
        lastScopeMismatchAt: null,
      } as T;
    }

    case "sockscap_get_domain_records":
      return [] as T;

    case "sockscap_clear_domain_records":
      return undefined as T;

    case "sockscap_list_processes":
      return [] as T;

    case "sockscap_detect_local_proxies":

    case "sockscap_detect_tun_conflicts":
      return [] as T;

    case "sockscap_test_upstream":
      throw new Error("Upstream test is only available in the desktop build.");

    case "sockscap_helper_status":
      return {
        running: false,
        elevated: false,
        endpoint: null,
        message: "Helper not available in browser preview.",
        windivert: null,
      } as T;

    case "sockscap_helper_start":
      throw new Error("Elevated helper requires the desktop Windows build.");

    case "sockscap_helper_stop":
      return undefined as T;

    case "sockscap_helper_probe_windivert":
      throw new Error("WinDivert probe requires the desktop Windows build.");
    default: throw new Error(`Unhandled sockscap stub command: ${cmd}`);
  }
}
