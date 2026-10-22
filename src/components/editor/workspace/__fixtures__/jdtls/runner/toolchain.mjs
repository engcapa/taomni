import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";


// ---------------------------------------------------------------------------
// Toolchain resolution (pinned versions recorded into every trace)
// ---------------------------------------------------------------------------

export function resolveJava() {
  const candidate = process.env.TAOMNI_FIXTURE_JAVA
    ?? "/data/dev/jdk-21/bin/java";
  if (!existsSync(candidate)) throw new Error(`java not found at ${candidate}; set TAOMNI_FIXTURE_JAVA`);
  return candidate;
}


export function javaVersion(javaPath) {
  const out = spawnSync(javaPath, ["-version"], { encoding: "utf8" });
  const line = (out.stderr || "").split("\n")[0] ?? "";
  const version = line.match(/version "([^"]+)"/)?.[1] ?? "unknown";
  return { line: line.trim(), major: Number.parseInt(version.split(".")[0] ?? "0", 10), version };
}


export function resolveJdtlsHome() {
  const home = process.env.JDTLS_HOME ?? join(homedir(), ".local/share/jdtls");
  const pluginsDir = join(home, "plugins");
  if (!existsSync(pluginsDir)) throw new Error(`jdtls plugins/ missing under ${home}; set JDTLS_HOME`);
  let launcherJar = join(pluginsDir, "org.eclipse.equinox.launcher.jar");
  if (!existsSync(launcherJar)) {
    const found = readdirSync(pluginsDir).find((name) =>
      name.startsWith("org.eclipse.equinox.launcher_") && name.endsWith(".jar"));
    if (!found) throw new Error("equinox launcher jar not found");
    launcherJar = join(pluginsDir, found);
  }
  const core = readdirSync(pluginsDir).find((name) => name.startsWith("org.eclipse.jdt.ls.core_"));
  return {
    home,
    launcherJar,
    // The Equinox config contains platform-specific native launcher
    // fragments. Keep the provider fixture runnable on the same OS as the
    // packaged native app instead of silently using the Linux config on macOS.
    configArea: join(
      home,
      process.platform === "darwin" ? "config_mac" : process.platform === "win32" ? "config_win" : "config_linux",
    ),
    version: core?.replace("org.eclipse.jdt.ls.core_", "") ?? "unknown",
  };
}


export function resolveGradleDist() {
  const override = process.env.TAOMNI_FIXTURE_GRADLE;
  if (override && existsSync(join(override, "bin/gradle"))) {
    let version = "configured";
    try {
      const output = execFileSync(join(override, "bin/gradle"), ["--version"], { encoding: "utf8" });
      version = output.match(/Gradle\s+([0-9][^\s]*)/)?.[1] ?? version;
    } catch {
      // The configured home is still useful to jdtls even when its version
      // probe is unavailable; keep the trace explicit rather than failing
      // before the provider starts.
    }
    return { version, home: override };
  }
  const dists = join(homedir(), ".gradle/wrapper/dists");
  if (!existsSync(dists)) return null;
  const candidates = [];
  for (const entry of readdirSync(dists)) {
    const match = entry.match(/^gradle-(\d+\.\d+(?:\.\d+)?)-bin$/);
    if (!match) continue;
    // Wrapper dists unpack to <entry>/<hash>/gradle-<version>/{bin,lib,…}.
    for (const hash of readdirSync(join(dists, entry))) {
      const home = join(dists, entry, hash, `gradle-${match[1]}`);
      if (existsSync(join(home, "bin/gradle"))) {
        candidates.push({ version: match[1], home });
        break;
      }
    }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return candidates[0] ?? null;
}


/** Mirrors the non-Windows production jdtls launch recipe. */
export function launchArgs(jdtls, dataDir) {
  return [
    "-Declipse.application=org.eclipse.jdt.ls.core.id1",
    "-Dosgi.bundles.defaultStartLevel=4",
    "-Declipse.product=org.eclipse.jdt.ls.core.product",
    "-Dosgi.checkConfiguration=true",
    `-Dosgi.sharedConfiguration.area=${jdtls.configArea}`,
    "-Dosgi.sharedConfiguration.area.readOnly=true",
    "-Dosgi.configuration.cascaded=true",
    "-Dlog.level=ERROR",
    "--add-modules=ALL-SYSTEM",
    "--add-opens", "java.base/java.util=ALL-UNNAMED",
    "--add-opens", "java.base/java.lang=ALL-UNNAMED",
    "-jar", jdtls.launcherJar,
    "-data", dataDir,
  ];
}


/** Completion-relevant client capabilities, copied from lsp.rs initialize. */
export function clientCapabilities() {
  return {
    window: { workDoneProgress: true },
    textDocument: {
      synchronization: { dynamicRegistration: true, didSave: true },
      completion: {
        dynamicRegistration: true,
        contextSupport: true,
        completionItem: {
          snippetSupport: true,
          insertReplaceSupport: true,
          documentationFormat: ["markdown", "plaintext"],
          resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
        },
        completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
      },
      // §8.20.2 W1: mirrors the production signatureHelp block verbatim —
      // without it jdtls (correctly) answers textDocument/signatureHelp
      // with no signatures.
      signatureHelp: {
        dynamicRegistration: true,
        contextSupport: true,
        signatureInformation: {
          documentationFormat: ["markdown", "plaintext"],
          parameterInformation: { labelOffsetSupport: true },
          activeParameterSupport: true,
        },
      },
      // §8.20.4 W3: mirrors the production codeAction block verbatim —
      // without codeActionLiteralSupport jdtls answers textDocument/codeAction
      // with an empty list (LSP clients that cannot render literals).
      codeAction: {
        dynamicRegistration: true,
        isPreferredSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ["edit", "command"] },
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              "",
              "quickfix",
              "refactor",
              "refactor.extract",
              "refactor.inline",
              "refactor.rewrite",
              "source",
              "source.organizeImports",
              "source.fixAll",
            ],
          },
        },
      },
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
    },
    workspace: {
      configuration: true,
      workspaceFolders: true,
      didChangeConfiguration: { dynamicRegistration: true },
    },
  };
}


/** Mirrors the production `java.*` initialization settings (lsp.rs
 * JavaLanguageSettings defaults). Notably `signatureHelp.enabled: true` —
 * jdt.ls gates textDocument/signatureHelp behind this flag (default off),
 * so omitting it silently yields empty signatures. */
export function initializationSettings(gradleHome) {
  return {
    settings: {
      java: {
        completion: { enabled: true },
        errors: { incompleteClasspath: { severity: "warning" } },
        import: {
          maven: { enabled: true },
          gradle: {
            enabled: true,
            wrapper: { enabled: true },
            offline: { enabled: false },
            ...(gradleHome ? { home: gradleHome } : {}),
          },
        },
        sources: {
          organizeImports: { starThreshold: 99, staticStarThreshold: 99 },
        },
        saveActions: { organizeImports: false },
        codeGeneration: {
          hashCodeEquals: { useJava7Objects: true },
          useBlocks: true,
          generateComments: false,
          toString: { template: "${object.className} [${member.name()}=${member.value}, ${otherMembers}]" },
        },
        referencesCodeLens: { enabled: false },
        implementationsCodeLens: { enabled: false },
        signatureHelp: { enabled: true },
        inlayHints: { parameterNames: { enabled: "all" } },
      },
    },
  };
}
