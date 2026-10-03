import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SdkInstallation,
  SdkRegistry,
  WorkspaceSdkBinding,
  WorkspaceSdkResolution,
} from "../../../lib/editor/sdk";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { WorkspaceSdkStatus } from "./WorkspaceSdkStatus";

const sdkMocks = vi.hoisted(() => ({
  getRegistry: vi.fn(),
  removeBinding: vi.fn(),
  resolveWorkspace: vi.fn(),
  saveBinding: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

const navigationMocks = vi.hoisted(() => ({
  openSettingsSection: vi.fn(),
}));

vi.mock("../../../lib/editor/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/editor/sdk")>();
  return {
    ...actual,
    sdkGetRegistry: sdkMocks.getRegistry,
    sdkRemoveWorkspaceBinding: sdkMocks.removeBinding,
    sdkResolveWorkspace: sdkMocks.resolveWorkspace,
    sdkSaveWorkspaceBinding: sdkMocks.saveBinding,
    subscribeSdkRegistryChanged: sdkMocks.subscribe,
  };
});

vi.mock("../../../lib/settingsNavigation", () => navigationMocks);

const root: CodeWorkspaceRootInfo = {
  id: "root-kotlin",
  name: "kotlin-service",
  path: "C:\\work\\kotlin-service",
  kind: "folder",
};

function installation(
  id: string,
  name: string,
  version: string,
  location: string,
): SdkInstallation {
  return {
    id,
    kind: "java",
    name,
    location,
    executables: { java: `${location}\\bin\\java.exe` },
    version,
    vendor: "Eclipse Adoptium",
    architecture: "x86_64",
    origin: "manual",
    status: "ready",
    lastError: null,
    lastProbedAt: "2026-07-18T00:00:00Z",
  };
}

const jdk17 = installation("jdk-17", "Temurin 17", "17.0.15", "C:\\jdks\\17");
const jdk21 = installation("jdk-21", "Temurin 21", "21.0.7", "C:\\jdks\\21");

const resolution: WorkspaceSdkResolution = {
  analysis: {
    workspaceRoot: root.path,
    warnings: [],
    profiles: [{
      scopePath: root.path,
      relativePath: "",
      displayName: "kotlin-service",
      buildSystems: ["gradle"],
      languages: ["java", "kotlin"],
      requirements: [{
        kind: "java",
        role: "project",
        constraint: { raw: "17", policy: "exactMajor", major: 17 },
        requiredLocation: null,
        managedByBuild: false,
        source: "Gradle Java toolchain",
        confidence: "high",
        evidence: [{
          sourcePath: "build.gradle.kts",
          key: "java.toolchain.languageVersion",
          value: "17",
          confidence: "high",
        }],
      }, {
        kind: "kotlin",
        role: "compiler",
        constraint: { raw: "2.1.20", policy: "exact", major: 2 },
        requiredLocation: null,
        managedByBuild: true,
        source: "Gradle Kotlin plugin",
        confidence: "high",
        evidence: [{
          sourcePath: "libs.versions.toml",
          key: "plugins.kotlin",
          value: "2.1.20",
          confidence: "high",
        }],
      }],
      kotlin: {
        platform: "jvm",
        compilerMode: "buildManaged",
        compilerVersion: "2.1.20",
        languageVersion: "2.1",
        apiVersion: "2.0",
        jvmTarget: "17",
        javaToolchain: "17",
        gradleLauncherJavaHome: "C:\\jdks\\21",
      },
    }],
  },
  resolved: [{
    scopePath: root.path,
    kind: "java",
    role: "project",
    requirement: {
      kind: "java",
      role: "project",
      constraint: { raw: "17", policy: "exactMajor", major: 17 },
      requiredLocation: null,
      managedByBuild: false,
      source: "Gradle Java toolchain",
      confidence: "high",
      evidence: [{
        sourcePath: "build.gradle.kts",
        key: "java.toolchain.languageVersion",
        value: "17",
        confidence: "high",
      }],
    },
    installation: jdk17,
    source: "autoMatch",
    status: "resolved",
    reason: "Automatically matched Temurin 17 to JDK 17",
  }, {
    scopePath: root.path,
    kind: "kotlin",
    role: "compiler",
    requirement: {
      kind: "kotlin",
      role: "compiler",
      constraint: { raw: "2.1.20", policy: "exact", major: 2 },
      requiredLocation: null,
      managedByBuild: true,
      source: "Gradle Kotlin plugin",
      confidence: "high",
      evidence: [],
    },
    installation: null,
    source: "buildManaged",
    status: "managed",
    reason: "Gradle Kotlin plugin is downloaded and managed by the build tool",
  }],
};

let registry: SdkRegistry;

describe("WorkspaceSdkStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry = {
      schemaVersion: 1,
      installations: [jdk17, jdk21],
      defaults: [{ kind: "java", sdkId: jdk17.id }],
      bindings: [],
    };
    sdkMocks.getRegistry.mockImplementation(async () => registry);
    sdkMocks.resolveWorkspace.mockResolvedValue(resolution);
    sdkMocks.saveBinding.mockImplementation(async (request): Promise<WorkspaceSdkBinding> => {
      const binding: WorkspaceSdkBinding = {
        scopePath: request.scopePath,
        kind: request.kind,
        role: request.role,
        mode: request.mode,
        sdkId: request.sdkId ?? null,
        updatedAt: "2026-07-18T01:00:00Z",
      };
      registry = {
        ...registry,
        bindings: [
          ...registry.bindings.filter((item) => !(
            item.scopePath === binding.scopePath
            && item.kind === binding.kind
            && item.role === binding.role
          )),
          binding,
        ],
      };
      return binding;
    });
    sdkMocks.removeBinding.mockImplementation(async (scopePath, kind, role) => {
      registry = {
        ...registry,
        bindings: registry.bindings.filter((item) => !(
          item.scopePath === scopePath && item.kind === kind && item.role === role
        )),
      };
    });
  });

  afterEach(cleanup);

  async function openDialog() {
    render(<WorkspaceSdkStatus roots={[root]} />);
    expect(await screen.findByText("SDKs ready")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("code-workspace-sdk-status"));
    return screen.getByTestId("workspace-sdk-dialog");
  }

  it("shows Kotlin compiler and JVM configuration without requiring a standalone compiler", async () => {
    const dialog = await openDialog();
    const kotlinProfile = within(dialog).getByTestId(/workspace-kotlin-profile-/);

    expect(kotlinProfile).toHaveTextContent("Kotlin project configuration");
    expect(kotlinProfile).toHaveTextContent("Build managed");
    expect(kotlinProfile).toHaveTextContent("2.1.20");
    expect(kotlinProfile).toHaveTextContent("2.1");
    expect(kotlinProfile).toHaveTextContent("2.0");
    expect(kotlinProfile).toHaveTextContent("JVM target");
    expect(kotlinProfile).toHaveTextContent("Java toolchain");
    expect(kotlinProfile).toHaveTextContent("Gradle launcher JDK");
    expect(within(dialog).getByRole("combobox", { name: "Kotlin Compiler" })).toBeDisabled();
  });

  it("saves a project JDK override and restores automatic matching", async () => {
    const dialog = await openDialog();
    const projectJdk = within(dialog).getByRole("combobox", { name: "Java / JDK Project runtime" });

    fireEvent.change(projectJdk, { target: { value: jdk21.id } });
    await waitFor(() => expect(sdkMocks.saveBinding).toHaveBeenCalledWith({
      scopePath: root.path,
      kind: "java",
      role: "project",
      mode: "manual",
      sdkId: jdk21.id,
    }));
    await waitFor(() => expect(projectJdk).toHaveValue(jdk21.id));

    fireEvent.change(projectJdk, { target: { value: "" } });
    await waitFor(() => expect(sdkMocks.removeBinding).toHaveBeenCalledWith(
      root.path,
      "java",
      "project",
    ));
  });

  it("binds the JDT LS tooling JDK independently from the project JDK", async () => {
    const dialog = await openDialog();
    const projectJdk = within(dialog).getByRole("combobox", { name: "Java / JDK Project runtime" });
    const toolingJdk = within(dialog).getByRole("combobox", { name: "Java / JDK Language-server tooling" });

    expect(projectJdk).toHaveValue("");
    expect(toolingJdk).toHaveValue("");
    fireEvent.change(toolingJdk, { target: { value: jdk21.id } });

    await waitFor(() => expect(sdkMocks.saveBinding).toHaveBeenCalledWith({
      scopePath: root.path,
      kind: "java",
      role: "tooling",
      mode: "manual",
      sdkId: jdk21.id,
    }));
    expect(projectJdk).toHaveValue("");
  });

  it("opens the global SDK manager from the workspace dialog", async () => {
    await openDialog();
    await userEvent.click(screen.getByTestId("workspace-sdk-open-settings"));
    expect(navigationMocks.openSettingsSection).toHaveBeenCalledWith("sdks");
  });
});
