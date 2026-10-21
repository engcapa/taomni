import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { StructuredTestResults } from "../../../../lib/editor/workspace";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import { type registerInteractionCasesFixture } from "./interaction.cases";

export function registerExecutionCases(workspaceTestHarness: registerInteractionCasesFixture) {
it("detects workspace tasks and launches them in the integrated terminal", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-run",
      workspaceInstanceId: "instance-run",
      name: "Run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceDetectTasks.mockResolvedValue([{
      id: "package.json:test",
      label: "test",
      command: "pnpm run test",
      cwd: "/repo/app",
      source: "package.json",
    }]);

    workspaceTestHarness.renderWorkspace(workspace);
    fireEvent.click(await screen.findByRole("tab", { name: /Run/ }));
    fireEvent.click(await screen.findByTitle("pnpm run test — /repo/app"));

    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute(
      "data-initial-cwd",
      "/repo/app",
    );
  });
it("ingests structured test results after the Java test terminal exits", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-test-results",
      workspaceInstanceId: "instance-java-test-results",
      name: "Java test results",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/test/java/com/acme/CalcTest.java" },
    };
    const activeStatus = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/test/java/com/acme/CalcTest.java",
      uri: "file:///repo/app/src/test/java/com/acme/CalcTest.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const testItem = {
      name: "fails",
      fullName: "com.acme.CalcTest#fails",
      kind: "method",
      uri: null,
      range: null,
      children: [],
    };
    const report: StructuredTestResults = {
      schema: "taomni.codeWorkspace.testResults",
      version: 1,
      source: "junit-xml",
      generatedAt: 2,
      results: [{
        id: "target/surefire-reports/TEST.xml::com.acme.CalcTest#fails",
        selector: testItem.fullName,
        name: "fails",
        className: "com.acme.CalcTest",
        status: "failed",
        durationMs: 30,
        message: "expected 2",
        details: "stack",
        filePath: "src/test/java/com/acme/CalcTest.java",
        line: 12,
      }],
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, errors: 0, durationMs: 30 },
      diagnostics: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/test/java/com/acme/CalcTest.java",
      "package com.acme; class CalcTest {}",
    ));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    workspaceTestHarness.workspaceMocks.workspaceTaskTree.mockResolvedValue([{
      source: "Maven",
      tasks: [{
        id: "Maven:test",
        label: "test",
        command: "mvn test",
        cwd: "/repo/app",
        source: "Maven",
      }],
    }]);
    workspaceTestHarness.lspMocks.javaTestDiscover.mockResolvedValue([testItem]);
    workspaceTestHarness.workspaceMocks.workspaceTestResults.mockResolvedValue(report);

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/test/java/com/acme/CalcTest.java");
    fireEvent.click(screen.getByRole("tab", { name: /Tests/ }));
    const runButton = await screen.findByTestId(`tests-run-${testItem.fullName}`);
    fireEvent.click(runButton);
    await screen.findByTestId("mock-workspace-terminal");
    fireEvent.click(screen.getByTestId("mock-workspace-terminal-task-exit"));

    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceTestResults).toHaveBeenCalledWith(
      "/repo/app",
      expect.any(Number),
    ));
    expect(workspaceTestHarness.workspaceMocks.workspaceTestResults.mock.calls[0][1]).toBeLessThanOrEqual(Date.now());
  });
it("keeps a shared Java debug-only configuration ahead of compatibility discovery", async () => {
    workspaceTestHarness.runtimeState.tauri = true;
    const sourcePath = "/repo/app/src/main/java/com/acme/App.java";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-shared-debug",
      workspaceInstanceId: "instance-java-shared-debug",
      name: "Java shared debug",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceTestHarness.workspaceMocks.workspaceJavaRunTarget.mockResolvedValue({
      id: "java-main:src/main/java/com/acme/App.java",
      label: "com.acme.App",
      mainClass: "com.acme.App",
      filePath: sourcePath,
      command: "./mvnw compile exec:java",
      cwd: "/repo/app",
      buildSystem: "maven",
      modulePath: ".",
    });
    workspaceTestHarness.workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [{
        id: "project:maven",
        provider: "maven",
        root: "/repo/app",
        manifest: "/repo/app/pom.xml",
        module: "app",
        languages: ["java"],
        toolchain: "maven",
        diagnostics: [],
      }],
      buildTargets: [],
      runConfigurations: [{
        id: "shared-run:remote",
        projectId: "project:maven",
        label: "Remote JVM",
        kind: "debug-only",
        configurationSource: "shared",
        sourceFile: sourcePath,
        preLaunchTargets: [],
        debugConfigurationId: "shared-debug:remote",
        command: {
          executable: "__taomni_debug_only__",
          args: [],
          cwd: "/repo/app",
          env: {},
          display: "Debug only",
          source: "configured",
          error: "This configuration is debug-only; choose Debug to launch it",
        },
      }],
      debugConfigurations: [{
        id: "shared-debug:remote",
        projectId: "project:maven",
        label: "Remote JVM",
        adapterId: "java",
        request: "attach",
        available: true,
        preLaunchTargets: [],
        sourceFile: sourcePath,
        configurationSource: "shared",
        launchConfig: { request: "attach", arguments: { hostName: "127.0.0.1", port: 5005 } },
      }],
      tools: [],
    });
    workspaceTestHarness.dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "shared-java-session",
      capabilities: {},
      request: "attach",
      arguments: { hostName: "127.0.0.1", port: 5005 },
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    await waitFor(() => expect(screen.getByTestId("code-workspace-active-run-configuration")).toHaveValue("shared-run:remote"));
    expect(screen.getByTestId("code-workspace-run-target")).toBeDisabled();
    expect(screen.getByTestId("code-workspace-debug-target")).toBeEnabled();

    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));
    await waitFor(() => expect(workspaceTestHarness.dapMocks.dapStartSession).toHaveBeenCalledWith(
      "java",
      expect.objectContaining({ request: "attach" }),
    ));
    expect(workspaceTestHarness.workspaceMocks.workspaceJavaRunTarget).toHaveBeenCalled();
  });
it("uses provider capabilities to run and debug an active non-Java target", async () => {
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-go-run",
      workspaceInstanceId: "instance-go-run",
      name: "Go run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "cmd/demo/main.go" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "cmd/demo/main.go",
      "package main\nfunc main() {}\n",
    ));
    workspaceTestHarness.workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [{
        id: "project:go",
        provider: "go",
        root: "/repo/app",
        manifest: "/repo/app/go.mod",
        module: "app",
        languages: ["go"],
        toolchain: "go",
        diagnostics: [],
      }],
      buildTargets: [],
      runConfigurations: [{
        id: "run:go",
        projectId: "project:go",
        label: "Run ./cmd/demo",
        kind: "main-package",
        sourceFile: "/repo/app/cmd/demo/main.go",
        preLaunchTargets: [],
        debugConfigurationId: "debug:go",
        command: {
          executable: "go",
          args: ["run", "./cmd/demo", "--"],
          cwd: "/repo/app",
          env: {},
          display: "go run ./cmd/demo --",
          source: "path",
        },
      }],
      debugConfigurations: [{
        id: "debug:go",
        projectId: "project:go",
        label: "Debug ./cmd/demo",
        adapterId: "delve",
        request: "launch",
        available: true,
        preLaunchTargets: [],
        sourceFile: "/repo/app/cmd/demo/main.go",
        launchConfig: {
          adapterCommand: "dlv",
          adapterCwd: "/repo/app",
          mode: { kind: "managedTcp", args: ["dap", "--listen=127.0.0.1:${port}"] },
          arguments: { mode: "debug", program: "/repo/app/cmd/demo" },
        },
      }],
      tools: [],
    });
    workspaceTestHarness.dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "go-session",
      capabilities: {},
      request: "launch",
      arguments: { mode: "debug", program: "/repo/app/cmd/demo" },
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / cmd/demo/main.go");
    await waitFor(() => expect(screen.getByTestId("code-workspace-run-target")).toBeEnabled());
    fireEvent.click(screen.getByTestId("code-workspace-run-target"));
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");

    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));
    await waitFor(() => expect(workspaceTestHarness.dapMocks.dapStartSession).toHaveBeenCalledWith(
      "delve",
      expect.objectContaining({ adapterCommand: "dlv", adapterCwd: "/repo/app" }),
    ));
  });
it("keeps project-level configurations scoped to the active workspace root", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/one",
      workspaceId: "ws-multi-root-config",
      workspaceInstanceId: "instance-multi-root-config",
      name: "Multi-root configurations",
      roots: [
        { id: "one", name: "one", path: "/repo/one", kind: "git" },
        { id: "two", name: "two", path: "/repo/two", kind: "git" },
      ],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "one", path: "src/main.go" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main.go",
      "package main\nfunc main() {}\n",
    ));
    workspaceTestHarness.workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [
        {
          id: "project:one",
          provider: "go",
          root: "/repo/one",
          manifest: "/repo/one/go.mod",
          module: "one",
          languages: ["go"],
          toolchain: "go",
          diagnostics: [],
        },
        {
          id: "project:two",
          provider: "go",
          root: "/repo/two",
          manifest: "/repo/two/go.mod",
          module: "two",
          languages: ["go"],
          toolchain: "go",
          diagnostics: [],
        },
      ],
      buildTargets: [],
      runConfigurations: [
        {
          id: "shared-run:one",
          projectId: "project:one",
          label: "One project launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "."],
            cwd: "/repo/one",
            env: {},
            display: "go run .",
            source: "path",
          },
        },
        {
          id: "shared-run:two",
          projectId: "project:two",
          label: "Two project launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "."],
            cwd: "/repo/two",
            env: {},
            display: "go run .",
            source: "path",
          },
        },
        {
          id: "shared-run:one-alt",
          projectId: "project:one",
          label: "One alternate launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "./cmd/alternate"],
            cwd: "/repo/one",
            env: {},
            display: "go run ./cmd/alternate",
            source: "path",
          },
        },
      ],
      debugConfigurations: [],
      tools: [],
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("one / src/main.go");
    await waitFor(() => expect(screen.getByTestId("code-workspace-active-run-configuration")).toBeInTheDocument());
    const selector = screen.getByTestId("code-workspace-active-run-configuration");
    expect(selector).toHaveTextContent("One project launch");
    expect(selector).not.toHaveTextContent("Two project launch");
  });
it("starts a Java debug session from the toolbar under StrictMode", async () => {
    // Regression: the tab's mounted-guard ref was cleared by StrictMode's dev
    // double-invoke and never re-armed, so `if (!mountedRef.current) return`
    // aborted the launch right after the main class was resolved — the click
    // resolved the class, then silently did nothing (no session, no message).
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug",
      workspaceInstanceId: "instance-java-debug",
      name: "Java debug",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceTestHarness.dapMocks.dapResolveJavaMainClasses.mockResolvedValue({
      kind: "resolved",
      main: {
        mainClass: "com.acme.App",
        projectName: "app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
      },
    });
    workspaceTestHarness.dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "sess-1",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "com.acme.App" },
    });

    workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    await waitFor(() => expect(workspaceTestHarness.dapMocks.dapStartSession).toHaveBeenCalledWith(
      "java",
      expect.objectContaining({
        rootPath: "/repo/app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
        mainClass: "com.acme.App",
        projectName: "app",
      }),
    ));
    // Make-before-launch must run as an incremental build (jdtls autobuilds on
    // save; a clean rebuild would add minutes to every debug start) and must
    // target the file being launched: the jdtls session key includes the
    // nearest module walking up from the path, so a synthetic root-level path
    // misses the module session in a multi-module build and the build is
    // skipped with "no language server session is active".
    expect(workspaceTestHarness.lspMocks.lspBuildWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/repo/app",
        filePath: "src/main/java/com/acme/App.java",
      }),
      false,
    );
    // The panel reports each pre-launch step, so a slow start is never blank.
    const consoleOutput = await screen.findByTestId("debug-console-output");
    expect(consoleOutput.textContent).toContain("Starting debug for App.java");
    expect(consoleOutput.textContent).toContain("Building project…");
    expect(consoleOutput.textContent).toContain("Launching com.acme.App…");
  });
it("blocks a Java debug launch when the pre-launch build fails", async () => {
    // A failed build must say so rather than launching stale bytecode.
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-build-fail",
      workspaceInstanceId: "instance-java-debug-build-fail",
      name: "Java debug build fail",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceTestHarness.lspMocks.lspBuildWorkspace.mockResolvedValue("failed");

    workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    const consoleOutput = await screen.findByTestId("debug-console-output");
    await waitFor(() => expect(consoleOutput.textContent).toContain(
      "Cannot start debug: the project build failed",
    ));
    expect(workspaceTestHarness.dapMocks.dapResolveJavaMainClasses).not.toHaveBeenCalled();
    expect(workspaceTestHarness.dapMocks.dapStartSession).not.toHaveBeenCalled();
  });
it("blocks a Java debug launch when the build compiles with errors and opens Problems", async () => {
    // `withError` is the compiler's own verdict (jdtls BuildWorkspaceStatus):
    // surface the real error list in project-scope Problems instead of launching.
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-with-error",
      workspaceInstanceId: "instance-java-debug-with-error",
      name: "Java debug with error",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceTestHarness.lspMocks.lspBuildWorkspace.mockResolvedValue("withError");

    workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    const consoleOutput = await screen.findByTestId("debug-console-output");
    await waitFor(() => expect(consoleOutput.textContent).toContain(
      "Cannot start debug: the project compiled with errors",
    ));
    expect(workspaceTestHarness.dapMocks.dapResolveJavaMainClasses).not.toHaveBeenCalled();
    expect(workspaceTestHarness.dapMocks.dapStartSession).not.toHaveBeenCalled();
  });
}
