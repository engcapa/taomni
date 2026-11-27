import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import type { ModuleCatalogPlugin } from "../../lib/ipc/plugin";
import { useModuleDownloadStore } from "../../stores/moduleDownloadStore";
import { useModuleMarketplaceStore } from "../../stores/moduleMarketplaceStore";
import { useModuleStore } from "../../stores/moduleStore";
import { previewHelloManifest } from "../../stubs/modulePreview";
import { ModuleMarketplace } from "./ModuleMarketplace";

const updateMocks = vi.hoisted(() => ({
  relaunchApp: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/updateService", () => updateMocks);

const original = useModuleMarketplaceStore.getState();
const originalDownloads = useModuleDownloadStore.getState();
const entry: ModuleCatalogPlugin = { id: "taomni-plugin-hello-plugin", slug: "hello-plugin", name: "Hello Plugin",
  version: "0.1.0", coreApiVersion: "1", kind: "collaboration", permissions: ["capture.screen"], platforms: {
    "linux-x86_64": { url: "https://official.test/module", signature: "signed", sha256: "a".repeat(64), size: 1024 },
  } };
const download = vi.fn().mockResolvedValue(undefined);
const install = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  useModuleMarketplaceStore.setState({ ...original, catalog: { platform: "linux-x86_64", catalog: {
    coreApiVersion: "1", sequence: 42, updatedAt: "2026-11-16", plugins: { [entry.id]: entry },
  } }, refresh: vi.fn().mockResolvedValue(undefined), download, install });
  useModuleDownloadStore.setState({ tasks: [], refresh: vi.fn().mockResolvedValue(undefined) });
  useModuleStore.getState().hydrate([]);
});
afterEach(() => {
  cleanup();
  useModuleMarketplaceStore.setState(original, true);
  useModuleDownloadStore.setState(originalDownloads, true);
});

describe("official module catalog", () => {
  it("shows signed metadata and requires confirmation before downloading without marking installed", () => {
    render(<ModuleMarketplace />);
    expect(screen.getByTestId("module-marketplace-card")).toHaveTextContent("Collaboration");
    fireEvent.click(screen.getByTestId("module-marketplace-download"));
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("Capture your screen");
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("plugins/hello-plugin/data/");
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("module-marketplace-download"));
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    expect(download).toHaveBeenCalledWith({ pluginId: entry.id, version: entry.version, sha256: "a".repeat(64) }, undefined);
    expect(useModuleStore.getState().records).toEqual({});
  });

  it("filters modules and disables downloads without a native platform asset", () => {
    useModuleMarketplaceStore.setState((state) => ({ catalog: { ...state.catalog!, platform: "darwin-aarch64" } }));
    render(<ModuleMarketplace />);
    expect(screen.getByTestId("module-marketplace-download")).toBeDisabled();
    expect(screen.getByTestId("module-marketplace-unavailable")).toBeVisible();
    fireEvent.change(screen.getByTestId("module-marketplace-search"), { target: { value: "absent" } });
    expect(screen.queryByTestId("module-marketplace-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("module-marketplace-empty")).toBeVisible();
  });

  it("confirms actual verified permissions and native data directory before starting installation", () => {
    useModuleMarketplaceStore.setState({ review: { selection: { pluginId: entry.id, version: entry.version, sha256: "a".repeat(64) },
      detail: { manifest: { ...previewHelloManifest, permissions: ["vault.fixed-key"] }, dataDirectory: "/native/data/hello-plugin/data", downloadId: "native-id" } } });
    render(<ModuleMarketplace />);
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("protected encryption key");
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("/native/data/hello-plugin/data");
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    expect(install).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("shows a restart action when staged Mail is waiting for next launch instead of looping resume", () => {
    useModuleMarketplaceStore.setState((state) => ({
      catalog: {
        ...state.catalog!,
        release: {
          legacyWaiting: false,
          legacyPending: [entry.id],
          legacyRestartRequired: [entry.id],
          updates: [],
          newModules: [],
        },
      },
    }));
    render(<ModuleMarketplace />);
    expect(screen.queryByTestId("module-marketplace-provision")).not.toBeInTheDocument();
    const restart = screen.getByTestId("module-marketplace-restart");
    expect(restart).toHaveTextContent("Restart Taomni to finish");
    fireEvent.click(restart);
    expect(updateMocks.relaunchApp).toHaveBeenCalledOnce();
  });

  it("surfaces persisted Mail import error details and keeps Resume installation on failure", () => {
    const provision = vi.fn().mockResolvedValue(undefined);
    useModuleMarketplaceStore.setState((state) => ({
      provision,
      catalog: {
        ...state.catalog!,
        release: {
          legacyWaiting: false,
          legacyPending: [entry.id],
          legacyImportFailed: [entry.id],
          legacyImportErrors: { [entry.id]: "Timed out after 900s" },
          updates: [],
          newModules: [],
        },
      },
    }));
    render(<ModuleMarketplace />);
    const failed = screen.getByTestId("module-marketplace-mail-import-failed");
    expect(failed).toHaveTextContent("Mail import failed. Resume installation in Module Store.");
    expect(failed).toHaveTextContent("Timed out after 900s");
    fireEvent.click(screen.getByTestId("module-marketplace-provision"));
    expect(provision).toHaveBeenCalledWith(entry.id, true);
  });
});
