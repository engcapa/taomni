/**
 * Front-end wrapper around `tauri-plugin-updater` / `tauri-plugin-process`.
 *
 * Everything here is a no-op outside the desktop app (browser dev server), so
 * callers don't need to guard. The one piece the plugin can't answer — which
 * architecture packages the user may install — comes from the Rust
 * `updater_platform` command; the chosen target is then handed to
 * `check({ target })`. See claudedocs/auto-update-plan.md.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauriRuntime, getAppPlatform } from "./runtime";

export interface UpdaterPlatform {
  os: string;
  nativeTarget: string;
  recommendedTarget: string;
  candidates: string[];
  isRosetta: boolean;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string;
}

export interface DownloadProgress {
  downloaded: number;
  /** Total bytes; null when the server didn't send a content length. */
  total: number | null;
  /** 0–100, or null when total is unknown. */
  percent: number | null;
}

// One resolved Update per target key (e.g. "darwin-x86_64"). check() resolves
// to a single platform entry, so we keep them apart and reuse at install time.
const updateCache = new Map<string, Update>();
const downloadedCache = new Map<string, Update>();
const checkGenerations = new Map<string, number>();

export interface DownloadOptions {
  signal?: AbortSignal;
  onInstalling?: () => void;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Update download cancelled", "AbortError");
}

export async function discardDownloadedUpdate(target?: string): Promise<void> {
  const key = target ?? "";
  const update = downloadedCache.get(key);
  downloadedCache.delete(key);
  if (update) await closeUpdate(update);
}

async function closeUpdate(update: Update): Promise<void> {
  try {
    await update.close();
  } catch {
    // Resource cleanup is best-effort; never replace the operation's outcome.
  }
}
const SOCKSCAP_UPDATE_SUDO_REQUIRED = "SOCKSCAP_UPDATE_SUDO_REQUIRED:";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isSocksCapUpgradeAuthorizationRequired(error: unknown): boolean {
  return errorText(error).includes(SOCKSCAP_UPDATE_SUDO_REQUIRED);
}

export function isSudoAuthenticationError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return (
    message.includes("incorrect password") ||
    message.includes("authentication failure") ||
    message.includes("sudo authentication failed") ||
    message.includes("sorry, try again") ||
    message.includes("a password is required")
  );
}

function devOsToken(): string {
  switch (getAppPlatform()) {
    case "macos":
      return "darwin";
    case "windows":
      return "windows";
    default:
      return "linux";
  }
}

/**
 * Resolved application-proxy URL (Settings → Application Proxy), or undefined
 * for a direct connection. `tauri-plugin-updater` applies the `proxy` option
 * to BOTH the manifest check and the binary download, so threading it into
 * `check()` is enough to route the whole update flow. Never throws — a proxy
 * lookup failure degrades to a direct connection.
 */
async function appProxyUrl(): Promise<string | undefined> {
  if (!isTauriRuntime()) return undefined;
  try {
    const url = await invoke<string | null>("get_app_proxy_url");
    return url ?? undefined;
  } catch {
    return undefined;
  }
}

/** Merge target + proxy into the plugin's CheckOptions (undefined when empty). */
function checkOptions(target?: string, proxy?: string): { target?: string; proxy?: string } | undefined {
  const opts: { target?: string; proxy?: string } = {};
  if (target) opts.target = target;
  if (proxy) opts.proxy = proxy;
  return Object.keys(opts).length > 0 ? opts : undefined;
}


async function pluginCheck(target?: string): Promise<Update | null> {
  if (__TAOMNI_QA_UPDATER__) {
    const result = await invoke<{
      configured: boolean;
      update: ConstructorParameters<typeof import("@tauri-apps/plugin-updater").Update>[0] | null;
    }>("qa_updater_check", { target });
    if (result.configured) {
      const { Update } = await import("@tauri-apps/plugin-updater");
      return result.update ? new Update(result.update) : null;
    }
  }
  const { check } = await import("@tauri-apps/plugin-updater");
  return check(checkOptions(target, await appProxyUrl()));
}

export async function getUpdaterPlatform(): Promise<UpdaterPlatform> {
  if (!isTauriRuntime()) {
    const os = devOsToken();
    const nativeTarget = `${os}-x86_64`;
    return { os, nativeTarget, recommendedTarget: nativeTarget, candidates: [nativeTarget], isRosetta: false };
  }
  return invoke<UpdaterPlatform>("updater_platform");
}

/**
 * Check for an update for a specific target (defaults to the running binary's
 * own target). Caches the resolved Update so install can reuse it. Returns null
 * when there's no newer version for that target.
 */
export async function checkForUpdate(target?: string): Promise<AvailableUpdate | null> {
  if (!isTauriRuntime()) return null;
  const key = target ?? "";
  const generation = (checkGenerations.get(key) ?? 0) + 1;
  checkGenerations.set(key, generation);
  const update = await pluginCheck(target);
  if (checkGenerations.get(key) !== generation) {
    if (update) await closeUpdate(update);
    return null;
  }

  const prev = updateCache.get(key);
  if (prev && prev !== update) await closeUpdate(prev);
  if (checkGenerations.get(key) !== generation) {
    if (update) await closeUpdate(update);
    return null;
  }

  if (!update) {
    updateCache.delete(key);
    return null;
  }
  updateCache.set(key, update);
  return { version: update.version, currentVersion: update.currentVersion, notes: update.body ?? "" };
}

/**
 * Release SocksCap's OS capture state before install/relaunch.
 *
 * On Windows, while SocksCap captures, the WinDivert kernel driver keeps
 * `WinDivert64.sys` locked and the elevated helper keeps its own exe + DLL
 * locked. A per-user installer runs unelevated and cannot stop either, so the
 * upgrade would fail with "Error opening file for writing". The app asks its
 * elevated helper to close the driver handles and exit first. Linux must also
 * restore nftables/cgroups while its async runtime and stored sudo credential
 * are still available; macOS disables Redirector interception over IPC. A cleanup failure blocks the
 * transition so the app cannot silently strand network state.
 */
async function prepareSocksCapForUpgrade(sudoPassword?: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sockscap_prepare_for_update", { sudoPassword });
}

/**
 * Install an already-downloaded update after SocksCap cleanup succeeds.
 * Exported separately so Linux can request sudo authorization and resume the
 * installation without downloading the package a second time.
 */
export async function installDownloadedUpdate(
  target: string | undefined,
  sudoPassword?: string,
): Promise<void> {
  const key = target ?? "";
  const update = downloadedCache.get(key);
  if (!update) throw new Error("The downloaded update is no longer available. Download it again.");
  try {
    await prepareSocksCapForUpgrade(sudoPassword);
    await update.install();
  } catch (error) {
    if (!isSocksCapUpgradeAuthorizationRequired(error) && !isSudoAuthenticationError(error)) {
      downloadedCache.delete(key);
      await closeUpdate(update);
    }
    throw error;
  }
  downloadedCache.delete(key);
  await closeUpdate(update);
}

/**
 * Download the update for `target`, release SocksCap's OS capture state, then
 * install — leaving the app running until the caller decides to relaunch
 * (confirmation gate #2). Reuses the Update from a prior checkForUpdate(target)
 * when available.
 *
 * Download and install are run as separate steps (not `downloadAndInstall`) so
 * SocksCap can be torn down in between: capture must keep working during the
 * download, but the driver/helper must be gone before the installer writes.
 */
export async function downloadAndInstall(
  target: string | undefined,
  onProgress: (p: DownloadProgress) => void,
  options: DownloadOptions = {},
): Promise<void> {
  if (!isTauriRuntime()) throw new Error("Updates are only available in the desktop app.");
  const { signal, onInstalling } = options;
  throwIfCancelled(signal);
  const key = target ?? "";
  let update = updateCache.get(key);
  // Transfer ownership out of the check cache. A retry/check must not close or
  // reuse a handle whose old download is still delivering IPC progress events.
  updateCache.delete(key);
  if (!update) {
    throwIfCancelled(signal);
    update = (await pluginCheck(target)) ?? undefined;
    if (!update) throw new Error("No update is available for the selected package.");
  }
  let total: number | null = null;
  let downloaded = 0;
  let downloadedHandle = false;
  try {
    throwIfCancelled(signal);
    const previous = downloadedCache.get(key);
    downloadedCache.delete(key);
    if (previous && previous !== update) await closeUpdate(previous);
    throwIfCancelled(signal);
    await update.download((event) => {
      if (signal?.aborted) return;
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? null;
          downloaded = 0;
          onProgress({ downloaded, total, percent: total ? 0 : null });
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onProgress({
            downloaded,
            total,
            percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
          });
          break;
        case "Finished":
          onProgress({ downloaded, total, percent: 100 });
          break;
      }
    });
    // Tauri's download IPC has no transport-abort API. Cancellation detaches
    // progress immediately; its eventual bytes are discarded, never installed.
    throwIfCancelled(signal);
    onProgress({ downloaded, total, percent: 100 });
    throwIfCancelled(signal);
    downloadedCache.set(key, update);
    downloadedHandle = true;
    onInstalling?.();
    await installDownloadedUpdate(target);
  } finally {
    // Once bytes are downloaded, installDownloadedUpdate owns cleanup (or
    // retains them for sudo authorization). Failed/cancelled transfers own it here.
    if (!downloadedHandle) await closeUpdate(update);
  }
}

/** Restart into the freshly installed version (confirmation gate #2). */
export async function relaunchApp(): Promise<void> {
  if (!isTauriRuntime()) return;
  // The user can start SocksCap again after installation but before accepting
  // the relaunch prompt, so teardown once more immediately before exit.
  await prepareSocksCapForUpgrade();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
