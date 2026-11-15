import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { type ModuleRecord } from "../../lib/moduleStore";
import { useModuleStore } from "../../stores/moduleStore";
import { ModuleStorePanel, type ModuleStoreCatalogEntry } from "./ModuleStorePanel";

const entry: ModuleStoreCatalogEntry = {
  slug: "database-tools",
  name: "Database Tools",
  description: "Additional database tooling.",
  version: "2.0.0",
  coreApiVersion: "1",
  sizeBytes: 1_500_000,
  permissions: ["network", "filesystem"],
};

function record(overrides: Partial<ModuleRecord> = {}): ModuleRecord {
  return {
    slug: entry.slug,
    version: entry.version,
    activeVersion: entry.version,
    lifecycle: "installed",
    dataRetained: true,
    ...overrides,
  };
}

describe("ModuleStorePanel", () => {
  beforeEach(() => {
    setLocale("en");
    useModuleStore.getState().hydrate([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setLocale("en");
  });

  it("shows an empty catalog state", () => {
    render(<ModuleStorePanel />);

    expect(screen.getByTestId("module-store-panel")).toBeInTheDocument();
    expect(screen.getByTestId("module-store-empty")).toHaveTextContent("No modules are available yet.");
    expect(screen.getByTestId("module-store-core-api")).toHaveTextContent("Core API 1");
  });

  it("renders catalog metadata and an enabled module state", () => {
    useModuleStore.getState().hydrate([record({ lifecycle: "enabled" })]);
    render(<ModuleStorePanel catalog={[entry]} />);

    expect(screen.getByTestId("module-card-database-tools")).toHaveTextContent("Database Tools");
    expect(screen.getByTestId("module-status-database-tools")).toHaveTextContent("Enabled");
    expect(screen.getByTestId("module-version-database-tools")).toHaveTextContent("Version 2.0.0");
    expect(screen.getByTestId("module-permissions-database-tools")).toHaveTextContent("network, filesystem");
    expect(screen.getByText("1.5 MB")).toBeInTheDocument();
    expect(screen.getByTestId("module-action-disable-database-tools")).toBeInTheDocument();
  });

  it("runs install, enable, and disable actions through the lifecycle store", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    const onEnable = vi.fn();
    const onDisable = vi.fn();
    render(<ModuleStorePanel catalog={[entry]} onInstall={onInstall} onEnable={onEnable} onDisable={onDisable} />);

    await user.click(screen.getByTestId("module-action-install-database-tools"));
    await waitFor(() => expect(onInstall).toHaveBeenCalledWith(entry));
    expect(useModuleStore.getState().records[entry.slug]).toMatchObject({ lifecycle: "installed", version: entry.version });

    await user.click(screen.getByTestId("module-action-enable-database-tools"));
    await waitFor(() => expect(onEnable).toHaveBeenCalledWith(entry));
    expect(useModuleStore.getState().records[entry.slug].lifecycle).toBe("enabled");

    await user.click(screen.getByTestId("module-action-disable-database-tools"));
    await waitFor(() => expect(onDisable).toHaveBeenCalledWith(entry));
    expect(useModuleStore.getState().records[entry.slug].lifecycle).toBe("disabled");
  });

  it("requires uninstall confirmation and passes the explicit data deletion choice", async () => {
    const user = userEvent.setup();
    useModuleStore.getState().hydrate([record({ lifecycle: "enabled" })]);
    const onUninstall = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = render(<ModuleStorePanel catalog={[entry]} onUninstall={onUninstall} />);

    await user.click(screen.getByTestId("module-action-uninstall-database-tools"));
    expect(confirm).toHaveBeenCalledOnce();
    expect(onUninstall).not.toHaveBeenCalled();
    expect(useModuleStore.getState().records[entry.slug].lifecycle).toBe("enabled");

    confirm.mockReturnValue(true);
    await user.click(screen.getByTestId("module-action-uninstall-database-tools"));
    await waitFor(() => expect(onUninstall).toHaveBeenCalledWith(entry, false));
    expect(useModuleStore.getState().records[entry.slug]).toMatchObject({ lifecycle: "uninstalled", dataRetained: true });

    view.unmount();
    useModuleStore.getState().hydrate([record({ lifecycle: "enabled" })]);
    const secondUninstall = vi.fn();
    render(<ModuleStorePanel catalog={[entry]} onUninstall={secondUninstall} />);
    const checkbox = screen.getByTestId("module-delete-data-database-tools");
    await user.click(checkbox);
    await user.click(screen.getByTestId("module-action-uninstall-database-tools"));
    await waitFor(() => expect(secondUninstall).toHaveBeenCalledWith(entry, true));
    expect(useModuleStore.getState().records[entry.slug].dataRetained).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("rolls back to the previous version and restores a usable lifecycle", async () => {
    const user = userEvent.setup();
    useModuleStore.getState().hydrate([record({ previousVersion: "1.0.0", lifecycle: "enabled" })]);
    const onRollback = vi.fn();
    render(<ModuleStorePanel catalog={[entry]} onRollback={onRollback} />);

    await user.click(screen.getByTestId("module-action-rollback-database-tools"));
    await waitFor(() => expect(onRollback).toHaveBeenCalledWith(entry, "1.0.0"));
    await waitFor(() => expect(useModuleStore.getState().records[entry.slug]).toMatchObject({
      version: "1.0.0",
      activeVersion: "1.0.0",
      lifecycle: "disabled",
      previousVersion: entry.version,
    }));
    // Catalog metadata describes the available artifact; lifecycle state in the
    // store carries the active rollback version independently.
    expect(screen.getByTestId("module-version-database-tools")).toHaveTextContent("Version 2.0.0");
  });

  it("surfaces callback failures and retains the failed module record", async () => {
    const user = userEvent.setup();
    useModuleStore.getState().hydrate([record({ lifecycle: "installed" })]);
    const onEnable = vi.fn().mockRejectedValue(new Error("native enable failed"));
    render(<ModuleStorePanel catalog={[entry]} onEnable={onEnable} />);

    await user.click(screen.getByTestId("module-action-enable-database-tools"));
    expect(await screen.findByRole("alert")).toHaveTextContent("native enable failed");
    expect(useModuleStore.getState().records[entry.slug]).toMatchObject({ lifecycle: "installed", error: "native enable failed" });
  });
});
