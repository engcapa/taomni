import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./lsp-client.mjs";


// ---------------------------------------------------------------------------
// §8.20.3 W2: Project Analysis snapshot collection (provider-owned facts)
// ---------------------------------------------------------------------------

export const BUILD_DESCRIPTOR_FILES = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
]);


export function collectBuildFileHashes(projectDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["target", "build", ".git", "node_modules"].includes(entry.name)) {
          walk(full, depth + 1);
        }
        continue;
      }
      if (!BUILD_DESCRIPTOR_FILES.has(entry.name)) continue;
      found.push({ path: full, sha256: sha256(readFileSync(full, "utf8")) });
    }
  };
  walk(projectDir, 0);
  found.sort((left, right) => left.path.localeCompare(right.path));
  return found;
}


export async function executeCommandProbe(client, command, args) {
  return client.request("workspace/executeCommand", { command, arguments: args });
}


/**
 * Provider-owned analysis snapshot for one settled session: server identity,
 * registered executeCommands (gating truth), java project list + classpath
 * probe when available, build-file hashes and the import progress trail.
 */
export async function collectAnalysisSnapshot(session, mainUri) {
  const registered = [...new Set(session.registeredExecuteCommands)].sort();
  const snapshot = {
    serverInfo: session.serverInfo
      ? {
        name: session.serverInfo.name ?? null,
        version: session.serverInfo.version ?? null,
      }
      : null,
    registeredCommands: registered,
    javaProjects: [],
    classpathProbe: null,
    probeReason: null,
    buildFiles: collectBuildFileHashes(session.projectDir).map((file) => ({
      ...file,
      path: file.path.replaceAll(session.projectDir, "${project}"),
    })),
    importProgress: {
      events: session.progressEvents.length,
      beginTokens: new Set(
        session.progressEvents.filter((event) => event.kind === "begin").map((event) => event.token),
      ).size,
      titles: [...new Set(session.progressEvents.map((event) => event.title).filter(Boolean))].slice(0, 8),
      anyWithPercentage: session.progressEvents.some((event) => event.percentage !== null),
    },
  };

  if (registered.includes("java.project.list")) {
    try {
      const value = await executeCommandProbe(session.client, "java.project.list", []);
      snapshot.javaProjects = (Array.isArray(value) ? value : value?.projects ?? [])
        .map((item) => ({
          id: typeof item === "string" ? item : item?.uri ?? item?.rootUri ?? "",
          rootUri: typeof item === "string" ? item : item?.uri ?? item?.rootUri ?? null,
        }))
        .filter((item) => item.id);
    } catch (error) {
      snapshot.probeReason = `java.project.list-failed:${error.message.split("\n")[0]}`;
    }
  } else {
    snapshot.probeReason = "command-not-registered:java.project.list";
  }

  if (registered.includes("java.project.getClasspaths")) {
    try {
      const value = await executeCommandProbe(session.client, "java.project.getClasspaths", [mainUri]);
      const entries = Array.isArray(value)
        ? value.filter((entry) => typeof entry === "string")
        : Array.isArray(value?.classpaths)
          ? value.classpaths.filter((entry) => typeof entry === "string")
          : null;
      if (entries) {
        const sorted = [...entries].sort();
        snapshot.classpathProbe = {
          root: typeof value?.root === "string"
            ? value.root.replace(/^file:\/\//, "").replaceAll(session.projectDir, "${project}")
            : null,
          entryCount: sorted.length,
          entriesSha256: sha256(sorted.join("\n")),
          sampleKinds: sorted.slice(0, 4).map((entry) => (entry.includes(".jar") ? "jar" : "dir")),
        };
      } else {
        snapshot.probeReason = "java.project.getClasspaths-unrecognized-shape";
      }
    } catch (error) {
      snapshot.probeReason = `java.project.getClasspaths-failed:${error.message.split("\n")[0]}`;
    }
  } else if (!snapshot.probeReason) {
    snapshot.probeReason = "command-not-registered:java.project.getClasspaths";
  }
  return snapshot;
}
