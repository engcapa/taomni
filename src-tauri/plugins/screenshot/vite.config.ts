import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { screenshotOcrPlugin } from "../../../vite-plugins/screenshotOcr.ts";

const root = fileURLToPath(new URL("../../../src/", import.meta.url));
const prefix = "\0screenshot-recorder-host:";
const bindings: Record<string, { value: string; names: string[] }> = {
  react: { value: "__taomniHost.React", names: [
    "createContext", "createElement", "forwardRef", "useCallback", "useContext", "useEffect",
    "useMemo", "useRef", "useState",
  ] },
  "react/jsx-runtime": { value: "__taomniHost.jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  "lib/i18n": { value: "__taomniHost.i18n", names: ["useT"] },
  "lib/appDialogs": { value: "__taomniScreenshotHost", names: ["formatUnknownError"] },
  "lib/screenshot": { value: "__taomniScreenshotHost.recorder", names: [
    "RECORDING_ENDED_EVENT", "cancelRecording", "closeScreenshotOverlay", "copyImageToClipboard",
    "currentRecording", "loadScreenshotUrl", "recordingStatus", "revokeScreenshotUrl", "saveImageToFile",
    "stopRecording",
  ] },
  "@tauri-apps/api/event": { value: "__taomniScreenshotHost", names: ["listen"] },
  "@tauri-apps/api/window": { value: "__taomniScreenshotHost", names: ["LogicalSize", "getCurrentWindow"] },
  "@tauri-apps/plugin-dialog": { value: "__taomniScreenshotHost", names: ["save"] },
};

function bindRecorderHost(): Plugin {
  return {
    name: "taomni-screenshot-recorder-host",
    enforce: "pre",
    resolveId(source, importer) {
      const key = source.startsWith(".") && importer
        ? relative(root, resolve(dirname(importer), source)).replaceAll("\\", "/").replace(/\.(ts|tsx)$/, "")
        : source;
      if (Object.hasOwn(bindings, key)) return `${prefix}${key}`;
    },
    load(id) {
      if (!id.startsWith(prefix)) return;
      const { value, names } = bindings[id.slice(prefix.length)];
      return `const service = globalThis.${value};\nexport default service;\nexport const { ${names.join(", ")} } = service;`;
    },
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (id.startsWith(root)) this.error(`The Screenshot module includes core implementation ${id}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [bindRecorderHost(), screenshotOcrPlugin()],
  build: {
    target: ["es2020", "safari16"],
    outDir: fileURLToPath(new URL("./dist/frontend", import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: {
        index: fileURLToPath(new URL("./renderer/index.ts", import.meta.url)),
        recorder: fileURLToPath(new URL("./renderer/RecorderBar.tsx", import.meta.url)),
      },
      formats: ["es"],
      fileName: (_, name) => `${name}.js`,
    },
  },
});
