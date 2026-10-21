import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  sockscapCapabilities,
  sockscapInstallRedirector,
  sockscapLaunchApp,
  sockscapRecover,
  sockscapRedirectorInstallStatus,
  sockscapStart,
  sockscapTestUpstream,
} from "../../../../lib/sockscap";
import { useAppStore } from "../../../../stores/appStore";
import { SOCKSCAP_MACOS_SETUP_STORAGE_KEY, SocksCapPanel } from "../../SocksCapPanel";
import { dialogOpenMock, fixtureState } from "./harness";

export function registerSocksCapPanelHistory2Cases() {

  it("uses the file picker to fill a rootless command without launching it", async () => {
    fixtureState.currentPlatform = "linux";
    dialogOpenMock.mockResolvedValue("/usr/bin/example-app");
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-pick-linux-application"));

    await waitFor(() =>
      expect(screen.getByTestId("sockscap-rootless-command")).toHaveValue(
        "/usr/bin/example-app",
      ),
    );
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
    expect(vi.mocked(sockscapLaunchApp)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));
    await waitFor(() => expect(fixtureState.currentCfg.profiles[0].apps).toHaveLength(1));
    expect(fixtureState.currentCfg.profiles[0].apps).toEqual([
      {
        path: "/usr/bin/example-app",
        args: [],
        launchMode: "desktop",
        name: "example-app",
      },
    ]);
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
  });

  it("adds a PATH command with parsed arguments before launching", async () => {
    fixtureState.currentPlatform = "linux";
    render(<SocksCapPanel />);

    fireEvent.change(await screen.findByTestId("sockscap-rootless-command"), {
      target: { value: "google-chrome-stable" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-arguments"), {
      target: { value: '--incognito "--user-data-dir=/tmp/chrome profile"' },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));

    await waitFor(() =>
      expect(fixtureState.currentCfg.profiles[0].apps).toEqual([
        {
          path: "google-chrome-stable",
          args: ["--incognito", "--user-data-dir=/tmp/chrome profile"],
          launchMode: "desktop",
          name: "google-chrome-stable",
        },
      ]),
    );
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId("sockscap-launch-app-0"));
    await waitFor(() =>
      expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledWith(
        "default",
        "google-chrome-stable",
        ["--incognito", "--user-data-dir=/tmp/chrome profile"],
        {},
      ),
    );
  });

  it("adds, edits, and launches a desktop application with launch preparation", async () => {
    fixtureState.currentPlatform = "linux";
    render(<SocksCapPanel />);

    fireEvent.change(await screen.findByTestId("sockscap-rootless-command"), {
      target: { value: "./bin/example-app" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-arguments"), {
      target: { value: '"argument with spaces"' },
    });
    fireEvent.click(screen.getByTestId("sockscap-rootless-preparation-toggle"));
    fireEvent.change(screen.getByTestId("sockscap-rootless-working-directory"), {
      target: { value: "/workspace/example" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-shell"), {
      target: { value: "bash" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-pre-command"), {
      target: { value: "export PREPARED=yes" },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-environment"));
    fireEvent.change(screen.getByTestId("sockscap-rootless-environment-name-0"), {
      target: { value: "APP_ENV" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-environment-value-0"), {
      target: { value: "development" },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));

    await waitFor(() =>
      expect(fixtureState.currentCfg.profiles[0].apps).toEqual([
        {
          path: "./bin/example-app",
          args: ["argument with spaces"],
          launchMode: "desktop",
          launchPreparation: {
            workingDirectory: "/workspace/example",
            environment: { APP_ENV: "development" },
            preCommand: "export PREPARED=yes",
            shell: "bash",
          },
          name: "example-app",
        },
      ]),
    );

    fireEvent.click(screen.getByTestId("sockscap-edit-app-0"));
    expect(screen.getByTestId("sockscap-rootless-working-directory")).toHaveValue(
      "/workspace/example",
    );
    fireEvent.change(screen.getByTestId("sockscap-rootless-working-directory"), {
      target: { value: "/workspace/updated" },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));
    await waitFor(() =>
      expect(fixtureState.currentCfg.profiles[0].apps[0].launchPreparation?.workingDirectory).toBe(
        "/workspace/updated",
      ),
    );

    fireEvent.click(screen.getByTestId("sockscap-launch-app-0"));
    await waitFor(() =>
      expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledWith(
        "default",
        "./bin/example-app",
        ["argument with spaces"],
        {
          workingDirectory: "/workspace/updated",
          environment: { APP_ENV: "development" },
          preCommand: "export PREPARED=yes",
          shell: "bash",
        },
      ),
    );
  });

  it("opens a terminal tab for a TUI command instead of launching it without a TTY", async () => {
    fixtureState.currentPlatform = "linux";
    render(<SocksCapPanel />);

    fireEvent.change(await screen.findByTestId("sockscap-rootless-command"), {
      target: { value: "agy" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-launch-mode"), {
      target: { value: "terminal" },
    });
    fireEvent.click(screen.getByTestId("sockscap-rootless-preparation-toggle"));
    fireEvent.change(screen.getByTestId("sockscap-rootless-working-directory"), {
      target: { value: "/workspace/agy" },
    });
    fireEvent.change(screen.getByTestId("sockscap-rootless-pre-command"), {
      target: { value: "export AGL_RUN_MODE=prepared" },
    });
    fireEvent.click(screen.getByTestId("sockscap-add-rootless-application"));

    await waitFor(() =>
      expect(fixtureState.currentCfg.profiles[0].apps).toEqual([
        {
          path: "agy",
          args: [],
          launchMode: "terminal",
          launchPreparation: {
            workingDirectory: "/workspace/agy",
            preCommand: "export AGL_RUN_MODE=prepared",
          },
          name: "agy",
        },
      ]),
    );
    fireEvent.click(await screen.findByTestId("sockscap-launch-app-0"));

    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalledWith(undefined));
    expect(vi.mocked(sockscapLaunchApp)).not.toHaveBeenCalled();
    const terminalTab = useAppStore
      .getState()
      .tabs.find((tab) => tab.sockscapTerminal?.path === "agy");
    expect(terminalTab).toMatchObject({
      type: "terminal",
      title: "agy",
      sockscapTerminal: {
        profileId: "default",
        path: "agy",
        args: [],
        launchPreparation: {
          workingDirectory: "/workspace/agy",
          preCommand: "export AGL_RUN_MODE=prepared",
        },
      },
    });
    if (terminalTab) useAppStore.getState().removeTab(terminalTab.id);
  });

  it("starts multiple configured rootless applications independently", async () => {
    fixtureState.currentPlatform = "linux";
    fixtureState.currentCfg.profiles[0].apps = [
      { path: "first-app", args: ["--one"], name: "First" },
      { path: "second-app", args: ["--two"], name: "Second" },
    ];
    fixtureState.currentCfg.apps = fixtureState.currentCfg.profiles[0].apps;
    let pid = 5000;
    vi.mocked(sockscapLaunchApp).mockImplementation(async (profileId, path, args, launchPreparation) => ({
      pid: pid++,
      profileId,
      path,
      args: args ?? [],
      launchPreparation,
      running: true,
    }));
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-launch-app-0"));
    await waitFor(() => expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("sockscap-launch-app-1"));
    await waitFor(() => expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledTimes(2));

    expect(vi.mocked(sockscapStart)).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Running · PID 5000")).toBeInTheDocument();
    expect(screen.getByText("Running · PID 5001")).toBeInTheDocument();
  });

  it("shows a structured error when launch preparation fails", async () => {
    fixtureState.currentPlatform = "linux";
    fixtureState.currentCfg.profiles[0].apps = [
      {
        path: "example-app",
        args: [],
        launchPreparation: { preCommand: "false" },
        name: "Example",
      },
    ];
    fixtureState.currentCfg.apps = fixtureState.currentCfg.profiles[0].apps;
    vi.mocked(sockscapLaunchApp).mockResolvedValueOnce({
      pid: 5002,
      profileId: "default",
      path: "example-app",
      args: [],
      launchPreparation: { preCommand: "false" },
      phase: "failed",
      launchError: "application PID 5002 exited with status 1 before the target started",
      running: false,
    });
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-launch-app-0"));

    expect(
      await screen.findByText(/Launch failed: application PID 5002 exited with status 1/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Running · PID 5002")).not.toBeInTheDocument();
  });

  it("retries Recover with sudo without accidentally starting capture", async () => {
    fixtureState.currentPlatform = "linux";
    vi.mocked(sockscapRecover).mockRejectedValueOnce(
      "query nftables table failed: Operation not permitted. Linux capture requires CAP_NET_ADMIN",
    );
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-recover"));
    expect(await screen.findByTestId("sockscap-root-prompt-dialog")).toHaveTextContent(
      "Removing residual Linux nftables and cgroup state requires Root privileges",
    );

    fireEvent.change(screen.getByTestId("sockscap-root-password-input"), {
      target: { value: "sudo-secret" },
    });
    fireEvent.click(screen.getByTestId("sockscap-root-prompt-submit"));

    await waitFor(() => {
      expect(vi.mocked(sockscapRecover)).toHaveBeenNthCalledWith(1, undefined);
      expect(vi.mocked(sockscapRecover)).toHaveBeenNthCalledWith(2, "sudo-secret");
    });
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("sockscap-root-prompt-dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps the Recover sudo prompt open after authentication fails", async () => {
    fixtureState.currentPlatform = "linux";
    vi.mocked(sockscapRecover)
      .mockRejectedValueOnce(
        "query nftables table failed: Operation not permitted. Linux capture requires CAP_NET_ADMIN",
      )
      .mockRejectedValueOnce("sudo authentication failed: Sorry, try again");
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-recover"));
    fireEvent.change(await screen.findByTestId("sockscap-root-password-input"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByTestId("sockscap-root-prompt-submit"));

    expect(await screen.findByTestId("sockscap-root-prompt-error")).toHaveTextContent(
      "Sudo password incorrect or authentication failed",
    );
    expect(screen.getByTestId("sockscap-root-prompt-dialog")).toBeInTheDocument();
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
  });

  it("blocks start and warns when the active upstream is unconfigured", async () => {
    // Empty host → nothing to dial.
    fixtureState.currentCfg.profiles[0].upstream = { kind: "socks5", sessionId: "", host: "", port: 0 };

    render(<SocksCapPanel />);
    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    expect(
      await screen.findByTestId("sockscap-config-issue-dialog"),
    ).toBeInTheDocument();
    // Never probes or starts an unconfigured upstream.
    expect(vi.mocked(sockscapTestUpstream)).not.toHaveBeenCalled();
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sockscap-config-issue-ok"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("sockscap-config-issue-dialog"),
      ).not.toBeInTheDocument(),
    );
  });

  it("probes the upstream and starts directly when it is reachable", async () => {
    render(<SocksCapPanel />);
    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    await waitFor(() => expect(vi.mocked(sockscapTestUpstream)).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalled());
    // No prompt appears on a clean probe.
    expect(
      screen.queryByTestId("sockscap-probe-fail-dialog"),
    ).not.toBeInTheDocument();
  });

  it("offers force/cancel when the upstream probe fails", async () => {
    vi.mocked(sockscapTestUpstream).mockRejectedValue("connection refused");

    render(<SocksCapPanel />);
    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    expect(
      await screen.findByTestId("sockscap-probe-fail-dialog"),
    ).toBeInTheDocument();
    // Probe ran, but start was withheld pending the user's decision.
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();

    // Cancel leaves capture stopped.
    fireEvent.click(screen.getByTestId("sockscap-probe-fail-cancel"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("sockscap-probe-fail-dialog"),
      ).not.toBeInTheDocument(),
    );
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
  });

  it("force-starts after a failed probe when the user confirms", async () => {
    vi.mocked(sockscapTestUpstream).mockRejectedValue("connection refused");

    render(<SocksCapPanel />);
    const startButton = await screen.findByTestId("sockscap-start");
    fireEvent.click(startButton);

    fireEvent.click(await screen.findByTestId("sockscap-probe-fail-force"));
    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalled());
  });

  it("opens the ordered macOS setup guide when Redirector is missing", async () => {
    fixtureState.currentPlatform = "macos";
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "missing",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "notRegistered",
      message: "Mitmproxy Redirector is not installed.",
    });

    render(<SocksCapPanel />);

    const guide = await screen.findByTestId("sockscap-macos-setup-dialog");
    expect(within(guide).getByTestId("sockscap-macos-setup-step-1")).toHaveTextContent(
      "Install Mitmproxy Redirector",
    );
    expect(within(guide).getByTestId("sockscap-macos-setup-step-2")).toHaveTextContent(
      "Start once to request system approval",
    );
    expect(within(guide).getByTestId("sockscap-macos-setup-step-3")).toHaveTextContent(
      "Privacy & Security",
    );
    expect(within(guide).getByTestId("sockscap-macos-setup-step-4")).toHaveTextContent(
      "Refresh, then start again",
    );

    fireEvent.click(within(guide).getByTestId("sockscap-macos-setup-install"));
    await waitFor(() => expect(vi.mocked(sockscapInstallRedirector)).toHaveBeenCalledOnce());
  });

  it("shows macOS approval location and refreshes a waiting Redirector", async () => {
    fixtureState.currentPlatform = "macos";
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "waitingForUser",
      message: "Mitmproxy Redirector is waiting for approval in System Settings.",
    });

    render(<SocksCapPanel />);

    const guide = await screen.findByTestId("sockscap-macos-setup-dialog");
    expect(guide).toHaveTextContent(
      "System Settings → Privacy & Security → Security → Allow",
    );
    fireEvent.click(within(guide).getByTestId("sockscap-macos-setup-refresh"));
    await waitFor(() =>
      expect(vi.mocked(sockscapRedirectorInstallStatus)).toHaveBeenCalledTimes(2),
    );
  });

  it("keeps macOS setup help beside Start after Redirector is ready", async () => {
    fixtureState.currentPlatform = "macos";

    render(<SocksCapPanel />);

    await screen.findByTestId("sockscap-start");
    expect(screen.queryByTestId("sockscap-macos-setup-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sockscap-macos-setup-help"));

    const guide = await screen.findByTestId("sockscap-macos-setup-dialog");
    expect(guide).toHaveTextContent("macOS capture setup help");
    expect(guide).toHaveTextContent("System Settings → Network → VPN & Filters");
  });

  it("remembers a completed macOS setup after capture starts", async () => {
    fixtureState.currentPlatform = "macos";

    render(<SocksCapPanel />);
    fireEvent.click(await screen.findByTestId("sockscap-start"));

    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalled());
    expect(window.localStorage.getItem(SOCKSCAP_MACOS_SETUP_STORAGE_KEY)).toBe("complete");
  });

  it("does not request a sudo password for macOS Redirector errors", async () => {
    fixtureState.currentPlatform = "macos";
    vi.mocked(sockscapCapabilities).mockResolvedValueOnce({
      platform: "macos",
      globalTcp: true,
      appFilter: false,
      captureBackend: "mitmproxy-redirector",
      notes: ["Global capture is available through Mitmproxy Redirector."],
      privilegedRequired: false,
    });
    vi.mocked(sockscapStart).mockRejectedValueOnce(
      "approve the Mitmproxy Redirector System Extension and network configuration",
    );
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-start"));

    expect(
      await screen.findByText(/approve the Mitmproxy Redirector System Extension/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-root-prompt-dialog")).not.toBeInTheDocument();
    expect(vi.mocked(sockscapStart)).toHaveBeenCalledWith(undefined);
  });
}
