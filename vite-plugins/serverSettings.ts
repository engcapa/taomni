import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import type { ServerSettingsRendererHost } from "../src/lib/servers/rendererHost.ts";

const coreRoot = fileURLToPath(new URL("../src/", import.meta.url));
const prefix = "\0server-settings-host:";

function service<Key extends keyof ServerSettingsRendererHost>(
  key: Key,
  names: (keyof ServerSettingsRendererHost[Key])[],
) {
  return { object: `__taomniServerSettingsRendererHost.${key}`, names };
}

const modules: Record<string, { object: string; names: string[] }> = {
  react: { object: "__taomniHost.React", names: ["useCallback", "useEffect", "useState"] },
  "react/jsx-runtime": { object: "__taomniHost.jsxRuntime", names: ["Fragment", "jsx", "jsxs"] },
  "lib/i18n": { object: "__taomniHost.i18n", names: ["useT"] },
  "components/servers/fields": service("fields", [
    "CheckboxField", "FieldNote", "FormRow", "NumberField", "PasswordField", "PathField",
    "RadioField", "SelectField", "TextField",
  ]),
  "lib/runtime": service("runtime", ["getAppPlatform"]),
  "lib/servers": service("commands", ["openSystemRdpSettings", "probeRdpCapture", "probeSystemRdp"]),
};

function bindRendererHost(): Plugin {
  return {
    name: "taomni-server-settings-host",
    enforce: "pre",
    resolveId(source, importer) {
      const key = source.startsWith(".") && importer
        ? relative(coreRoot, resolve(dirname(importer), source)).replaceAll("\\", "/").replace(/\.(ts|tsx)$/, "")
        : source;
      if (Object.hasOwn(modules, key)) return `${prefix}${key}`;
    },
    load(id) {
      if (!id.startsWith(prefix)) return;
      const { object, names } = modules[id.slice(prefix.length)];
      return `const service = globalThis.${object};\nexport const { ${names.join(", ")} } = service;`;
    },
    generateBundle(_options, output) {
      const normalizedRoot = coreRoot.replaceAll("\\", "/");
      for (const id of this.getModuleIds()) {
        if (id.replaceAll("\\", "/").startsWith(normalizedRoot)) {
          this.error(`Server settings bundles application implementation: ${id}`);
        }
      }
      const entry = output["index.js"];
      if (!entry || entry.type !== "chunk" || entry.imports.length
        || entry.dynamicImports.length || Object.keys(output).length !== 1) {
        this.error("Signed server settings require one self-contained ESM entry");
      }
    },
  };
}

export function serverSettingsConfig(configuration: string, entry: string) {
  return defineConfig({
    publicDir: false,
    plugins: [bindRendererHost(), react()],
    build: {
      target: ["es2020", "safari16"],
      outDir: fileURLToPath(new URL("./dist/frontend", configuration)),
      lib: {
        entry: fileURLToPath(new URL(`./renderer/${entry}`, configuration)),
        formats: ["es"],
        fileName: () => "index.js",
      },
    },
  });
}
