import { beforeEach, describe, expect, it, vi } from "vitest";
import { appMenuInstallationReady, installAppMenu, type AppMenuSpec } from "./nativeAppMenu";

const native = vi.hoisted(() => ({
  channels: new Map<string, () => void>(),
  current: null as { items: Resource[] } | null,
  failInstall: false,
  closed: [] as string[],
}));

interface Resource {
  id: string;
  items: Resource[];
  close: () => Promise<void>;
  setAsAppMenu: () => Promise<void>;
}

vi.mock("@tauri-apps/api/menu", () => {
  let sequence = 0;
  const create = async (options: {
    id?: string; items?: Resource[]; action?: () => void;
  }): Promise<Resource> => {
    const id = options.id ?? `generated-${++sequence}`;
    if (options.action) native.channels.set(id, options.action);
    return {
      id,
      items: options.items ?? [],
      async close() {
        native.closed.push(id);
        native.channels.delete(id);
      },
      async setAsAppMenu(this: Resource) {
        if (native.failInstall) throw new Error("AppKit install failed");
        native.current = this;
      },
    };
  };
  return Object.fromEntries(["Menu", "Submenu", "MenuItem", "CheckMenuItem", "PredefinedMenuItem"]
    .map((kind) => [kind, { new: create }]));
});

const spec: AppMenuSpec = { submenus: [{ id: "app", label: "Taomni", items: [
  { type: "item", id: "about", label: "About Taomni", action: "help" },
  { type: "check", id: "quick", label: "Quick Connect", checked: true, action: "toggle-quick-connect" },
] }] };

function click(index: number) {
  const item = native.current!.items[0].items[index];
  const action = native.channels.get(item.id);
  expect(action, `installed native channel ${item.id}`).toBeTypeOf("function");
  action!();
}

describe("native menu action lifetime", () => {
  beforeEach(() => {
    native.failInstall = false;
    native.closed = [];
  });

  it("keeps About and check-item callbacks callable after installation", async () => {
    const dispatch = vi.fn();
    await installAppMenu(spec, dispatch);
    expect(appMenuInstallationReady()).toBe(true);
    click(0);
    click(1);
    expect(dispatch.mock.calls).toEqual([["help"], ["toggle-quick-connect"]]);
  });

  it("releases replaced resources without removing the new menu's callbacks", async () => {
    const oldDispatch = vi.fn();
    await installAppMenu(spec, oldDispatch);
    const previousId = native.current!.items[0].items[0].id;
    const dispatch = vi.fn();
    await installAppMenu(spec, dispatch);
    expect(native.closed).toContain(previousId);
    click(0);
    expect(dispatch).toHaveBeenCalledWith("help");
    expect(oldDispatch).not.toHaveBeenCalled();
  });

  it("preserves the installed menu when its replacement fails", async () => {
    const dispatch = vi.fn();
    await installAppMenu(spec, dispatch);
    const current = native.current;
    native.failInstall = true;
    await expect(installAppMenu(spec, vi.fn())).rejects.toThrow("AppKit install failed");
    expect(appMenuInstallationReady()).toBe(false);
    expect(native.current).toBe(current);
    click(0);
    expect(dispatch).toHaveBeenCalledWith("help");
  });

  it("marks a current-document replacement pending before asynchronous IPC finishes", async () => {
    await installAppMenu(spec, vi.fn());
    expect(appMenuInstallationReady()).toBe(true);
    const pending = installAppMenu(spec, vi.fn());
    expect(appMenuInstallationReady()).toBe(false);
    await pending;
    expect(appMenuInstallationReady()).toBe(true);
  });
});
