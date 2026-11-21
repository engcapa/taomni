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

function sharedLibraryViolations(root) {
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
  for (const name of ["taomni-file-uri", "taomni-rdp-common", "taomni-rdp-client-api", "taomni-rdp-client-engine", "taomni-mail-engine", "taomni-vnc-api", "taomni-vnc-engine", "taomni-vnc-key-protocol", "taomni-redirector", "taomni-screenshot-api", "taomni-screenshot-ocr", "taomni-screenshot-recording", "taomni-server-process", "taomni-local-servers-engine", "taomni-pty"]) {
    const directory = path.join(root, "src-tauri/crates", name);
    const manifest = fs.readFileSync(path.join(directory, "Cargo.toml"), "utf8");
    const usesRoutedTcp = name === "taomni-rdp-client-api" || name === "taomni-screenshot-api";
    for (const match of manifest.matchAll(/\bpackage\s*=\s*"(tauri(?:-[^"\s]+)?|wry|taomni|taomni-plugin-[^"\s]+)"/g)) {
      errors.push(`${name}/Cargo.toml: aliased dependency links application/plugin package ${match[1]}`);
    }
    for (const { section, name: dependency, value } of cargoDependencies(manifest)) {
      const packageName = value.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1] ?? dependency;
      const dependencyPath = value.match(/\bpath\s*=\s*"([^"]+)"/)?.[1];
      const resolvedPath = dependencyPath ? path.resolve(directory, dependencyPath) : undefined;
      if (usesRoutedTcp && dependency === "taomni-plugin-stream" && packageName === dependency
        && resolvedPath === path.join(root, "src-tauri/crates/taomni-plugin-stream")) {
        continue;
      }
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
      let source = fs.readFileSync(filename, "utf8").replace(/\/\/[^\n]*/g, "");
      if (usesRoutedTcp) source = source.replace(/\btaomni_plugin_stream::routed_tcp::/g, "");
      if (/\b(?:tauri(?:_[\w]+)?|wry|taomni_lib|taomni_plugin_[\w]+)::|\bcrate::(?:state|servers|rdp|config|vault)::/.test(source)) {
        errors.push(`${path.relative(root, filename)}: shared library must not import application/plugin state`);
      }
    }
  }
  return errors;
}

function coreStateViolations(root) {
  const errors = [];
  const stateRoot = path.join(root, "src-tauri/src/state");
  if (!fs.existsSync(path.join(stateRoot, "core.rs"))) return errors;
  for (const name of ["core.rs", "domains.rs"]) {
    const source = fs.readFileSync(path.join(stateRoot, name), "utf8").replace(/\/\/[^\n]*/g, "");
    if (/\bcrate\s*::\s*(?:mfa|mail|servers|sockscap|vnc|rdp|mobile|asr)\s*::|\b(?:MfaStore|MailRuntime|MailImapPool|MailDbHandle|ServerRegistry|SocksCapRuntime|VncSession|RdpSession|MobileRuntime|AsrManager|AppAiCtx)\b/.test(source)) {
      errors.push(`src-tauri/src/state/${name}: core state cannot own optional feature implementation types`);
    }
  }
  const composition = fs.readFileSync(path.join(root, "src-tauri/src/state.rs"), "utf8").replace(/\/\/[^\n]*/g, "");
  if (/\bimpl[^\{]*\bDeref(?:Mut)?\b/.test(composition)) {
    errors.push("src-tauri/src/state.rs: explicit core/legacy composition must not use Deref forwarding");
  }
  const terminalOutput = path.join(root, "src-tauri/src/terminal/output.rs");
  if (fs.existsSync(terminalOutput) && /\bcrate::mobile::/.test(fs.readFileSync(terminalOutput, "utf8"))) {
    errors.push("src-tauri/src/terminal/output.rs: output hub must not own the mobile broker");
  }
  return errors;
}

function mfaEngineViolations(root, treeFile) {
  const errors = [];
  const directory = path.join(root, "src-tauri/crates/taomni-mfa-engine");
  if (!fs.existsSync(directory)) return errors;
  const manifest = fs.readFileSync(path.join(directory, "Cargo.toml"), "utf8");
  const forbidden = /^(?:tauri(?:-|$)|wry$|taomni$|taomni-plugin-|xcap$|reqwest$)/;
  for (const match of manifest.matchAll(/\bpackage\s*=\s*"([^"]+)"/g)) {
    if (forbidden.test(match[1])) errors.push(`taomni-mfa-engine/Cargo.toml: aliased dependency links ${match[1]}`);
  }
  for (const { section, name, value } of cargoDependencies(manifest)) {
    const packageName = value.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1] ?? name;
    const dependencyPath = value.match(/\bpath\s*=\s*"([^"]+)"/)?.[1];
    const resolved = dependencyPath ? path.resolve(directory, dependencyPath) : undefined;
    if (forbidden.test(packageName)
      || resolved === path.join(root, "src-tauri")
      || resolved?.startsWith(path.join(root, "src-tauri/plugins") + path.sep)) {
      errors.push(`taomni-mfa-engine/Cargo.toml: ${section}.${name} links runtime, capture or network ownership`);
    }
  }
  for (const filename of rustFiles(path.join(directory, "src"))) {
    const source = fs.readFileSync(filename, "utf8").replace(/\/\/[^\n]*/g, "");
    if (/\b(?:tauri(?:_[\w]+)?|wry|taomni_lib|taomni_plugin_[\w]+|reqwest|xcap)::|\bcrate::(?:state|vault|backup|capture)::/.test(source)) {
      errors.push(`${path.relative(root, filename)}: MFA engine must not import application services`);
    }
  }
  if (treeFile) {
    const tree = fs.readFileSync(treeFile, "utf8");
    if (!/^taomni-mfa-engine v/m.test(tree)) errors.push("MFA cargo tree does not identify taomni-mfa-engine as its root");
    for (const line of tree.split(/\r?\n/)) {
      const packageName = line.trim().split(/\s+/)[0];
      if (forbidden.test(packageName)) errors.push(`MFA engine dependency tree contains ${packageName}`);
    }
  }
  return errors;
}

function hostViolations(root, slug, title, treeFile) {
  const errors = [];
  const plugins = path.join(root, "src-tauri/plugins");
  const directory = path.join(plugins, slug);
  if (!fs.existsSync(directory)) return errors;
  const manifest = fs.readFileSync(path.join(directory, "Cargo.toml"), "utf8");
  const packageId = `taomni-plugin-${slug}`;
  const forbidden = (packageName) => /^(?:tauri(?:-|$)|wry$|taomni$|taomni-hello-plugin$)/.test(packageName)
    || (/^taomni-plugin-/.test(packageName) && !["taomni-plugin-api", "taomni-plugin-sdk", "taomni-plugin-stream"].includes(packageName))
    || (slug === "mfa" && /^(?:reqwest|xcap)$/.test(packageName));
  for (const match of manifest.matchAll(/\bpackage\s*=\s*"([^"]+)"/g)) {
    if (forbidden(match[1])) errors.push(`${title} host alias links core-owned package ${match[1]}`);
  }
  for (const { section, name, value } of cargoDependencies(manifest)) {
    const packageName = value.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1] ?? name;
    const dependencyPath = value.match(/\bpath\s*=\s*"([^"]+)"/)?.[1];
    const resolved = dependencyPath && path.resolve(directory, dependencyPath);
    if (forbidden(packageName) || resolved === path.join(root, "src-tauri") || resolved?.startsWith(plugins + path.sep)) {
      errors.push(`${title} host ${section}.${name} links core-owned services, native runtime or another module`);
    }
  }
  for (const filename of rustFiles(path.join(directory, "src"))) {
    const source = fs.readFileSync(filename, "utf8").replace(/\/\/[^\n]*/g, "");
    if (/\b(?:tauri(?:_[\w]+)?|wry|taomni_lib|taomni_plugin_services)::|\bcrate::(?:state|vault|backup|capture)::/.test(source)
        || (slug === "mfa" && /\b(?:reqwest|xcap)::/.test(source))) {
      errors.push(`${path.relative(root, filename)}: ${title} host must access core services only through the SDK`);
    }
  }
  if (treeFile) {
    const tree = fs.readFileSync(treeFile, "utf8");
    if (!tree.startsWith(`${packageId} v`)) errors.push(`${title} host cargo tree does not identify ${packageId} as its root`);
    for (const line of tree.split(/\r?\n/)) {
      const packageName = line.trim().split(/\s+/)[0];
      if (packageName !== packageId && forbidden(packageName)) errors.push(`${title} host dependency tree contains ${packageName}`);
    }
  }
  return errors;
}

/** Return all violations, so one CI run identifies every broken ownership edge. */
export function modularBoundaryViolations(root, { linuxTreeFile, mfaTreeFile, mfaHostTreeFile, mailHostTreeFile } = {}) {
  const errors = [
    ...sharedLibraryViolations(root),
    ...coreStateViolations(root),
    ...mfaEngineViolations(root, mfaTreeFile),
    ...hostViolations(root, "mfa", "MFA", mfaHostTreeFile),
    ...hostViolations(root, "mail", "Mail", mailHostTreeFile),
    ...hostViolations(root, "screenshot", "Screenshot"),
    ...hostViolations(root, "vnc-server", "VNC Server"),
    ...hostViolations(root, "rdp-server", "RDP Server"),
    ...hostViolations(root, "servers", "Local servers"),
  ];
  const consumers = ["screenshot", "mfa", "mobile"];
  for (const consumer of consumers) {
    for (const filename of rustFiles(path.join(root, "src-tauri/src", consumer))) {
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/\b(?:crate::)?servers::/.test(line) || /^\s*\/\//.test(line)) return;
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

  const rdpServer = path.join(root, "src-tauri/crates/taomni-rdp-server-engine");
  if (fs.existsSync(rdpServer)) {
    const cargo = fs.readFileSync(path.join(rdpServer, "Cargo.toml"), "utf8");
    for (const { name, value } of cargoDependencies(cargo)) {
      const packageName = value.match(/\bpackage\s*=\s*"([^"]+)"/)?.[1] ?? name;
      const dependencyPath = value.match(/\bpath\s*=\s*"([^"]+)"/)?.[1];
      const resolved = dependencyPath && path.resolve(rdpServer, dependencyPath);
      if (/^(?:tauri(?:-|$)|wry$|taomni$)/.test(packageName)
        || resolved === path.join(root, "src-tauri")
        || resolved?.startsWith(path.join(root, "src-tauri/plugins") + path.sep)) {
        errors.push(`RDP Server engine dependency ${name} links application or module state`);
      }
    }
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
  console.log(`Modular capture/RDP/Mail/MFA/Screenshot boundaries passed${options.linuxTreeFile ? "; Linux dependency tree checked" : ""}${options.mfaTreeFile ? "; MFA dependency tree checked" : ""}${options.mfaHostTreeFile ? "; MFA host dependency tree checked" : ""}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const treeIndex = process.argv.indexOf("--linux-tree");
  const mfaTreeIndex = process.argv.indexOf("--mfa-tree");
  const hostTreeIndex = process.argv.indexOf("--mfa-host-tree");
  const mailHostTreeIndex = process.argv.indexOf("--mail-host-tree");
  try {
    if (treeIndex >= 0 && !process.argv[treeIndex + 1]) throw new Error("--linux-tree requires a cargo tree output path");
    if (mfaTreeIndex >= 0 && !process.argv[mfaTreeIndex + 1]) throw new Error("--mfa-tree requires a cargo tree output path");
    if (hostTreeIndex >= 0 && !process.argv[hostTreeIndex + 1]) throw new Error("--mfa-host-tree requires a cargo tree output path");
    if (mailHostTreeIndex >= 0 && !process.argv[mailHostTreeIndex + 1]) throw new Error("--mail-host-tree requires a cargo tree output path");
    checkModularBoundaries(repository, {
      linuxTreeFile: treeIndex >= 0 ? process.argv[treeIndex + 1] : undefined,
      mfaTreeFile: mfaTreeIndex >= 0 ? process.argv[mfaTreeIndex + 1] : undefined,
      mfaHostTreeFile: hostTreeIndex >= 0 ? process.argv[hostTreeIndex + 1] : undefined,
      mailHostTreeFile: mailHostTreeIndex >= 0 ? process.argv[mailHostTreeIndex + 1] : undefined,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
