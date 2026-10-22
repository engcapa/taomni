import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient, sha256 } from "./lsp-client.mjs";
import { PROJECTS_DIR } from "./paths.mjs";
import { launchArgs, initializationSettings, clientCapabilities } from "./toolchain.mjs";


export function buildModelFingerprint(fixtureId) {
  const root = join(PROJECTS_DIR, fixtureId);
  const parts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(pom\.xml|build\.gradle|settings\.gradle)$/.test(entry.name)) {
        parts.push(`${full}:${sha256(readFileSync(full, "utf8"))}`);
      }
    }
  };
  walk(root);
  parts.sort();
  return sha256(parts.join("\n"));
}


export async function startSession(jdtls, fixtureId, options = {}) {
  const projectDir = join(PROJECTS_DIR, fixtureId);
  const dataDir = join(tmpdir(), `taomni-r3-${fixtureId}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dataDir, { recursive: true });
  const diagnosticsLog = [];
  const registeredMethods = [];
  const registeredExecuteCommands = [];
  const progressEvents = [];
  const rawDiagnosticsByUri = new Map();
  const client = new LspClient(options.javaPath, launchArgs(jdtls, dataDir), {
    workspaceFolders: [{ uri: `file://${projectDir}`, name: fixtureId }],
    onDiagnostics: (params) => {
      for (const diagnostic of params?.diagnostics ?? []) {
        diagnosticsLog.push({
          severity: diagnostic.severity ?? null,
          source: diagnostic.source ?? null,
          message: String(diagnostic.message ?? ""),
          uriSanitized: String(params.uri ?? "").startsWith("file://")
            ? String(params.uri).slice("file://".length)
            : String(params.uri ?? ""),
        });
      }
    },
    // §8.20.2 W1: jdtls registers several capabilities dynamically instead of
    // declaring them statically in initialize — record the registrations so
    // providerChannels can distinguish "absent" from "registered later".
    onRegisterCapability: (params) => {
      for (const registration of params?.registrations ?? []) {
        if (!registration?.method) continue;
        registeredMethods.push(registration.method);
        if (registration.method === "workspace/executeCommand") {
          for (const command of registration.registerOptions?.commands ?? []) {
            if (typeof command === "string") registeredExecuteCommands.push(command);
          }
        }
      }
    },
    // §8.20.3 W2: work-done progress is the provider's import/analysis lifecycle.
    onRawDiagnostics: (params) => {
      if (!params?.uri) return;
      rawDiagnosticsByUri.set(String(params.uri), Array.isArray(params.diagnostics) ? params.diagnostics : []);
    },
    onWorkDoneProgress: (params) => {
      if (!params?.token) return;
      progressEvents.push({
        token: String(params.token),
        kind: params.value?.kind ?? null,
        title: params.value?.title ?? null,
        message: params.value?.message ?? null,
        percentage: typeof params.value?.percentage === "number" ? params.value.percentage : null,
      });
    },
  }).start();
  const startedAt = Date.now();
  const initializeResult = await client.request("initialize", {
    processId: null,
    rootUri: `file://${projectDir}`,
    workspaceFolders: [{ uri: `file://${projectDir}`, name: fixtureId }],
    initializationOptions: initializationSettings(options.gradleHome ?? null),
    capabilities: clientCapabilities(),
  }, 180_000);
  client.notify("initialized", {});
  return {
    client,
    diagnosticsLog,
    registeredMethods,
    registeredExecuteCommands,
    progressEvents,
    rawDiagnosticsByUri,
    serverInfo: initializeResult?.serverInfo ?? null,
    serverCapabilities: initializeResult?.capabilities ?? {},
    startedAt,
    msToInitialize: Date.now() - startedAt,
    projectDir,
    dataDir,
  };
}


export function openFile(client, projectDir, relPath) {
  const abs = join(projectDir, relPath);
  const text = readFileSync(abs, "utf8");
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri: `file://${abs}`,
      languageId: "java",
      version: 1,
      text,
    },
  });
  return text;
}
