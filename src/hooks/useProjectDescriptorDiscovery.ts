import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceListDir,
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
  options: { autoRefresh?: boolean; autoScope?: "root" | "recursive" } = {},
): ProjectDescriptorDiscoveryState {
  const [status, setStatus] = useState<ProjectDescriptorDiscoveryStatus>("idle");
  const [discovery, setDiscovery] = useState<ProjectDescriptorDiscoveryV1 | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const generationRef = useRef(0);

  const discover = useCallback(async (scope: "root" | "recursive") => {
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

    // Browsing an ordinary folder needs only its own build descriptors. Full
    // discovery remains available when sources or an explicit refresh need it.
    const fileResult = scope === "root"
      ? await workspaceListDir(workspaceRoot, "")
      : await workspaceListFilesRecursive(workspaceRoot, "", DISCOVERY_MAX_DEPTH, DISCOVERY_MAX_FILES);
    if (requestSequence !== requestSequenceRef.current) return;
    if (fileResult.state !== "ready") {
      if (fileResult.state === "cancelled") return;
      const message = fileResult.state === "unavailable" ? fileResult.reason : fileResult.message;
      setStatus("failed");
      setReason(message);
      return;
    }

    const inputs: BuildDescriptorInput[] = [];
    const readErrors: string[] = [];
    for (const entry of fileResult.entries) {
      if (entry.fileType !== "file" || !DESCRIPTOR_NAMES.has(entry.name)) continue;
      if (requestSequence !== requestSequenceRef.current) return;
      try {
        const file = await workspaceReadFile(workspaceRoot, entry.path, DESCRIPTOR_MAX_BYTES);
        inputs.push({
          path: absoluteWorkspacePath(workspaceRoot, entry.path),
          content: file.text,
        });
      } catch (error) {
        readErrors.push(`${entry.path}: ${errorMessage(error)}`);
      }
    }

    if (requestSequence !== requestSequenceRef.current) return;
    let nextDiscovery = discoverProjectDescriptors(inputs, generation);
    if (fileResult.truncated) {
      nextDiscovery = {
        ...nextDiscovery,
        diagnostics: [
          ...nextDiscovery.diagnostics,
          "Workspace file scan was truncated; descriptor discovery may be incomplete",
        ],
      };
    }
    if (readErrors.length > 0) {
      nextDiscovery = {
        ...nextDiscovery,
        diagnostics: [...nextDiscovery.diagnostics, `Descriptor reads failed: ${readErrors.join("; ")}`],
      };
    }

    setDiscovery(nextDiscovery);
    setStatus(nextDiscovery.status);
    setReason(nextDiscovery.diagnostics.join("; ") || null);
  }, [workspaceRoot]);
  const refresh = useCallback(() => discover("recursive"), [discover]);

  useEffect(() => {
    if (!options.autoRefresh || !workspaceRoot) {
      if (!workspaceRoot) {
        setStatus("idle");
        setDiscovery(null);
        setReason(null);
      }
      return;
    }
    void discover(options.autoScope ?? "recursive");
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [options.autoRefresh, options.autoScope, discover, workspaceRoot]);

  return { status, discovery, reason, refresh };
}
