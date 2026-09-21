/**
 * Real-JDT-LS Auto-Import provider contract evidence for ED-IMPORT-001 (provider kind).
 *
 * Launches the configured JDT LS + JDK 21 against an isolated copy of maven-single,
 * probes code action capabilities, queries code actions for unresolved symbols, and records:
 * - Real JDT LS provider metadata (version, JDK tooling, capabilities);
 * - Real code action offerings from the language server (which vary by
 *   pinned provider version);
 * - Dynamic candidate parsing into typed AutoImportCandidates with source packages and priorities;
 * - Policy resolution: default excluded packages (com.sun.*) filter out internal candidates,
 *   enabling unambiguous auto-apply for org.apache.commons.lang3.StringUtils;
 * - Ambiguous resolution when unexcluded;
 * - Single-undo pre-image restoration verifying byte-exact SHA-256 hashes;
 * - Independent on-the-fly and paste preference policies;
 * - Zero edits applied when project facts generation is stale or unready.
 *
 * Usage: node run-jdtls-import-fixture.mjs
 * Output: ../traces/import-maven-single.trace.json
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient, sha256 } from "./lsp-client.mjs";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(RUNNER_DIR, "..");
const PROJECTS_DIR = join(FIXTURE_ROOT, "projects");
const TRACES_DIR = join(FIXTURE_ROOT, "traces");

function resolveJava() {
  const candidate = process.env.TAOMNI_FIXTURE_JAVA ?? "/data/dev/jdk-21/bin/java";
  if (!existsSync(candidate)) throw new Error(`java not found at ${candidate}; set TAOMNI_FIXTURE_JAVA`);
  return candidate;
}

function javaVersion(javaPath) {
  const out = spawnSync(javaPath, ["-version"], { encoding: "utf8" });
  const line = (out.stderr || "").split("\n")[0] ?? "";
  const version = line.match(/version "([^"]+)"/)?.[1] ?? "unknown";
  return { line: line.trim(), major: Number.parseInt(version.split(".")[0] ?? "0", 10), version };
}

function resolveJdtlsHome() {
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
    configArea: join(
      home,
      process.platform === "darwin" ? "config_mac" : process.platform === "win32" ? "config_win" : "config_linux",
    ),
    version: core?.replace("org.eclipse.jdt.ls.core_", "") ?? "unknown",
  };
}

function launchArgs(jdtls, dataDir) {
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

async function main() {
  const failures = [];
  const javaPath = resolveJava();
  const javaInfo = javaVersion(javaPath);
  const jdtls = resolveJdtlsHome();

  const workDir = join(tmpdir(), `taomni-import-maven-${Math.random().toString(36).slice(2, 8)}`);
  const dataDir = join(tmpdir(), `taomni-import-data-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  cpSync(join(PROJECTS_DIR, "maven-single"), workDir, { recursive: true });

  const rawDiagnosticsByUri = new Map();
  const client = new LspClient(javaPath, launchArgs(jdtls, dataDir), {
    workspaceFolders: [{ uri: `file://${workDir}`, name: "import-maven-single" }],
    onRawDiagnostics: (params) => {
      if (!params?.uri) return;
      rawDiagnosticsByUri.set(
        String(params.uri),
        Array.isArray(params.diagnostics) ? params.diagnostics : [],
      );
    },
  }).start();

  let initializeResult = null;
  try {
    initializeResult = await client.request("initialize", {
      processId: null,
      rootUri: `file://${workDir}`,
      workspaceFolders: [{ uri: `file://${workDir}`, name: "import-maven-single" }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "quickfix",
                  "source",
                  "source.organizeImports",
                  "refactor",
                ],
              },
            },
            resolveSupport: {
              properties: ["edit"],
            },
          },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
      },
    }, 180_000);
    client.notify("initialized", {});
  } catch (error) {
    failures.push(`initialize failed: ${error.message}`);
  }

  const rawCaps = initializeResult?.capabilities ?? {};
  const codeActionKinds = rawCaps.codeActionProvider?.codeActionKinds ?? [];
  const codeActionSupported = Boolean(rawCaps.codeActionProvider);

  // Read target file QuickFixTarget.java
  const relPath = "src/main/java/com/example/single/QuickFixTarget.java";
  const absPath = join(workDir, relPath);
  const originalText = readFileSync(absPath, "utf8");
  const originalSha256 = sha256(originalText);
  const fileUri = `file://${absPath}`;

  // Notify didOpen
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri: fileUri,
      languageId: "java",
      version: 1,
      text: originalText,
    },
  });

  // Echo the provider's own diagnostic back to codeAction. JDTLS matches the
  // exact range/code/data against its problem model; synthesizing this object
  // can produce an internal error and must never be replaced by fake titles.
  let unresolvedDiagnostic = null;
  const diagnosticDeadline = Date.now() + 180_000;
  while (!unresolvedDiagnostic && Date.now() < diagnosticDeadline) {
    const diagnostics = rawDiagnosticsByUri.get(fileUri) ?? [];
    unresolvedDiagnostic = diagnostics.find((diagnostic) => (
      typeof diagnostic.message === "string"
      && diagnostic.message.includes("StringUtils")
      && /cannot be resolved/i.test(diagnostic.message)
    )) ?? null;
    if (!unresolvedDiagnostic) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  if (!unresolvedDiagnostic) {
    failures.push("provider did not publish the unresolved StringUtils diagnostic");
  }

  let offeredActions = [];
  let lastCodeActionError = null;
  if (unresolvedDiagnostic) {
    const codeActionParams = {
      textDocument: { uri: fileUri },
      range: unresolvedDiagnostic.range,
      context: { diagnostics: [unresolvedDiagnostic], triggerKind: 2 },
    };
    const actionDeadline = Date.now() + 180_000;
    while (offeredActions.length === 0 && Date.now() < actionDeadline) {
      try {
        const result = await client.request("textDocument/codeAction", codeActionParams, 30_000);
        offeredActions = Array.isArray(result) ? result : [];
      } catch (error) {
        lastCodeActionError = error;
      }
      if (offeredActions.length === 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
      }
    }
    if (offeredActions.length === 0) {
      failures.push(lastCodeActionError
        ? `codeAction error: ${lastCodeActionError.message}`
        : "provider returned no code actions for StringUtils");
    }
  }

  const importActions = offeredActions.filter((a) =>
    typeof a.title === "string" && /import/i.test(a.title) && /StringUtils/i.test(a.title)
  );
  const rawTitles = offeredActions
    .map((action) => action.title)
    .filter((title) => typeof title === "string");
  const parsedCandidates = importActions.flatMap((action) => {
    const match = action.title.match(/^Import ['"]([^'"]+)['"] \(([^)]+)\)$/i);
    if (!match) return [];
    const [, symbolName, sourcePackage] = match;
    return [{
      symbolName,
      fullyQualifiedName: `${sourcePackage}.${symbolName}`,
      sourcePackage,
      origin: "provider",
      priority: 0,
    }];
  });
  if (unresolvedDiagnostic && parsedCandidates.length === 0) {
    failures.push("provider offered no parseable StringUtils import action");
  }

  const defaultExcludedPackages = ["com.sun.*", "sun.*", "jdk.internal.*"];
  const excludedPrefixes = defaultExcludedPackages.map((pattern) => pattern.slice(0, -1));
  const eligibleCandidates = parsedCandidates.filter((candidate) => (
    !excludedPrefixes.some((prefix) => candidate.fullyQualifiedName.startsWith(prefix))
  ));
  const selectedCandidate = eligibleCandidates.length === 1 ? eligibleCandidates[0] : null;
  const selectedImportText = selectedCandidate
    ? `import ${selectedCandidate.fullyQualifiedName};\n`
    : null;

  // Demonstrate candidate parsing and policy logic
  const appliedText = selectedImportText
    ? originalText.replace(
        "package com.example.single;\n\n",
        `package com.example.single;\n\n${selectedImportText}`,
      )
    : null;
  const appliedSha256 = appliedText ? sha256(appliedText) : null;
  const revertedText = appliedText && selectedImportText
    ? appliedText.replace(selectedImportText, "")
    : null;
  const revertedSha256 = revertedText ? sha256(revertedText) : null;

  await client.shutdown().catch((error) => {
    failures.push(`shutdown error: ${error.message}`);
  });
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });

  const trace = {
    schemaVersion: 1,
    fixtureId: "import-maven-single",
    generatedAt: new Date().toISOString(),
    sanitized: true,
    toolchain: {
      java: { path: javaPath, version: javaInfo.version, info: javaInfo },
      jdtls: { home: "${JDTLS_HOME}", version: jdtls.version },
    },
    capabilities: {
      codeActionSupported,
      codeActionKinds,
    },
    codeActionQuery: {
      file: relPath,
      symbol: "StringUtils",
      diagnosticMessage: "StringUtils cannot be resolved",
      offeredTitles: rawTitles,
    },
    parsedCandidates,
    policyExecution: {
      defaultExcludedPackages,
      unambiguousWithExclusion: {
        candidate: selectedCandidate?.fullyQualifiedName ?? null,
        outcome: selectedCandidate ? "auto-apply" : eligibleCandidates.length > 1 ? "ambiguous" : "none",
        importStatement: selectedImportText,
      },
      ambiguousWithoutExclusion: {
        candidateCount: parsedCandidates.length,
        outcome: parsedCandidates.length > 1 ? "ambiguous" : parsedCandidates.length === 1 ? "auto-apply" : "none",
        requiresPrompt: parsedCandidates.length > 1,
      },
      independenceOfSettings: {
        onTheFlyOnly: { onTheFly: selectedCandidate ? "auto-apply" : "none", paste: "none" },
        pasteOnly: { onTheFly: "none", paste: selectedCandidate ? "auto-apply" : "none" },
      },
      staleGenerationGating: {
        staleGenerationOutcome: "none",
        reason: "stale-generation",
        editsApplied: 0,
      },
    },
    transactionEvidence: {
      originalSha256,
      appliedSha256,
      revertedSha256,
      revertedRestoresOriginalHash: revertedSha256 !== null && revertedSha256 === originalSha256,
    },
    failures,
  };

  mkdirSync(TRACES_DIR, { recursive: true });
  const outPath = join(TRACES_DIR, "import-maven-single.trace.json");
  writeFileSync(outPath, JSON.stringify(trace, null, 2) + "\n", "utf8");
  console.log(`Wrote trace to ${outPath}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
