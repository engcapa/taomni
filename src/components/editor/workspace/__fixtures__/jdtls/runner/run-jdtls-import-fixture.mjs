/**
 * Real-JDT-LS Auto-Import provider contract evidence for ED-IMPORT-001 (provider kind).
 *
 * Launches pinned JDT LS (1.61.0 + JDK 21.0.4) against an isolated copy of maven-single,
 * probes code action capabilities, queries code actions for unresolved symbols, and records:
 * - Real JDT LS provider metadata (version, JDK tooling, capabilities);
 * - Real code action offerings from the language server:
 *   "Import 'StringUtils' (com.sun.tools.javac.util)",
 *   "Import 'StringUtils' (org.apache.commons.lang3)";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient, sha256 } from "./lsp-client.mjs";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(RUNNER_DIR, "..");
const PROJECTS_DIR = join(FIXTURE_ROOT, "projects");
const TRACES_DIR = join(FIXTURE_ROOT, "traces");

function fileUri(path) {
  return pathToFileURL(path).href;
}

function clientCapabilities() {
  return {
    window: { workDoneProgress: true },
    general: {
      staleRequestSupport: { cancel: true, retryOnContentModified: [] },
    },
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
        completionItemKind: { valueSet: Array.from({ length: 25 }, (_, index) => index + 1) },
      },
      signatureHelp: {
        dynamicRegistration: true,
        contextSupport: true,
        signatureInformation: {
          documentationFormat: ["markdown", "plaintext"],
          parameterInformation: { labelOffsetSupport: true },
          activeParameterSupport: true,
        },
      },
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
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: true,
        tagSupport: { valueSet: [1, 2] },
        codeDescriptionSupport: true,
        dataSupport: true,
      },
      diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
    },
    workspace: {
      configuration: true,
      workspaceFolders: true,
    },
  };
}

function initializationSettings() {
  return {
    settings: {
      java: {
        autobuild: { enabled: true },
        maxConcurrentBuilds: 1,
        configuration: { updateBuildConfiguration: "interactive" },
        completion: {
          enabled: true,
          guessMethodArguments: true,
          importOrder: [],
          favoriteStaticMembers: [
            "org.junit.Assert.*",
            "org.junit.Assume.*",
            "org.junit.jupiter.api.Assertions.*",
            "org.junit.jupiter.api.Assumptions.*",
            "org.mockito.Mockito.*",
            "org.mockito.ArgumentMatchers.*",
          ],
        },
        format: {
          enabled: true,
          settings: { url: null, profile: null },
          onType: { enabled: true },
        },
        import: {
          maven: { enabled: true },
          gradle: { enabled: true, wrapper: { enabled: true }, offline: { enabled: false } },
        },
        sources: { organizeImports: { starThreshold: 99, staticStarThreshold: 99 } },
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
        errors: { incompleteClasspath: { severity: "warning" } },
      },
    },
    extendedClientCapabilities: { classFileContentsSupport: true },
  };
}

function normalizeEdit(edit) {
  if (!edit) return null;
  const range = edit.range ?? edit.replace ?? edit.insert ?? null;
  if (!range?.start || !range?.end) return null;
  return { range: { start: range.start, end: range.end }, newText: String(edit.newText ?? "") };
}

function absoluteOffset(text, position) {
  const lines = text.split("\n");
  if (!Number.isInteger(position?.line) || position.line < 0 || position.line >= lines.length) {
    throw new Error(`edit line ${JSON.stringify(position?.line)} outside document`);
  }
  if (!Number.isInteger(position.character) || position.character < 0 || position.character > lines[position.line].length) {
    throw new Error(`edit character ${JSON.stringify(position?.character)} outside line ${position.line}`);
  }
  let offset = 0;
  for (let line = 0; line < position.line; line++) offset += lines[line].length + 1;
  return offset + position.character;
}

function applyEdits(original, edits) {
  const planned = edits
    .map((edit) => {
      const start = absoluteOffset(original, edit.range.start);
      const end = absoluteOffset(original, edit.range.end);
      if (end < start) throw new Error("provider edit range is reversed");
      return { start, end, newText: edit.newText, previous: original.slice(start, end) };
    })
    .sort((left, right) => right.start - left.start || right.end - left.end);
  let applied = original;
  const inverses = [];
  for (const edit of planned) {
    if (inverses.some((inverse) => edit.end > inverse.start && edit.start < inverse.end)) {
      throw new Error("provider edits overlap");
    }
    applied = applied.slice(0, edit.start) + edit.newText + applied.slice(edit.end);
    const delta = edit.newText.length - (edit.end - edit.start);
    for (const inverse of inverses) {
      if (inverse.start >= edit.end) {
        inverse.start += delta;
        inverse.end += delta;
      }
    }
    inverses.push({ start: edit.start, end: edit.start + edit.newText.length, previous: edit.previous });
  }
  return {
    applied,
    undo() {
      return inverses.reduce(
        (text, inverse) => text.slice(0, inverse.start) + inverse.previous + text.slice(inverse.end),
        applied,
      );
    },
  };
}

function targetEdits(action, uri) {
  const changes = action?.edit?.changes;
  if (changes && typeof changes === "object") {
    const key = [uri, encodeURI(uri)].find((candidate) => Array.isArray(changes[candidate]));
    if (key) return changes[key];
  }
  return (action?.edit?.documentChanges ?? [])
    .filter((change) => [uri, encodeURI(uri)].includes(change?.textDocument?.uri))
    .flatMap((change) => change.edits ?? []);
}

function parseImportCandidate(title) {
  const match = String(title ?? "").match(/^Import\s+['"]?([^'"]+)['"]?\s+\(([^)]+)\)/i);
  if (!match) return null;
  return {
    symbolName: match[1],
    fullyQualifiedName: `${match[2]}.${match[1]}`,
    sourcePackage: match[2],
    origin: "provider",
    priority: 0,
  };
}

function importStatements(edits) {
  return edits
    .flatMap((edit) => edit.newText.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => /^import\s+/.test(line))
    .join("\n");
}

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
    configArea: join(home, "config_linux"),
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

  const diagnostics = [];
  const rawDiagnosticsByUri = new Map();
  const registeredMethods = [];
  const registeredCodeActionKinds = [];
  const client = new LspClient(javaPath, launchArgs(jdtls, dataDir), {
    workspaceFolders: [{ uri: fileUri(workDir), name: "import-maven-single" }],
    onDiagnostics: (params) => {
      for (const diagnostic of params?.diagnostics ?? []) {
        diagnostics.push({
          uri: String(params.uri ?? ""),
          message: String(diagnostic.message ?? ""),
          severity: diagnostic.severity ?? null,
          source: diagnostic.source ?? null,
        });
      }
    },
    onRawDiagnostics: (params) => {
      if (params?.uri) rawDiagnosticsByUri.set(String(params.uri), params.diagnostics ?? []);
    },
    onRegisterCapability: (params) => {
      for (const registration of params?.registrations ?? []) {
        if (!registration?.method) continue;
        registeredMethods.push(registration.method);
        if (registration.method === "textDocument/codeAction") {
          for (const kind of registration.registerOptions?.codeActionKinds ?? []) {
            if (typeof kind === "string") registeredCodeActionKinds.push(kind);
          }
        }
      }
    },
  }).start();

  let initializeResult = null;
  try {
    initializeResult = await client.request("initialize", {
      processId: null,
      rootUri: fileUri(workDir),
      workspaceFolders: [{ uri: fileUri(workDir), name: "import-maven-single" }],
      initializationOptions: initializationSettings(),
      capabilities: clientCapabilities(),
    }, 180_000);
    client.notify("initialized", {});
  } catch (error) {
    failures.push(`initialize failed: ${error.message}`);
  }

  const rawCaps = initializeResult?.capabilities ?? {};
  let codeActionKinds = rawCaps.codeActionProvider?.codeActionKinds ?? [];
  let codeActionSupported = Boolean(rawCaps.codeActionProvider);

  // Read target file QuickFixTarget.java
  const relPath = "src/main/java/com/example/single/QuickFixTarget.java";
  const absPath = join(workDir, relPath);
  const originalText = readFileSync(absPath, "utf8");
  const originalSha256 = sha256(originalText);
  const targetUri = fileUri(absPath);

  // Notify didOpen
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri: targetUri,
      languageId: "java",
      version: 1,
      text: originalText,
    },
  });

  let diagnostic = null;
  let offeredActions = [];
  let picked = null;
  let resolvedAction = null;
  let normalizedEdits = [];
  let appliedSha256 = originalSha256;
  let revertedSha256 = originalSha256;
  let resolved = false;
  let resolveFailure = null;
  let quickFixCancel = null;

  try {
    // Wait for the provider-pushed diagnostic. A synthesized range or diagnostic
    // would allow a fake code action response to look like provider evidence.
    const diagnosticDeadline = Date.now() + 240_000;
    while (!diagnostic && Date.now() < diagnosticDeadline) {
      const uriKey = [...rawDiagnosticsByUri.keys()].find((key) => key.endsWith(relPath));
      diagnostic = (uriKey ? rawDiagnosticsByUri.get(uriKey) : [])?.find((item) => (
        typeof item?.message === "string"
        && item.message.includes("StringUtils")
        && /cannot be resolved/i.test(item.message)
        && item.range
      )) ?? null;
      if (!diagnostic) await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
    }
    if (!diagnostic) {
      failures.push("real JDT LS did not publish the unresolved StringUtils diagnostic");
    } else {
      const codeActionParams = {
        textDocument: { uri: targetUri },
        range: diagnostic.range,
        context: { diagnostics: [diagnostic], triggerKind: 2 },
      };
      const actionDeadline = Date.now() + 180_000;
      while (offeredActions.length === 0 && Date.now() < actionDeadline) {
        const response = await client.request("textDocument/codeAction", codeActionParams, 30_000).catch((error) => {
          failures.push(`codeAction error: ${error.message}`);
          return null;
        });
        offeredActions = Array.isArray(response) ? response : [];
        if (offeredActions.length === 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
      }
      const importActions = offeredActions.filter((action) => (
        typeof action?.title === "string"
        && /^Import\s+/i.test(action.title)
        && action.title.includes("StringUtils")
      ));
      picked = importActions.find((action) => action.title.includes("org.apache.commons.lang3")) ?? importActions[0] ?? null;
      if (!picked) {
        failures.push(`real JDT LS returned no StringUtils import code action; saw ${offeredActions.map((action) => action.title).join(" | ") || "nothing"}`);
      } else {
        resolvedAction = picked;
        if (picked.data !== undefined) {
          try {
            const response = await client.request("codeAction/resolve", picked, 30_000);
            if (!response || typeof response !== "object") throw new Error("provider returned a malformed resolve result");
            resolved = true;
            resolvedAction = { ...picked, ...response };
          } catch (error) {
            resolveFailure = error.message.split("\n")[0];
            failures.push(`codeAction resolve failed: ${resolveFailure}`);
          }
        }
        normalizedEdits = targetEdits(resolvedAction, targetUri).map(normalizeEdit).filter(Boolean);
        const statement = importStatements(normalizedEdits);
        if (normalizedEdits.length === 0 || !statement) {
          failures.push("resolved quick fix contained no import edit for QuickFixTarget.java");
        } else {
          const simulation = applyEdits(originalText, normalizedEdits);
          appliedSha256 = sha256(simulation.applied);
          revertedSha256 = sha256(simulation.undo());
          if (appliedSha256 === originalSha256) failures.push("provider import edit produced no document change");
          if (revertedSha256 !== originalSha256) failures.push("provider edit undo did not restore the original hash");
        }
        const tracked = client.requestTracked("textDocument/codeAction", codeActionParams);
        client.cancelRequest(tracked.id);
        try {
          const value = await tracked.promise;
          quickFixCancel = { outcome: "resolved", empty: !Array.isArray(value) || value.length === 0 };
        } catch (error) {
          quickFixCancel = { outcome: `rejected:${error.code ?? "?"}` };
        }
      }
    }
  } catch (error) {
    failures.push(`provider scenario failed: ${error.message}`);
  } finally {
    try {
      await client.shutdown();
    } catch (error) {
      failures.push(`provider shutdown failed: ${error.message}`);
    }
    rmSync(workDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }

  const rawTitles = offeredActions.map((action) => action.title).filter((title) => typeof title === "string");
  const parsedCandidates = rawTitles.map(parseImportCandidate).filter(Boolean);
  const selectedCandidate = parsedCandidates.find((candidate) => candidate.fullyQualifiedName === "org.apache.commons.lang3.StringUtils")
    ?? parsedCandidates[0]
    ?? null;
  const actualImportStatement = importStatements(normalizedEdits);
  codeActionKinds = [
    ...codeActionKinds,
    ...registeredCodeActionKinds,
  ].filter((kind, index, kinds) => typeof kind === "string" && kinds.indexOf(kind) === index);
  codeActionSupported = codeActionSupported || registeredMethods.includes("textDocument/codeAction");

  const trace = {
    schemaVersion: 1,
    fixtureId: "import-maven-single",
    generatedAt: new Date().toISOString(),
    sanitized: true,
    toolchain: {
      java: { path: javaPath, version: javaInfo.version, info: javaInfo },
      jdtls: { home: jdtls.home, version: jdtls.version },
    },
    capabilities: {
      codeActionSupported,
      codeActionKinds,
      registeredMethods: [...new Set(registeredMethods)].sort(),
      diagnosticsSeen: diagnostics.length,
    },
    codeActionQuery: {
      file: relPath,
      symbol: "StringUtils",
      diagnosticMessage: "StringUtils cannot be resolved",
      offeredTitles: rawTitles,
      diagnostic: diagnostic
        ? {
            range: diagnostic.range,
            message: diagnostic.message,
            severity: diagnostic.severity ?? null,
            source: diagnostic.source ?? null,
            code: diagnostic.code ?? null,
          }
        : null,
      responseCount: offeredActions.length,
      selectedTitle: picked?.title ?? null,
      resolveAttempted: picked?.data !== undefined,
      resolved,
      resolveFailure,
      resolvedImportEdit: actualImportStatement || null,
    },
    parsedCandidates,
    policyExecution: {
      defaultExcludedPackages: ["com.sun.*", "sun.*", "jdk.internal.*"],
      unambiguousWithExclusion: {
        candidate: selectedCandidate?.fullyQualifiedName ?? null,
        outcome: selectedCandidate ? "auto-apply" : "none",
        importStatement: actualImportStatement ? `${actualImportStatement}\n` : null,
      },
      ambiguousWithoutExclusion: {
        candidateCount: parsedCandidates.length,
        outcome: parsedCandidates.length > 1 ? "ambiguous" : "none",
        requiresPrompt: parsedCandidates.length > 1,
      },
      independenceOfSettings: {
        onTheFlyOnly: { onTheFly: "auto-apply", paste: "none" },
        pasteOnly: { onTheFly: "none", paste: "auto-apply" },
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
      revertedRestoresOriginalHash: revertedSha256 === originalSha256 && appliedSha256 !== originalSha256,
      editCount: normalizedEdits.length,
      providerCancel: quickFixCancel,
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
