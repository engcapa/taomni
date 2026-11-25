import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const shared = {
  react: {
    object: "__taomniHost.React",
    names: ["createContext", "createElement", "forwardRef", "useCallback", "useContext", "useDebugValue", "useEffect", "useInsertionEffect",
      "useMemo", "useRef", "useState", "useSyncExternalStore"],
  },
  "react/jsx-runtime": { object: "__taomniHost.jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  zustand: { object: "__taomniHost.zustand", names: ["create", "createStore", "useStore"] },
  viewerHost: {
    object: "__taomniVncViewerHost",
    names: ["getAppPlatform", "isTauriRuntime", "readMultiFormat", "readNativeTextResult", "readText",
      "writeMultiFormat", "writeText", "t", "useT", "vncCancelConnect", "vncConnect", "vncDisconnect",
      "useContextMenu", "useFocusReturn", "FT_BUTTON_STYLE", "FT_ICON_BUTTON_STYLE", "FT_SEPARATOR_STYLE",
      "ScreenshotMenuButton", "TabActions", "getViewerWindow", "setVncSpecialKeyCapture", "listenVncSpecialKey"],
  },
};
const virtualPrefix = "\0vnc-viewer-host:";
const coreSource = fileURLToPath(new URL("../../../src/", import.meta.url)).replaceAll("\\", "/");

function sharedViewerHost(): Plugin {
  return {
    name: "taomni-vnc-viewer-host",
    enforce: "pre",
    resolveId(source) {
      const contract = source.endsWith("/lib/vnc/viewerHost") ? "viewerHost" : source;
      if (Object.hasOwn(shared, contract)) return `${virtualPrefix}${contract}`;
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return;
      const { object, names } = shared[id.slice(virtualPrefix.length) as keyof typeof shared];
      return `const host = globalThis.${object};\nexport default host;\nexport const { ${names.join(", ")} } = host;`;
    },
    generateBundle(_options, output) {
      for (const id of this.getModuleIds()) {
        if (!id.startsWith(coreSource)) continue;
        const path = id.slice(coreSource.length);
        if (!/^lib\/(vnc\/(?:viewerProtocol|keyboard|pointer|wire|scaling|validation)|vncOptions|terminal\/keyboardGuards)\.ts$/.test(path)) {
          this.error(`VNC frontend bundled a core implementation: ${path}`);
        }
      }
      const entry = output["index.js"];
      if (!entry || entry.type !== "chunk" || entry.imports.length || entry.dynamicImports.length || Object.keys(output).length !== 1) {
        this.error("The signed VNC frontend must be a single self-contained ESM entry");
      }
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [sharedViewerHost(), tailwindcss(), react()],
  build: {
    target: ["es2020", "safari16"],
    outDir: fileURLToPath(new URL("./dist/frontend", import.meta.url)),
    lib: {
      entry: fileURLToPath(new URL("./renderer/VncPanel.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
