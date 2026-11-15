import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rustFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return rustFiles(filename);
    return entry.isFile() && filename.endsWith(".rs") ? [filename] : [];
  });
}

function cargoDependencies(manifest) {
  let section = "";
  const entries = [];
  for (const original of manifest.split(/\r?\n/)) {
    const line = original.replace(/\s+#.*$/, "").trim();
    if (line.startsWith("[")) {
      const heading = line.match(/^\[([^\]]+)\]$/);
      if (heading) section = heading[1];
    } else if (/(?:^|\.)(?:build-|dev-)?dependencies$/.test(section)) {
      const dependency = line.match(/^([\w-]+)\s*=\s*(.*)$/);
      if (dependency) entries.push({ section, name: dependency[1], value: dependency[2] });
    }
  }
  return entries;
}

function sharedRdpViolations(root) {
  const errors = [];
  for (const consumer of ["servers", "config"]) {
    for (const filename of rustFiles(path.join(root, "src-tauri/src", consumer))) {
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const source = fs.readFileSync(filename, "utf8").replace(/\/\/[^\n]*/g, "");
      if (/\bcrate\s*::\s*rdp\b|\buse\s+crate\s*::\s*\{[^;]*\brdp\s*::/.test(source)) {
        errors.push(`${relative}: ${consumer} must use shared RDP libraries, not the RDP client`);
      }
    }
  }
  for (const name of ["taomni-file-uri", "taomni-rdp-common"]) {
    const directory = path.join(root, "src-tauri/crates", name);
    const manifest = fs.readFileSync(path.join(directory, "Cargo.toml"), "utf8");
    for (const match of manifest.matchAll(/\bpackage\s*=\s*"(tauri(?:-[^"\s]+)?|wry|taomni|taomni-plugin-[^"\s]+)"/g)) {
      errors.push(`${name}/Cargo.toml: aliased dependency links application/plugin package ${match[1]}`);
    }
    for (const { section, name: dependency, value } of cargoDependencies(manifest)) {
      const packageName = value.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1] ?? dependency;
      const dependencyPath = value.match(/\bpath\s*=\s*"([^"]+)"/)?.[1];
      const resolvedPath = dependencyPath ? path.resolve(directory, dependencyPath) : undefined;
      if (/^(?:tauri(?:-|$)|wry$|taomni$|taomni-plugin-)/.test(packageName)
        || resolvedPath === path.join(root, "src-tauri")
        || resolvedPath?.startsWith(path.join(root, "src-tauri/plugins") + path.sep)) {
        errors.push(`${name}/Cargo.toml: ${section}.${dependency} links application/plugin state`);
      }
      if (name === "taomni-file-uri" && !/(?:^|\.)dev-dependencies$/.test(section)) {
        errors.push(`${name}/Cargo.toml: URI conversion must have zero runtime/build dependencies`);
      }
    }
    for (const filename of rustFiles(path.join(directory, "src"))) {
      const source = fs.readFileSync(filename, "utf8").replace(/\/\/[^\n]*/g, "");
      if (/\b(?:tauri(?:_[\w]+)?|wry|taomni_lib|taomni_plugin_[\w]+)::|\bcrate::(?:state|servers|rdp|config|vault)::/.test(source)) {
        errors.push(`${path.relative(root, filename)}: shared library must not import application/plugin state`);
      }
    }
  }
  return errors;
}

/** Return all violations, so one CI run identifies every broken ownership edge. */
export function modularBoundaryViolations(root, { linuxTreeFile } = {}) {
  const errors = sharedRdpViolations(root);
  const consumers = ["screenshot", "mfa", "mobile"];
  for (const consumer of consumers) {
    for (const filename of rustFiles(path.join(root, "src-tauri/src", consumer))) {
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/\b(?:crate::)?servers::/.test(line) || /^\s*\/\//.test(line)) return;
        // S15: this one legacy table initialization stays until TASK-024.
        if (relative === "src-tauri/src/mobile/headless.rs"
          && /^\s*crate::servers::db::init_server_tables\(&db\)\.map_err\(\|e\| e\.to_string\(\)\)\?;$/.test(line)) return;
        errors.push(`${relative}:${index + 1}: ${consumer} must depend on core capture, not Servers`);
      });
    }
  }

  const captureRoot = path.join(root, "src-tauri/crates/taomni-capture");
  const manifest = fs.readFileSync(path.join(captureRoot, "Cargo.toml"), "utf8");
  // Also reject Cargo package aliases written as multiline inline tables.
  for (const match of manifest.matchAll(/\bpackage\s*=\s*"(tauri(?:-[^"\s]+)?|wry|taomni)"/g)) {
    errors.push(`taomni-capture/Cargo.toml: aliased dependency links application/WebView package ${match[1]}`);
  }
  for (const { section, name, value } of cargoDependencies(manifest)) {
    const packageName = value.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1] ?? name;
    if (/^(?:tauri(?:-|$)|wry$|taomni$)/.test(packageName)) {
      errors.push(`taomni-capture/Cargo.toml: ${section}.${name} links application/WebView package ${packageName}`);
    }
    if (packageName === "xcap") {
      const desktopTarget = /^target\.'cfg\((?:windows|target_os\s*=\s*"(?:macos|windows)")\)'\.(?:build-|dev-)?dependencies$/.test(section);
      if (!desktopTarget) errors.push(`taomni-capture/Cargo.toml: xcap must be limited to Windows/macOS, found ${section}`);
    }
  }
  for (const filename of rustFiles(path.join(captureRoot, "src"))) {
    const relative = path.relative(root, filename).split(path.sep).join("/");
    fs.readFileSync(filename, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (/^\s*\/\//.test(line)) return;
      if (/\b(?:tauri(?:_[\w]+)?|wry|taomni_lib)::|\bcrate::(?:servers|screenshot|state)::/.test(line)) {
        errors.push(`${relative}:${index + 1}: capture library must not import application/WebView state`);
      }
    });
  }

  if (linuxTreeFile) {
    const tree = fs.readFileSync(linuxTreeFile, "utf8");
    if (!/^taomni-capture v/m.test(tree)) errors.push("Linux cargo tree does not identify taomni-capture as its root");
    for (const forbidden of ["xcap", "tauri", "tauri-utils", "wry"]) {
      if (new RegExp(`(?:^|[\\s─])${forbidden} v\\d`, "m").test(tree)) {
        errors.push(`Linux taomni-capture dependency tree contains ${forbidden}`);
      }
    }
  }
  return errors;
}

export function checkModularBoundaries(root = repository, options = {}) {
  const errors = modularBoundaryViolations(root, options);
  if (errors.length) {
    throw new Error(`Modular boundary checks failed:\n${errors.map((message) => `- ${message}`).join("\n")}`);
  }
  console.log(`Modular capture/RDP boundaries passed${options.linuxTreeFile ? "; Linux dependency tree checked" : ""}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const treeIndex = process.argv.indexOf("--linux-tree");
  try {
    if (treeIndex >= 0 && !process.argv[treeIndex + 1]) throw new Error("--linux-tree requires a cargo tree output path");
    checkModularBoundaries(repository, { linuxTreeFile: treeIndex >= 0 ? process.argv[treeIndex + 1] : undefined });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
