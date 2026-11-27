import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { useModuleMarketplaceStore } from "../../stores/moduleMarketplaceStore";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { ModuleReleaseNotice } from "./ModuleReleaseNotice";

const updateMocks = vi.hoisted(() => ({
  relaunchApp: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/updateService", () => updateMocks);

const originalMarket = useModuleMarketplaceStore.getState();
const originalPlugins = usePluginFrontendStore.getState();

describe("ModuleReleaseNotice", () => {
  beforeEach(() => {
    setLocale("en");
    vi.clearAllMocks();
    usePluginFrontendStore.setState({ ...originalPlugins, records: {} });
  });

  afterEach(() => {
    cleanup();
    useModuleMarketplaceStore.setState(originalMarket, true);
    usePluginFrontendStore.setState(originalPlugins, true);
  });

  it("offers an immediate restart button when a staged Mail upgrade waits for restart", () => {
    useModuleMarketplaceStore.setState({
      ...originalMarket,
      catalog: {
        platform: "linux-x86_64",
        catalog: { coreApiVersion: "1", sequence: 1, updatedAt: "2026-11-27", plugins: {} },
        release: {
          legacyWaiting: false,
          legacyPending: ["taomni-plugin-mail"],
          legacyRestartRequired: ["taomni-plugin-mail"],
          updates: [],
          newModules: [],
        },
      },
    });
    render(<ModuleReleaseNotice openSettings={vi.fn()} />);
    expect(screen.getByTestId("module-release-legacy")).toHaveTextContent("next time Taomni opens");
    fireEvent.click(screen.getByTestId("module-release-restart"));
    expect(updateMocks.relaunchApp).toHaveBeenCalledOnce();
  });
});
