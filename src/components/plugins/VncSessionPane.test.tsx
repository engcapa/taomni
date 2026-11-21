import { Suspense, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalPluginRegistryChanged } from "../../lib/pluginRegistryEvents";
import type { PluginManifest, PluginRecord } from "../../lib/pluginRegistry";
import { clearPendingSettingsSection, consumePendingSettingsSection } from "../../lib/settingsNavigation";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import vncManifest from "../../../src-tauri/plugins/vnc-client/module.json";
import VncSessionPane from "./VncSessionPane";

const mocks = vi.hoisted(() => ({ list: vi.fn(), closeViewer: vi.fn(), loadFrontend: vi.fn() }));
vi.mock("../../lib/ipc/plugin", () => ({ listPlugins: mocks.list }));
vi.mock("../../lib/pluginLoader", () => ({ loadPluginFrontend: mocks.loadFrontend }));
vi.mock("../../../src-tauri/plugins/vnc-client/renderer/VncPanel", () => ({
  default: ({ host }: { host: string }) => {
    useEffect(() => mocks.closeViewer, []);
    return <div data-testid="vnc-panel">{host}</div>;
  },
}));

const manifest = vncManifest as PluginManifest;
const slug = manifest.slug;

async function setLifecycle(lifecycle: PluginRecord["lifecycle"], version = manifest.version) {
  mocks.list.mockResolvedValue([{ slug, lifecycle, manifest: { ...manifest, version } }]);
  act(() => signalPluginRegistryChanged(slug));
  await waitFor(() => expect(usePluginFrontendStore.getState().records[slug]?.lifecycle).toBe(lifecycle));
}

beforeEach(() => {
  usePluginFrontendStore.setState({ records: {}, epochs: {}, pending: new Set(), status: "idle", error: null });
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.closeViewer.mockClear();
  mocks.loadFrontend.mockReset().mockImplementation(() => import("../../../src-tauri/plugins/vnc-client/renderer/VncPanel"));
});
afterEach(() => {
  cleanup();
  clearPendingSettingsSection();
});

describe("a saved VNC session's module lifecycle", () => {
  it("preserves the legacy viewer until installation and unmounts it on disable or version change", async () => {
    render(<Suspense><VncSessionPane tabId="saved" host="vnc.test" port={5900} visible /></Suspense>);
    expect(await screen.findByTestId("vnc-panel")).toHaveTextContent("vnc.test");
    await setLifecycle("installed");
    expect(screen.getByTestId("plugin-tab-unavailable")).toHaveAttribute("data-reason", "disabled");
    expect(screen.queryByTestId("vnc-panel")).toBeNull();
    expect(mocks.closeViewer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("plugin-tab-settings"));
    expect(consumePendingSettingsSection()?.id).toBe("module-store");

    await setLifecycle("enabled");
    expect(await screen.findByTestId("vnc-panel")).toHaveTextContent("vnc.test");
    expect(mocks.loadFrontend).toHaveBeenCalledWith(manifest, undefined, expect.any(String));
    await setLifecycle("enabled", "0.2.0");
    await waitFor(() => expect(mocks.closeViewer).toHaveBeenCalledTimes(2));
    await screen.findByTestId("vnc-panel");

    await setLifecycle("uninstalled");
    expect(screen.getByTestId("plugin-tab-unavailable")).toHaveAttribute("data-reason", "missing");
    expect(mocks.closeViewer).toHaveBeenCalledTimes(3);
  });

  it("keeps the return action available in a disabled detached session", async () => {
    mocks.list.mockResolvedValue([{ slug, lifecycle: "disabled", manifest }]);
    const onReattach = vi.fn();
    render(<Suspense><VncSessionPane tabId="detached" host="vnc.test" port={5900} visible
      detachedWindowControls={{ onReattach, onToggleOsFullscreen: vi.fn(), osFullscreen: false }} /></Suspense>);
    expect(await screen.findByTestId("plugin-tab-unavailable")).toHaveAttribute("data-reason", "disabled");
    expect(screen.queryByTestId("vnc-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("detached-reattach"));
    expect(onReattach).toHaveBeenCalledTimes(1);
  });
});
