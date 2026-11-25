import { open } from "@tauri-apps/plugin-dialog";
import { ElevationPasswordPrompt } from "../../components/ElevationPasswordPrompt";
import { writeText } from "../clipboard";
import { VAULT_LOCKED_EVENT, listSessions, vaultPut, vaultStatus } from "../ipc";
import { isTauriRuntime } from "../runtime";
import {
  sockscapCapabilities, sockscapClearDomainRecords, sockscapDetectLocalProxies,
  sockscapDetectTunConflicts, sockscapDiagnostics, sockscapGetConfig, sockscapGetDomainRecords,
  sockscapGfwlistStatus, sockscapHelperStatus, sockscapImportRules, sockscapImportSubscription,
  sockscapInstallRedirector, sockscapLaunchApp, sockscapLaunchedApps, sockscapListProcesses,
  sockscapParseShareLink, sockscapRecover, sockscapRedirectorInstallStatus, sockscapRefreshGfwlist,
  sockscapSetConfig, sockscapStart, sockscapStatsSnapshot, sockscapStatus, sockscapStop,
  sockscapStopLaunchedApp, sockscapTestCoreUpstream, sockscapTestTarget, sockscapTestUpstream,
  sockscapValidateMacosApp, upstreamRequiresCore,
} from "../sockscap";
import { ensureVaultReady } from "../vaultGate";
import { openSocksCapTerminal } from "./rendererServices";

const host = {
  commands: {
    sockscapCapabilities, sockscapClearDomainRecords, sockscapDetectLocalProxies,
    sockscapDetectTunConflicts, sockscapDiagnostics, sockscapGetConfig, sockscapGetDomainRecords,
    sockscapGfwlistStatus, sockscapHelperStatus, sockscapImportRules, sockscapImportSubscription,
    sockscapInstallRedirector, sockscapLaunchApp, sockscapLaunchedApps, sockscapListProcesses,
    sockscapParseShareLink, sockscapRecover, sockscapRedirectorInstallStatus, sockscapRefreshGfwlist,
    sockscapSetConfig, sockscapStart, sockscapStatsSnapshot, sockscapStatus, sockscapStop,
    sockscapStopLaunchedApp, sockscapTestCoreUpstream, sockscapTestTarget, sockscapTestUpstream,
    sockscapValidateMacosApp, upstreamRequiresCore,
  },
  dialogs: { open, ElevationPasswordPrompt },
  clipboard: { writeText },
  ipc: { VAULT_LOCKED_EVENT, listSessions, vaultPut, vaultStatus },
  runtime: { isTauriRuntime },
  terminal: { openSocksCapTerminal },
  vaultGate: { ensureVaultReady },
};

export type SocksCapRendererHost = typeof host;

export function installSocksCapRendererHost() {
  for (const service of Object.values(host)) Object.freeze(service);
  Object.defineProperty(globalThis, "__taomniSocksCapRendererHost", { value: Object.freeze(host) });
}
