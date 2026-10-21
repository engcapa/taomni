import { goStubCatalog } from "../opencodeGoStub";
import { inspectorStub, inspectorCheckStub } from "../modelInspectorStub";
import { type InvokeArgs } from "./runtime";
import { stubSystemRdpStatus } from "./servers";

export async function invokeApplication<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    // Browser fixtures prove recovery UI only, never native death/PID survival.
    case "recovery_get": {
      const fixture = localStorage.getItem("qa.recovery.bootstrap");
      return (fixture ? JSON.parse(fixture) : {
        version: 1, instanceId: "browser-stub", generation: 0, revision: 0,
        recovering: false, description: null, limitation: "browser-stub",
      }) as T;
    }

    case "recovery_update":

    case "recovery_ready":
      return undefined as T;

    case "list_system_fonts": {
      return [] as T;
    }

    case "clipboard_read_text": {
      return ((await navigator.clipboard?.readText?.()) ?? "") as T;
    }

    case "clipboard_write_text": {
      const text = ((args as InvokeArgs | undefined)?.text as string) ?? "";
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard write is not available in browser preview.");
      }
      await navigator.clipboard.writeText(text);
      return undefined as T;
    }

    case "git_blame_lines": {
      return [] as T;
    }

    case "exit_app": {
      window.close();
      return undefined as T;
    }

    case "open_sftp_window": {
      const sessionId = args?.sessionId as string;
      const url = new URL(window.location.href);
      url.searchParams.set("sftp", sessionId);
      url.hash = "";
      const features = "width=1200,height=760,resizable=yes,scrollbars=yes";
      const handle = window.open(
        url.toString(),
        `taomni_sftp_${sessionId}`,
        features,
      );
      if (!handle) {
        throw new Error(
          "Browser blocked the SFTP window. Allow pop-ups for this site.",
        );
      }
      return undefined as T;
    }

    case "close_current_detached_window": {
      window.close();
      return undefined as T;
    }

    case "open_detached_window": {
      const kind = args?.kind as string;
      const sessionId = args?.sessionId as string;
      const width = (args?.width as number | undefined) ?? 1200;
      const height = (args?.height as number | undefined) ?? 760;
      const url = new URL(window.location.href);
      url.searchParams.set(kind, sessionId);
      url.hash = "";
      const features = `width=${width},height=${height},resizable=yes,scrollbars=yes`;
      const handle = window.open(
        url.toString(),
        `taomni_${kind}_${sessionId}`,
        features,
      );
      if (!handle) {
        throw new Error(
          `Browser blocked the ${kind} window. Allow pop-ups for this site.`,
        );
      }
      return undefined as T;
    }

    case "probe_system_rdp": {
      return stubSystemRdpStatus() as T;
    }

    case "open_system_rdp_settings": {
      const win = window as unknown as { __taomniStubSystemRdpSettingsOpened?: number };
      win.__taomniStubSystemRdpSettingsOpened = (win.__taomniStubSystemRdpSettingsOpened ?? 0) + 1;
      return undefined as T;
    }

    case "mirror_get_config": {
      return ({ preference: "auto", custom_base: null } as unknown) as T;
    }

    case "mirror_set_config": {
      return undefined as T;
    }

    case "cuda_pack_status": {
      return ({ installed: false, path: "", size_mb: 0 } as unknown) as T;
    }

    case "get_opencode_go_catalog": {
      return goStubCatalog(!!args?.forceRefresh) as T;
    }

    case "get_provider_models": {
      return inspectorStub(String(args?.providerId), !!args?.forceRefresh, args?.providerDraft as Parameters<typeof inspectorStub>[2]) as T;
    }

    case "test_llm_model": {
      return inspectorCheckStub(String(args?.providerId), String(args?.model)) as T;
    }

    case "test_llm_connection": {
      return { ok: true, message: "Fixture pong (browser only)", latency_ms: 12 } as T;
    }

    case "get_ai_config": {
      try {
        const raw = localStorage.getItem("taomni.ai.config.v1");
        if (raw) {
          const config = JSON.parse(raw);
          config.llm.providers["opencode-go"] ??= {
            base_url: "https://opencode.ai/inference/go/v1", api_key: "",
            model: "deepseek-v4.1-flash", runtime: "opencode-go", capabilities: { chat: true }, proxy_mode: "app",
          };
          return config as T;
        }
      } catch {}
      return null as unknown as T;
    }

    case "save_ai_config": {
      try {
        if (args?.config) {
          localStorage.setItem("taomni.ai.config.v1", JSON.stringify(args.config));
        }
      } catch {}
      return undefined as T;
    }

    case "save_ai_api_key": {
      return (`vault:stub-${args?.kind || "key"}` as unknown) as T;
    }
    default: throw new Error(`Unhandled application stub command: ${cmd}`);
  }
}
