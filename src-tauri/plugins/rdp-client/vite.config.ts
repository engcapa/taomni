import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const hostModules = {
  react: {
    source: "__taomniHost.React",
    names: ["createContext", "createElement", "forwardRef", "useCallback", "useContext", "useDebugValue", "useEffect", "useInsertionEffect",
      "useMemo", "useRef", "useState", "useSyncExternalStore"],
  },
  "react/jsx-runtime": { source: "__taomniHost.jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  zustand: { source: "__taomniHost.zustand", names: ["create", "createStore", "useStore"] },
  rdpViewerHost: {
    source: "__taomniRdpViewerHost",
    names: ["confirmAppDialog", "readFiles", "readText", "writeFiles", "writeText", "t", "useT",
      "isTauriRuntime", "getCurrentWindow", "rdpConnect", "rdpDisconnect", "rdpTrustCertificate",
      "ScreenshotMenuButton", "TabActions", "FT_BUTTON_ACTIVE_OVERRIDE", "FT_BUTTON_STYLE", "FT_ICON_BUTTON_STYLE", "FT_SEPARATOR_STYLE"],
  },
};
const prefix = "\0rdp-viewer-host:";
const coreSource = fileURLToPath(new URL("../../../src/", import.meta.url)).replaceAll("\\", "/");

function shareHostModules(): Plugin {
  return {
    name: "taomni-rdp-viewer-host",
    enforce: "pre",
    resolveId(source) {
      const contract = source.endsWith("/lib/rdpViewerHost") ? "rdpViewerHost" : source;
      if (Object.hasOwn(hostModules, contract)) return `${prefix}${contract}`;
    },
    load(id) {
      if (!id.startsWith(prefix)) return;
      const { source, names } = hostModules[id.slice(prefix.length) as keyof typeof hostModules];
      return `const host = globalThis.${source};\nexport default host;\nexport const { ${names.join(", ")} } = host;`;
    },
    generateBundle(_options, output) {
      for (const id of this.getModuleIds()) {
        if (id.startsWith(coreSource)) this.error(`RDP viewer bundles core code: ${id.slice(coreSource.length)}`);
      }
      const entry = output["index.js"];
      if (!entry || entry.type !== "chunk" || entry.imports.length || entry.dynamicImports.length || Object.keys(output).length !== 1) {
        this.error("The signed RDP viewer requires a self-contained ESM entry");
      }
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [shareHostModules(), react()],
  build: {
    target: ["es2020", "safari16"],
    outDir: fileURLToPath(new URL("./dist/frontend", import.meta.url)),
    lib: {
      entry: fileURLToPath(new URL("./renderer/RdpPanel.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
