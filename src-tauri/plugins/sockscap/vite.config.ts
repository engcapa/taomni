import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import type { SocksCapRendererHost } from "../../../src/lib/sockscap/rendererHost.ts";

const coreRoot = fileURLToPath(new URL("../../../src/", import.meta.url));
const prefix = "\0sockscap-renderer-host:";
const sharedSources = new Set([
  "lib/sessionPaths.ts",
  "lib/sockscapPreflight.ts",
  "lib/sockscap/recoveryErrors.ts",
]);

function service<Key extends keyof SocksCapRendererHost>(key: Key, names: (keyof SocksCapRendererHost[Key])[]) {
  return { object: `__taomniSocksCapRendererHost.${key}`, names };
}

const modules: Record<string, { object: string; names: string[] }> = {
  react: { object: "__taomniHost.React", names: [
    "Fragment", "createContext", "createElement", "forwardRef", "useCallback", "useContext", "useEffect", "useId", "useLayoutEffect",
    "useMemo", "useRef", "useState",
  ] },
  "react/jsx-runtime": { object: "__taomniHost.jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  "react-dom": { object: "__taomniHost.ReactDOM", names: ["createPortal"] },
  "lib/i18n": { object: "__taomniHost.i18n", names: ["useT"] },
  "@tauri-apps/plugin-dialog": service("dialogs", ["open"]),
  "components/ElevationPasswordPrompt": service("dialogs", ["ElevationPasswordPrompt"]),
  "lib/clipboard": service("clipboard", ["writeText"]),
  "lib/ipc": service("ipc", ["VAULT_LOCKED_EVENT", "listSessions", "vaultPut", "vaultStatus"]),
  "lib/runtime": service("runtime", ["isTauriRuntime"]),
  "lib/sockscap/rendererServices": service("terminal", ["openSocksCapTerminal"]),
  "lib/vaultGate": service("vaultGate", ["ensureVaultReady"]),
  "lib/sockscap": service("commands", [
    "sockscapCapabilities", "sockscapClearDomainRecords", "sockscapDetectLocalProxies",
    "sockscapDetectTunConflicts", "sockscapDiagnostics", "sockscapGetConfig", "sockscapGetDomainRecords",
    "sockscapGfwlistStatus", "sockscapHelperStatus", "sockscapImportRules", "sockscapImportSubscription",
    "sockscapInstallRedirector", "sockscapLaunchApp", "sockscapLaunchedApps", "sockscapListProcesses",
    "sockscapParseShareLink", "sockscapRecover", "sockscapRedirectorInstallStatus", "sockscapRefreshGfwlist",
    "sockscapSetConfig", "sockscapStart", "sockscapStatsSnapshot", "sockscapStatus", "sockscapStop",
    "sockscapStopLaunchedApp", "sockscapTestCoreUpstream", "sockscapTestTarget", "sockscapTestUpstream",
    "sockscapValidateMacosApp", "upstreamRequiresCore",
  ]),
};

function corePath(path: string) {
  return relative(coreRoot, path).replaceAll("\\", "/");
}

function bindRendererHost(): Plugin {
  return {
    name: "taomni-sockscap-renderer-host",
    enforce: "pre",
    resolveId(source, importer) {
      const key = source.startsWith(".") && importer
        ? corePath(resolve(dirname(importer), source)).replace(/\.(ts|tsx)$/, "")
        : source;
      if (Object.hasOwn(modules, key)) return `${prefix}${key}`;
    },
    load(id) {
      if (!id.startsWith(prefix)) return;
      const { object, names } = modules[id.slice(prefix.length)];
      return `const service = globalThis.${object};\nexport default service;\nexport const { ${names.join(", ")} } = service;`;
    },
    generateBundle(_options, output) {
      for (const id of this.getModuleIds()) {
        if (id.startsWith(coreRoot) && !sharedSources.has(corePath(id))) {
          this.error(`SocksCap frontend bundles an application implementation: ${corePath(id)}`);
        }
      }
      const entry = output["index.js"];
      if (!entry || entry.type !== "chunk" || entry.imports.length || entry.dynamicImports.length || Object.keys(output).length !== 1) {
        this.error(`The signed SocksCap frontend requires one ESM entry. Output: ${Object.keys(output).join(", ")}`);
      }
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [bindRendererHost(), tailwindcss(), react()],
  build: {
    target: ["es2020", "safari16"],
    rolldownOptions: { output: { codeSplitting: false } },
    outDir: fileURLToPath(new URL("./dist/frontend", import.meta.url)),
    lib: {
      entry: fileURLToPath(new URL("./renderer/SocksCapViewEntry.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
