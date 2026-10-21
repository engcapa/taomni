import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { sockscapCapabilities, sockscapRedirectorInstallStatus } from "../../../../lib/sockscap";
import { SocksCapPanel } from "../../SocksCapPanel";
import { fixtureState } from "./harness";

export function registerSocksCapPanelNavigation3Cases() {

  it("blocks repeated Start attempts while macOS System Extension approval is waiting", async () => {
    fixtureState.currentPlatform = "macos";
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "waitingForUser",
      message: "Mitmproxy Redirector is waiting for approval in System Settings.",
    });
    render(<SocksCapPanel />);

    const start = await screen.findByTestId("sockscap-start");
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute(
      "title",
      expect.stringContaining("Approve the Mitmproxy Redirector System Extension"),
    );
    expect(await screen.findByTestId("sockscap-redirector-action")).toHaveTextContent(
      "Refresh approval",
    );
  });

  it("keeps first Start available before Redirector has registered its approval request", async () => {
    fixtureState.currentPlatform = "macos";
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "notRegistered",
      message: "Start SocksCap once, then approve its System Extension.",
    });
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-start")).not.toBeDisabled();
  });

  it("disables app scope and shows the backend notes when app filtering is unavailable", async () => {
    fixtureState.currentPlatform = "macos";
    vi.mocked(sockscapCapabilities).mockResolvedValueOnce({
      platform: "macos",
      globalTcp: true,
      appFilter: false,
      captureBackend: "mitmproxy-redirector",
      notes: ["Global capture is available. Application scope remains disabled."],
      privilegedRequired: false,
    });
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-mode-apps")).toBeDisabled();
    const capabilityNotes = await screen.findByTestId("sockscap-capability-notes");
    expect(capabilityNotes.getAttribute("title")).toContain("Application scope remains disabled");
  });

  it("keeps app scope selectable where the backend can identify applications", async () => {
    fixtureState.currentPlatform = "windows";
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-mode-apps")).not.toBeDisabled();
  });
}
