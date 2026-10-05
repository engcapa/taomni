import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceListFilesRecursive,
  workspaceReadFile,
} from "../lib/editor/workspace";
import {
  discoverProjectDescriptors,
  type BuildDescriptorInput,
  type ProjectDescriptorDiscoveryV1,
} from "../components/editor/workspace/projectStructureModel";

const DESCRIPTOR_NAMES = new Set([
  "Cargo.toml",
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);
const DISCOVERY_MAX_DEPTH = 16;
const DISCOVERY_MAX_FILES = 2000;
const DESCRIPTOR_MAX_BYTES = 256 * 1024;

export type ProjectDescriptorDiscoveryStatus =
  | "idle"
  | "loading"
  | "descriptor-only"
  | "unresolved"
  | "failed";

export interface ProjectDescriptorDiscoveryState {
  status: ProjectDescriptorDiscoveryStatus;
  discovery: ProjectDescriptorDiscoveryV1 | null;
  reason: string | null;
  refresh: () => Promise<void>;
}

function absoluteWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const relative = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return root === "/" ? `/${relative}` : `${root}/${relative}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Discovers build descriptors through the workspace filesystem boundary.
 * Descriptor data is kept as discovery-only state; it never becomes a ready
 * semantic snapshot without a separate trusted tooling/provider result.
 */
export function useProjectDescriptorDiscovery(
  workspaceRoot: string,
  options: { autoRefresh?: boolean } = {},
): ProjectDescriptorDiscoveryState {
  const [status, setStatus] = useState<ProjectDescriptorDiscoveryStatus>("idle");
  const [discovery, setDiscovery] = useState<ProjectDescriptorDiscoveryV1 | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const generationRef = useRef(0);
  const startedRef = useRef(false);

  const refresh = useCallback(async () => {
    startedRef.current = true;
    const requestSequence = ++requestSequenceRef.current;
    const generation = ++generationRef.current;
    if (!workspaceRoot) {
      setStatus("idle");
      setDiscovery(null);
      setReason(null);
      return;
    }

    setStatus("loading");
    setDiscovery(null);
    setReason(null);

    const fileResult = await workspaceListFilesRecursive(
      workspaceRoot,
      "",
      DISCOVERY_MAX_DEPTH,
      DISCOVERY_MAX_FILES,
    ).catch((error: unknown) => ({ state: "failed" as const, message: errorMessage(error) }));
    if (requestSequence !== requestSequenceRef.current) return;
    if (fileResult.state !== "ready") {
      if (fileResult.state === "cancelled") return;
      const message = fileResult.state === "unavailable" ? fileResult.reason : fileResult.message;
      setStatus("failed");
      setReason(message);
      return;
    }

    const descriptors = fileResult.entries.filter((entry) => entry.fileType === "file" && DESCRIPTOR_NAMES.has(entry.name));
    const inputs: Array<BuildDescriptorInput | undefined> = new Array(descriptors.length);
    const readErrors: Array<string | undefined> = new Array(descriptors.length);
    let cursor = 0;
    // Bound filesystem work for large Maven/Gradle multi-module projects while
    // retaining deterministic descriptor order and per-file diagnostics.
    await Promise.all(Array.from({ length: Math.min(4, descriptors.length) }, async () => {
      while (cursor < descriptors.length && requestSequence === requestSequenceRef.current) {
        const index = cursor++;
        const entry = descriptors[index];
        try {
          const file = await workspaceReadFile(workspaceRoot, entry.path, DESCRIPTOR_MAX_BYTES);
          inputs[index] = { path: absoluteWorkspacePath(workspaceRoot, entry.path), content: file.text };
        } catch (error) {
          readErrors[index] = `${entry.path}: ${errorMessage(error)}`;
        }
      }
    }));

    if (requestSequence !== requestSequenceRef.current) return;
    let nextDiscovery = discoverProjectDescriptors(inputs.filter((input): input is BuildDescriptorInput => !!input), generation);
    if (fileResult.truncated) {
      nextDiscovery = {
        ...nextDiscovery,
        diagnostics: [
          ...nextDiscovery.diagnostics,
          "Workspace file scan was truncated; descriptor discovery may be incomplete",
        ],
      };
    }
    if (readErrors.some(Boolean)) {
      nextDiscovery = {
        ...nextDiscovery,
        diagnostics: [...nextDiscovery.diagnostics, `Descriptor reads failed: ${readErrors.filter(Boolean).join("; ")}`],
      };
    }

    setDiscovery(nextDiscovery);
    setStatus(nextDiscovery.status);
    setReason(nextDiscovery.diagnostics.join("; ") || null);
  }, [workspaceRoot]);

  useEffect(() => {
    startedRef.current = false;
    setStatus("idle");
    setDiscovery(null);
    setReason(null);
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    // Visibility gates initial work only. Switching tabs must neither discard
    // in-flight discovery nor recursively scan the same project again.
    if (options.autoRefresh && workspaceRoot && !startedRef.current) void refresh();
  }, [options.autoRefresh, refresh, workspaceRoot]);

  return { status, discovery, reason, refresh };
}
