import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import type { MailRendererHost } from "../../../src/lib/mail/rendererHost.ts";

const coreRoot = fileURLToPath(new URL("../../../src/", import.meta.url));
const prefix = "\0mail-renderer-host:";

function platformModule<Service extends keyof MailRendererHost>(
  service: Service,
  names: (keyof MailRendererHost[Service])[],
) {
  return { object: `__taomniMailRendererHost.${service}`, names };
}

const modules: Record<string, { object: string; names: string[] }> = {
  react: { object: "__taomniHost.React", names: [
    "Children", "Fragment", "cloneElement", "createContext", "createElement", "forwardRef", "isValidElement", "memo",
    "useCallback", "useContext", "useDebugValue", "useEffect", "useId", "useImperativeHandle", "useInsertionEffect",
    "useLayoutEffect", "useMemo", "useReducer", "useRef", "useState", "useSyncExternalStore",
  ] },
  "react/jsx-runtime": { object: "__taomniHost.jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  "react-dom": { object: "__taomniHost.ReactDOM", names: ["createPortal", "flushSync"] },
  "lib/i18n": { object: "__taomniHost.i18n", names: ["getLocale", "useT"] },
  "components/ContextMenu": platformModule("contextMenu", ["useContextMenu"]),
  "components/sidebar/ConfirmDialog": platformModule("dialogs", ["useConfirmDialog", "useTextInputDialog"]),
  "components/terminal/FontPickerPanel": platformModule("fonts", ["FontPickerSelect"]),
  "components/theme/ThemePreviewSelect": platformModule("themeSelect", ["ThemePreviewSelect"]),
  "components/theme/themePreviews": platformModule("themePreviews", ["buildMailThemeOptions"]),
  "hooks/useModalDraggableAndResizable": platformModule("modal", ["useModalDraggableAndResizable"]),
  "lib/appTheme": platformModule("appTheme", ["useAppTheme"]),
  "lib/clipboard": platformModule("clipboard", ["readClipboardImageFiles", "readMultiFormat", "readNativeClipboardImagePath", "readText"]),
  "lib/codeThemes": platformModule("codeThemes", ["getCodeThemeDefinition", "isCodeThemeId", "terminalThemeFromCodeTheme"]),
  "lib/fileOpenTemp": platformModule("fileOpen", ["openTemporaryFile"]),
  "lib/ipc": platformModule("files", [
    "readFileBytes", "selectFolderPath", "selectSaveFilePath", "selectUploadFile", "temporaryFilePath",
    "withVaultLockedNotice", "writeStreamAbort", "writeStreamAppend", "writeStreamClose", "writeStreamOpen",
  ]),
  "lib/notifications": platformModule("notifications", ["notifyDesktop"]),
  "lib/osFileDrop": platformModule("fileDrop", ["NATIVE_FILE_DROP_EVENT", "droppedFilePaths", "droppedFiles", "isOsFileDrag", "preventDefaultForOsFileDrag"]),
  "lib/resizableLayout": platformModule("layout", ["loadResizableLayout", "saveResizableLayout"]),
  "lib/runtimeRecovery": platformModule("recovery", ["isRecoveryStartup"]),
  "lib/systemFonts": platformModule("systemFonts", [
    "SAFE_TERMINAL_FONT_FALLBACKS", "getPrimaryFontName", "isMonospaceFont", "makeTerminalFontFamily",
    "resolveSelectedFontName", "useSystemFonts", "useTerminalFontOptions",
  ]),
  "lib/terminalProfile": platformModule("terminalTheme", [
    "DEFAULT_MAIL_TERMINAL_PROFILE", "isCustomTerminalTheme", "makeCustomTerminalTheme", "resolveTerminalTheme", "resolveTerminalThemeWithSystem",
  ]),
  "lib/themes": platformModule("themes", ["getTerminalThemeDefinition", "resolveThemeId"]),
  "lib/mail/rendererServices": platformModule("mail", ["openMailTabChat", "pushMailNotification", "rememberMailCertificate", "sendMailContextToAi"]),
};

function corePath(path: string) {
  return relative(coreRoot, path).replaceAll("\\", "/");
}

function bindRendererHost(): Plugin {
  return {
    name: "taomni-mail-renderer-host",
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
        if (!id.startsWith(coreRoot)) continue;
        const path = corePath(id);
        // Mail's existing sources move with the renderer. Other application
        // code is accessed only through the platform exports above.
        if (!/^components\/mail\//.test(path) && !/^lib\/mail(?:[A-Z/]|\.ts$|to\.ts$)/.test(path)) {
          this.error(`Mail frontend bundles an application implementation: ${path}`);
        }
      }
      const entry = output["index.js"];
      // Rolldown records an inlined dynamic dependency as the entry itself.
      if (!entry || entry.type !== "chunk" || entry.imports.length
        || entry.dynamicImports.some((dependency) => dependency !== entry.fileName) || Object.keys(output).length !== 1) {
        const imports = entry?.type === "chunk" ? { static: entry.imports, dynamic: entry.dynamicImports } : null;
        this.error(`The signed Mail frontend requires one ESM entry. Output: ${Object.keys(output).join(", ")}. Imports: ${JSON.stringify(imports)}`);
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
      entry: fileURLToPath(new URL("./renderer/MailView.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
