import { invoke } from "@tauri-apps/api/core";
import { type LspServerPreset, type LspServerStatus, type LspBundleStatus } from "./types";

export function lspListPresets(): Promise<LspServerPreset[]> {
  return invoke<LspServerPreset[]>("lsp_list_presets");
}

export let lspDetectCache: { key: string; time: number; data: LspServerStatus[]; } | null = null;

export let lspDetectInFlight: { key: string; promise: Promise<LspServerStatus[]>; } | null = null;

export const lspDetectLatestRequests = new Map<string, number>();

export let lspDetectCacheEpoch = 0;

export const LSP_DETECT_CACHE_TTL_MS = 60_000;

export function clearLspDetectCache(): void {
  lspDetectCache = null;
  lspDetectInFlight = null;
  lspDetectLatestRequests.clear();
  lspDetectCacheEpoch += 1;
}

/** Detect installed language servers. Pass `javaHome` to probe jdtls with a configured JDK. */
export function lspDetectServers(options?: { javaHome?: string | null; forceRefresh?: boolean; }): Promise<LspServerStatus[]> {
  const javaHome = options?.javaHome?.trim() || null;
  const key = javaHome ?? "";

  if (!options?.forceRefresh) {
    if (lspDetectCache && lspDetectCache.key === key && Date.now() - lspDetectCache.time < LSP_DETECT_CACHE_TTL_MS) {
      return Promise.resolve(lspDetectCache.data);
    }
  }
  if (lspDetectInFlight && lspDetectInFlight.key === key) {
    return lspDetectInFlight.promise;
  }

  const requestId = (lspDetectLatestRequests.get(key) ?? 0) + 1;
  lspDetectLatestRequests.set(key, requestId);
  const cacheEpoch = lspDetectCacheEpoch;
  const promise = invoke<LspServerStatus[]>("lsp_detect_servers", { javaHome })
    .then((statuses) => {
      if (
        lspDetectCacheEpoch === cacheEpoch
        && lspDetectLatestRequests.get(key) === requestId
      ) {
        lspDetectCache = { key, time: Date.now(), data: statuses };
      }
      return statuses;
    })
    .finally(() => {
      if (lspDetectInFlight?.promise === promise) {
        lspDetectInFlight = null;
      }
    });

  lspDetectInFlight = { key, promise };
  return promise;
}

/** Probe configured jdtls extension bundles (java-debug / java-test). */
export function lspDetectJavaBundles(): Promise<LspBundleStatus[]> {
  return invoke<LspBundleStatus[]>("lsp_detect_java_bundles");
}
