
export const SDK_REGISTRY_STORAGE_KEY = "taomni.stub.sdkRegistry.v1";

export interface StubSdkRegistry {
  schemaVersion: number;
  installations: Array<Record<string, any>>;
  defaults: Array<Record<string, any>>;
  bindings: Array<Record<string, any>>;
}

export function loadSdkRegistry(): StubSdkRegistry {
  try {
    const parsed = JSON.parse(localStorage.getItem(SDK_REGISTRY_STORAGE_KEY) ?? "null");
    if (parsed && parsed.schemaVersion === 1) {
      return {
        schemaVersion: 1,
        installations: Array.isArray(parsed.installations) ? parsed.installations : [],
        defaults: Array.isArray(parsed.defaults) ? parsed.defaults : [],
        bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
      };
    }
  } catch {
    // Fall through to a clean browser-preview registry.
  }
  return { schemaVersion: 1, installations: [], defaults: [], bindings: [] };
}

export function saveSdkRegistry(registry: StubSdkRegistry): void {
  localStorage.setItem(SDK_REGISTRY_STORAGE_KEY, JSON.stringify(registry));
}

export function stubSdkVersion(kind: string, location: string): string | null {
  const match = location.match(/(?:jdk|java|kotlin|scala|python|py)[-_ ]?([0-9]+(?:\.[0-9]+)*)/i);
  if (match?.[1]) return match[1];
  if (kind === "java") return "21";
  if (kind === "python") return "3.13";
  return null;
}

export async function invokeSdk<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "sdk_get_registry": {
      return loadSdkRegistry() as T;
    }

    case "sdk_probe_installation": {
      const kind = String(args?.kind ?? "java");
      const location = String(args?.location ?? "").trim();
      return {
        kind,
        location,
        executables: {},
        version: stubSdkVersion(kind, location),
        vendor: kind === "java" ? "Browser preview" : null,
        architecture: "browser",
        status: location ? "ready" : "missing",
        error: location ? null : "SDK location is required",
        source: "browser-preview",
      } as T;
    }

    case "sdk_discover_installations": {
      return [] as T;
    }

    case "sdk_save_installation": {
      const request = args?.request ?? {};
      const registry = loadSdkRegistry();
      const id = String(request.id || globalThis.crypto?.randomUUID?.() || `sdk-${Date.now()}`);
      const kind = String(request.kind || "java");
      const location = String(request.location || "").trim();
      const version = stubSdkVersion(kind, location);
      const installation = {
        id,
        kind,
        name: String(request.name || `${kind === "java" ? "JDK" : kind} ${version || "SDK"}`),
        location,
        executables: {},
        version,
        vendor: kind === "java" ? "Browser preview" : null,
        architecture: "browser",
        origin: request.origin || "manual",
        status: location ? "ready" : "missing",
        lastError: location ? null : "SDK location is required",
        lastProbedAt: new Date().toISOString(),
      };
      registry.installations = [
        ...registry.installations.filter((item) => item.id !== id),
        installation,
      ];
      saveSdkRegistry(registry);
      return installation as T;
    }

    case "sdk_remove_installation": {
      const registry = loadSdkRegistry();
      const id = String(args?.id ?? "");
      registry.installations = registry.installations.filter((item) => item.id !== id);
      registry.defaults = registry.defaults.filter((item) => item.sdkId !== id);
      registry.bindings = registry.bindings.filter((item) => item.sdkId !== id);
      saveSdkRegistry(registry);
      return undefined as T;
    }

    case "sdk_refresh_installations": {
      const registry = loadSdkRegistry();
      const id = args?.id == null ? null : String(args.id);
      const now = new Date().toISOString();
      registry.installations = registry.installations.map((item) => (
        id == null || item.id === id ? { ...item, lastProbedAt: now } : item
      ));
      saveSdkRegistry(registry);
      return registry.installations.filter((item) => id == null || item.id === id) as T;
    }

    case "sdk_set_default": {
      const request = args?.request ?? {};
      const registry = loadSdkRegistry();
      registry.defaults = registry.defaults.filter((item) => item.kind !== request.kind);
      if (request.sdkId) registry.defaults.push({ kind: request.kind, sdkId: request.sdkId });
      saveSdkRegistry(registry);
      return undefined as T;
    }

    case "sdk_save_workspace_binding": {
      const request = args?.request ?? {};
      const registry = loadSdkRegistry();
      registry.bindings = registry.bindings.filter((item) => !(
        item.scopePath === request.scopePath
        && item.kind === request.kind
        && item.role === request.role
      ));
      const binding = { ...request, sdkId: request.sdkId ?? null, updatedAt: new Date().toISOString() };
      registry.bindings.push(binding);
      saveSdkRegistry(registry);
      return binding as T;
    }

    case "sdk_remove_workspace_binding": {
      const registry = loadSdkRegistry();
      registry.bindings = registry.bindings.filter((item) => !(
        item.scopePath === args?.scopePath
        && item.kind === args?.kind
        && item.role === args?.role
      ));
      saveSdkRegistry(registry);
      return undefined as T;
    }

    case "sdk_analyze_workspace": {
      return {
        workspaceRoot: String(args?.workspaceRoot ?? ""),
        profiles: [],
        warnings: [],
      } as T;
    }

    case "sdk_resolve_workspace": {
      return {
        analysis: {
          workspaceRoot: String(args?.workspaceRoot ?? ""),
          profiles: [],
          warnings: [],
        },
        resolved: [],
      } as T;
    }
    default: throw new Error(`Unhandled sdk stub command: ${cmd}`);
  }
}
