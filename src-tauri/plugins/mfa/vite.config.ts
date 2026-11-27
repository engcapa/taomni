import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import type { MfaRendererHost } from "../../../src/lib/mfa/rendererHost.ts";

const coreRoot = fileURLToPath(new URL("../../../src/", import.meta.url));
const prefix = "\0mfa-renderer-host:";
const sharedFiles = new Set([
  "base32", "format", "migration", "otpauth", "qrImage", "qrSvg", "sort", "sources", "types",
].map((name) => `lib/mfa/${name}.ts`));

function service<Key extends keyof MfaRendererHost>(key: Key, names: (keyof MfaRendererHost[Key])[]) {
  return { object: `__taomniMfaRendererHost.${key}`, names };
}

const modules: Record<string, { object: string; names: string[] }> = {
  react: { object: "__taomniHost.React", names: [
    "createContext", "createElement", "forwardRef", "useCallback", "useContext", "useEffect", "useId", "useLayoutEffect",
    "useMemo", "useRef", "useState",
  ] },
  "react-dom": { object: "__taomniHost.ReactDOM", names: ["createPortal"] },
  "react/jsx-runtime": { object: "__taomniHost.jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  "lib/i18n": { object: "__taomniHost.i18n", names: ["useT"] },
  "stores/mfaStore": service("store", ["useMfaStore"]),
  "stores/vaultStore": service("vault", ["requireVaultUnlock", "useVaultStore", "vaultSessionIsCurrent"]),
  "components/vault/VaultGate": service("vault", ["VaultGate"]),
  "components/vault/VaultSetupDialog": service("vault", ["VaultSetupDialog"]),
  "components/vault/VaultUnlockDialog": service("vault", ["VaultUnlockDialog"]),
  "stores/app/layoutSlice": service("floating", ["FLOATING_MFA_WIDTH"]),
  "lib/mfa/rendererServices": service("floating", ["isFloatingMfaOpen", "useFloatingMfa"]),
  "lib/appDialogs": service("dialogs", ["confirmAppDialog"]),
  "components/ContextMenu": service("dialogs", ["useContextMenu"]),
  "lib/clipboard": service("clipboard", ["readClipboardImageFiles", "writeText"]),
  "lib/customDnD": service("drag", ["startCustomDrag", "useCustomDropTarget"]),
  "lib/osFileDrop": service("drag", ["NATIVE_FILE_DROP_EVENT"]),
  "lib/ipc": service("files", ["readFileBytes"]),
  "lib/runtime": service("runtime", ["isTauriRuntime"]),
  "lib/mfa/ipc": service("commands", ["mfaCaptureScreens", "mfaExportUri", "mfaReadClipboardImage", "mfaScanScreenTexts"]),
};

function corePath(path: string) {
  return relative(coreRoot, path).replaceAll("\\", "/");
}

function bindRendererHost(): Plugin {
  return {
    name: "taomni-mfa-renderer-host",
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
        if (id.startsWith(coreRoot) && !sharedFiles.has(corePath(id))) {
          this.error(`MFA frontend bundles an application implementation: ${corePath(id)}`);
        }
      }
      const entry = output["index.js"];
      // Rolldown can report an inlined dependency as a self-import.
      if (!entry || entry.type !== "chunk" || entry.imports.length
        || entry.dynamicImports.some((dependency) => dependency !== entry.fileName) || Object.keys(output).length !== 1) {
        this.error(`The signed MFA frontend requires one ESM entry. Output: ${Object.keys(output).join(", ")}`);
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
      entry: fileURLToPath(new URL("./renderer/MfaView.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
