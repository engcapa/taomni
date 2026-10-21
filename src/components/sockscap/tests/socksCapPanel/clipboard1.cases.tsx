import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { listSessions, vaultPut, vaultStatus, type SessionConfig } from "../../../../lib/ipc";
import {
  sockscapDetectTunConflicts,
  sockscapImportSubscription,
  sockscapLaunchApp,
  sockscapParseShareLink,
  sockscapStart,
  sockscapStatus,
  sockscapStop,
  sockscapStopLaunchedApp,
} from "../../../../lib/sockscap";
import { SocksCapPanel } from "../../SocksCapPanel";
import { defaultTestCfg, fixtureState } from "./harness";

export function registerSocksCapPanelClipboard1Cases() {

  it("renders profile manager sidebar and default profile", async () => {
    render(<SocksCapPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("sockscap-panel")).toBeInTheDocument();
      expect(screen.getByTestId("sockscap-profile-list")).toBeInTheDocument();
      expect(screen.getByTestId("sockscap-add-profile")).toBeInTheDocument();
    });
    expect(screen.getByTestId("sockscap-header-summary")).toHaveTextContent(
      "1 active · 默认方案",
    );
    expect(screen.getByTestId("sockscap-header-summary")).toHaveTextContent(
      "0 flows · 0 proxy · 0 direct",
    );
    expect(screen.getByTestId("sockscap-capability-notes")).toHaveTextContent(
      "Backend · WinDivert",
    );
  });

  it("renders detail sections collapsed by default and expands them on demand", async () => {
    render(<SocksCapPanel />);

    const upstreamToggle = await screen.findByTestId("sockscap-section-upstream-toggle");
    expect(upstreamToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("sockscap-upstream-kind")).not.toBeVisible();

    fireEvent.click(upstreamToggle);

    expect(upstreamToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("sockscap-upstream-kind")).toBeVisible();
    expect(screen.getByTestId("sockscap-domains-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a header warning icon for TUN conflicts and opens its detail dialog", async () => {
    vi.mocked(sockscapDetectTunConflicts).mockResolvedValueOnce(["OpenVPN Wintun"]);
    render(<SocksCapPanel />);

    const warning = await screen.findByTestId("sockscap-tun-warning");
    expect(within(screen.getByTestId("sockscap-header")).getByTestId("sockscap-tun-warning")).toBe(warning);
    expect(warning.getAttribute("title")).toContain("OpenVPN Wintun");

    fireEvent.click(warning);

    expect(await screen.findByTestId("sockscap-tun-warning-dialog")).toHaveTextContent("OpenVPN Wintun");
    fireEvent.click(screen.getByTestId("sockscap-tun-warning-close"));
    expect(screen.queryByTestId("sockscap-tun-warning-dialog")).not.toBeInTheDocument();
  });

  it("treats an unavailable browser TUN probe as no conflict", async () => {
    vi.mocked(sockscapDetectTunConflicts).mockResolvedValueOnce(undefined as unknown as string[]);
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-panel")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("sockscap-tun-warning")).not.toBeInTheDocument());
  });

  it("allows adding a new profile", async () => {
    render(<SocksCapPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("sockscap-add-profile")).toBeInTheDocument();
    });

    const addBtn = screen.getByTestId("sockscap-add-profile");
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(fixtureState.currentCfg.profiles.length).toBe(2);
      expect(fixtureState.currentCfg.profiles[1].name).toBe("方案 2");
    });
  });

  it("sorts profiles by priority and lets the user raise, lower, or edit it", async () => {
    const base = defaultTestCfg.profiles[0];
    fixtureState.currentCfg = {
      ...defaultTestCfg,
      activeProfileIds: ["default", "middle", "highest"],
      profiles: [
        { ...base, id: "default", name: "Default", priority: 10 },
        { ...base, id: "middle", name: "Middle", priority: 20 },
        { ...base, id: "highest", name: "Highest", priority: 0 },
      ],
    };
    render(<SocksCapPanel />);

    await screen.findByTestId("sockscap-profile-priority-input-default");
    const listedIds = () =>
      Array.from(
        screen
          .getByTestId("sockscap-profile-list")
          .querySelectorAll<HTMLElement>("[data-testid^='sockscap-profile-item-']"),
      ).map((element) => element.dataset.testid);

    expect(listedIds()).toEqual([
      "sockscap-profile-item-highest",
      "sockscap-profile-item-default",
      "sockscap-profile-item-middle",
    ]);
    expect(screen.getByTestId("sockscap-profile-priority-input-default")).toHaveAttribute(
      "title",
      expect.stringContaining("Smaller values have higher priority"),
    );

    const raiseDefault = screen.getByTestId("sockscap-profile-priority-up-default");
    expect(raiseDefault).not.toBeDisabled();
    fireEvent.click(raiseDefault);
    await waitFor(() => {
      expect(fixtureState.currentCfg.profiles.find((p) => p.id === "default")?.priority).toBe(0);
      expect(listedIds().slice(0, 2)).toEqual([
        "sockscap-profile-item-default",
        "sockscap-profile-item-highest",
      ]);
    });

    fireEvent.change(screen.getByTestId("sockscap-profile-priority-input-middle"), {
      target: { value: "-5" },
    });
    await waitFor(() => {
      expect(fixtureState.currentCfg.profiles.find((p) => p.id === "middle")?.priority).toBe(-5);
      expect(listedIds()[0]).toBe("sockscap-profile-item-middle");
    });

    fireEvent.click(screen.getByTestId("sockscap-profile-priority-down-middle"));
    await waitFor(() => {
      expect(listedIds().slice(0, 2)).toEqual([
        "sockscap-profile-item-default",
        "sockscap-profile-item-middle",
      ]);
    });
  });

  it("offers only SSH and Proxy sessions as upstream sources", async () => {
    const mkSession = (
      id: string,
      name: string,
      session_type: string,
    ): SessionConfig => ({
      id,
      name,
      session_type,
      group_path: null,
      host: `${id}.example.com`,
      port: 1080,
      username: null,
      auth_method: "Password" as SessionConfig["auth_method"],
      options_json: "",
      created_at: 0,
      updated_at: 0,
      last_connected_at: null,
      sort_order: 0,
    });
    vi.mocked(listSessions).mockResolvedValueOnce([
      mkSession("s1", "Bastion SSH", "SSH"),
      mkSession("p1", "Office Proxy", "Proxy"),
      mkSession("l1", "Local Shell", "LocalShell"),
      mkSession("f1", "Local Folder", "File"),
      mkSession("d1", "Prod DB", "MySQL"),
      mkSession("r1", "Desktop", "RDP"),
    ]);

    render(<SocksCapPanel />);
    const trigger = await screen.findByTestId("sockscap-upstream-source");
    fireEvent.click(trigger);

    const menu = await screen.findByTestId("sockscap-upstream-source-menu");
    // The default upstream kind is socks5 → proxy mode, so proxy sessions show.
    expect(within(menu).getByText("Office Proxy")).toBeInTheDocument();
    // Non-proxy / non-SSH sessions must never appear.
    expect(within(menu).queryByText("Local Shell")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Local Folder")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Prod DB")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Desktop")).not.toBeInTheDocument();
    // SSH sessions are excluded from proxy mode too (only surface in ssh mode).
    expect(within(menu).queryByText("Bastion SSH")).not.toBeInTheDocument();
  });

  it("reveals core-upstream fields (share link + cipher) when selecting Shadowsocks", async () => {
    render(<SocksCapPanel />);
    fireEvent.click(await screen.findByTestId("sockscap-section-upstream-toggle"));
    const kindSelect = await screen.findByTestId("sockscap-upstream-kind");

    fireEvent.change(kindSelect, { target: { value: "shadowsocks" } });

    await waitFor(() => {
      expect(fixtureState.currentCfg.profiles[0].upstream.kind).toBe("shadowsocks");
    });
    // Share-link import field + the SS cipher select are now shown.
    expect(await screen.findByTestId("sockscap-sharelink-input")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "chacha20-ietf-poly1305" }),
      ).toBeInTheDocument();
    });
  });

  it("imports a VLESS share link, vaulting uuid and populating params", async () => {
    vi.mocked(sockscapParseShareLink).mockResolvedValue({
      kindTag: "vless",
      name: "My VLESS",
      host: "node.example.com",
      port: 443,
      params: {
        flow: "xtls-rprx-vision",
        tls: "reality",
        realityPublicKey: "PUBKEY",
        network: "tcp",
        encryption: "none",
      },
      secret: "",
      uuid: "11111111-2222-3333-4444-555555555555",
    });

    render(<SocksCapPanel />);
    const kindSelect = await screen.findByTestId("sockscap-upstream-kind");
    fireEvent.change(kindSelect, { target: { value: "vless" } });

    const input = await screen.findByTestId("sockscap-sharelink-input");
    fireEvent.change(input, {
      target: { value: "vless://uuid@node.example.com:443?security=reality#My VLESS" },
    });
    fireEvent.click(screen.getByTestId("sockscap-sharelink-import"));

    await waitFor(() => {
      const up = fixtureState.currentCfg.profiles[0].upstream;
      expect(up.kind).toBe("vless");
      expect(up.host).toBe("node.example.com");
      expect(up.port).toBe(443);
      // uuid was vaulted into params.uuidRef (never stored plaintext).
      expect(up.params?.uuidRef).toBe("vault:test-ref");
      expect(up.params?.flow).toBe("xtls-rprx-vision");
      expect(up.params?.realityPublicKey).toBe("PUBKEY");
    });
    // The uuid was sent to the vault, not written to config plaintext.
    expect(vi.mocked(vaultPut)).toHaveBeenCalled();
    expect(vi.mocked(vaultStatus)).toHaveBeenCalled();
  });

  it("imports a subscription into one profile per node, vaulting secrets", async () => {
    vi.mocked(sockscapImportSubscription).mockResolvedValue([
      {
        kindTag: "trojan",
        name: "Node A",
        host: "a.example.com",
        port: 443,
        params: { tls: "tls" },
        secret: "pwA",
        uuid: "",
      },
      {
        kindTag: "vless",
        name: "Node B",
        host: "b.example.com",
        port: 443,
        params: { flow: "xtls-rprx-vision" },
        secret: "",
        uuid: "uuid-b",
      },
    ]);

    render(<SocksCapPanel />);
    await waitFor(() => expect(screen.getByTestId("sockscap-panel")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("sockscap-sub-import-toggle"));
    const input = await screen.findByTestId("sockscap-sub-input");
    fireEvent.change(input, { target: { value: "https://sub.example.com/link" } });
    fireEvent.click(screen.getByTestId("sockscap-sub-import"));

    await waitFor(() => {
      // Two profiles added beyond the default.
      const names = fixtureState.currentCfg.profiles.map((p) => p.name);
      expect(names).toContain("Node A");
      expect(names).toContain("Node B");
    });
    const a = fixtureState.currentCfg.profiles.find((p) => p.name === "Node A")!;
    const b = fixtureState.currentCfg.profiles.find((p) => p.name === "Node B")!;
    expect(a.upstream.kind).toBe("trojan");
    expect(a.upstream.host).toBe("a.example.com");
    expect(a.upstream.passwordRef).toBe("vault:test-ref"); // secret vaulted
    expect(b.upstream.kind).toBe("vless");
    expect(b.upstream.params?.uuidRef).toBe("vault:test-ref"); // uuid vaulted
    expect(b.upstream.params?.flow).toBe("xtls-rprx-vision");
    // Imported profiles are not auto-activated.
    expect(fixtureState.currentCfg.activeProfileIds).not.toContain(a.id);
  });

  it("locks every profile and routing-rule mutation while running", async () => {
    // Report the engine as Active so the panel enters the locked state.
    vi.mocked(sockscapStatus).mockResolvedValue({
      phase: "active",
      message: "active",
      ruleCount: 0,
      captureBackend: "test",
    });
    render(<SocksCapPanel />);

    await waitFor(() =>
      expect(screen.getByTestId("sockscap-locked-banner")).toBeInTheDocument(),
    );
    expect(within(screen.getByTestId("sockscap-header")).getByTestId("sockscap-locked-banner")).toBeInTheDocument();
    // Capture topology and profile controls are disabled.
    expect(screen.getByTestId("sockscap-upstream-kind")).toBeDisabled();
    expect(screen.getByTestId("sockscap-mode-global")).toBeDisabled();
    expect(screen.getByTestId("sockscap-upstream-source")).toBeDisabled();
    expect(screen.getByTestId("sockscap-profile-checkbox-default")).toBeDisabled();
    expect(screen.getByTestId("sockscap-profile-priority-input-default")).toBeDisabled();
    expect(screen.getByTestId("sockscap-add-profile")).toBeDisabled();

    // Policy and shared routing-rule mutations are disabled as well.
    fireEvent.click(screen.getByTestId("sockscap-section-rules-toggle"));
    expect(await screen.findByTestId("sockscap-rules-editor")).toBeDisabled();
    fireEvent.click(screen.getByTestId("sockscap-section-gfwlist-toggle"));
    expect(await screen.findByTestId("sockscap-refresh-gfw")).toBeDisabled();
    expect(screen.getByTestId("sockscap-import-gfw")).toBeDisabled();
    expect(screen.getByTestId("sockscap-block-quic")).toBeDisabled();
  });

  it("shows a copyable detail modal after testing the upstream", async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeMock } });
    render(<SocksCapPanel />);

    // Shadowsocks routes the test through the mocked core-upstream tester.
    const kindSelect = await screen.findByTestId("sockscap-upstream-kind");
    fireEvent.change(kindSelect, { target: { value: "shadowsocks" } });

    fireEvent.click(await screen.findByTestId("sockscap-test-upstream"));

    const body = await screen.findByTestId("sockscap-test-detail-body");
    expect(body).toHaveTextContent("ok");

    fireEvent.click(screen.getByTestId("sockscap-test-detail-copy"));
    await waitFor(() => expect(writeMock).toHaveBeenCalledWith("ok"));
  });

  it("shows the no-proxy help block when no local proxy is detected", async () => {
    render(<SocksCapPanel />);
    // Default upstream is socks5 with no detected proxies and no session.
    expect(await screen.findByTestId("sockscap-noproxy-help")).toBeInTheDocument();
  });

  it("uses launch-only mode without asking for sudo when transparent Linux capture is unavailable", async () => {
    fixtureState.currentPlatform = "linux";
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-rootless-mode")).toHaveTextContent(
      "Application capture without administrator access",
    );
    expect(screen.getByTestId("sockscap-launch-only-banner")).toHaveTextContent(
      "No-permission application capture",
    );
    expect(screen.queryByTestId("sockscap-start")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-profile-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("sockscap-pick-linux-application")).toHaveTextContent("Browse");
    expect(screen.getByTestId("sockscap-rootless-command")).toBeVisible();
    expect(screen.getByTestId("sockscap-rootless-arguments")).toBeVisible();
    expect(screen.getByTestId("sockscap-rootless-launch-mode")).toHaveValue("desktop");
    expect(screen.queryByTestId("sockscap-rootless-profile-current")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-rootless-profile")).not.toBeInTheDocument();
    expect(screen.getByTestId("sockscap-section-upstream-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("sockscap-section-rules-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("sockscap-section-gfwlist-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("sockscap-upstream-kind")).toBeVisible();
    expect(screen.getByTestId("sockscap-rules-editor")).toBeVisible();
    expect(screen.getByTestId("sockscap-refresh-gfw")).toBeVisible();

    fireEvent.change(screen.getByTestId("sockscap-upstream-kind"), {
      target: { value: "http" },
    });
    await waitFor(() => expect(fixtureState.currentCfg.profiles[0].upstream.kind).toBe("http"));
    fireEvent.change(
      within(screen.getByTestId("sockscap-rules-editor")).getByDisplayValue("GFWList"),
      { target: { value: "proxyAll" } },
    );
    await waitFor(() => expect(fixtureState.currentCfg.profiles[0].ruleMode).toBe("proxyAll"));

    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sockscap-root-prompt-dialog")).not.toBeInTheDocument();
  });

  it("prompts for sudo before starting Linux transparent capture", async () => {
    fixtureState.currentPlatform = "linux";
    fixtureState.linuxTransparentRequiresElevation = true;
    render(<SocksCapPanel />);

    fireEvent.click(await screen.findByTestId("sockscap-start"));

    const prompt = await screen.findByTestId("sockscap-root-prompt-dialog");
    expect(prompt).toHaveTextContent("Root Authorization Required");
    expect(vi.mocked(sockscapStart)).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("sockscap-root-password-input"), {
      target: { value: "sudo-secret" },
    });
    fireEvent.click(screen.getByTestId("sockscap-root-prompt-submit"));

    await waitFor(() => {
      expect(vi.mocked(sockscapStart)).toHaveBeenCalledOnce();
      expect(vi.mocked(sockscapStart)).toHaveBeenCalledWith("sudo-secret");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("sockscap-root-prompt-dialog")).not.toBeInTheDocument();
    });
  });

  it("launches and stops a configured Linux application from the launch-only UI", async () => {
    fixtureState.currentPlatform = "linux";
    fixtureState.currentCfg.profiles[0].apps = [
      { path: "/usr/bin/example-app", name: "Example App" },
    ];
    fixtureState.currentCfg.apps = fixtureState.currentCfg.profiles[0].apps;
    render(<SocksCapPanel />);

    const launch = await screen.findByTestId("sockscap-launch-app-0");
    expect(launch).toBeEnabled();
    expect(launch).toHaveTextContent("Start and capture");
    fireEvent.click(launch);

    await waitFor(() => expect(vi.mocked(sockscapStart)).toHaveBeenCalledWith(undefined));
    await waitFor(() =>
      expect(vi.mocked(sockscapLaunchApp)).toHaveBeenCalledWith(
        "default",
        "/usr/bin/example-app",
        [],
        {},
      ),
    );
    expect(await screen.findByText("Running · PID 4242")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sockscap-stop-launched-app-4242"));
    await waitFor(() =>
      expect(vi.mocked(sockscapStopLaunchedApp)).toHaveBeenCalledWith(4242),
    );
    expect(vi.mocked(sockscapStop)).toHaveBeenCalledTimes(1);
  });

  it("keeps profiles implicit in rootless mode even when legacy config contains several", async () => {
    fixtureState.currentPlatform = "linux";
    fixtureState.currentCfg.profiles.push({
      ...JSON.parse(JSON.stringify(fixtureState.currentCfg.profiles[0])),
      id: "alternate",
      name: "备用方案",
      priority: 1,
    });
    render(<SocksCapPanel />);

    expect(await screen.findByTestId("sockscap-rootless-mode")).toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-rootless-profile")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sockscap-rootless-profile-current")).not.toBeInTheDocument();
    expect(fixtureState.currentCfg.selectedProfileId).toBe("default");
  });
}
