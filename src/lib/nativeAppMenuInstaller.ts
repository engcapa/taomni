import type { AppMenuSpec, MenuActionId, MenuNodeSpec } from "./nativeAppMenuSpec";

type NativeMenuApi = typeof import("@tauri-apps/api/menu");
type NativeMenuItem = Awaited<ReturnType<NativeMenuApi["MenuItem"]["new"]>>
  | Awaited<ReturnType<NativeMenuApi["CheckMenuItem"]["new"]>>
  | Awaited<ReturnType<NativeMenuApi["PredefinedMenuItem"]["new"]>>
  | Awaited<ReturnType<NativeMenuApi["Submenu"]["new"]>>;
type NativeMenuResource = NativeMenuItem | Awaited<ReturnType<NativeMenuApi["Menu"]["new"]>>;
type Dispatch = (action: MenuActionId) => void;
type FlagSetter = (value: boolean) => Promise<void>;

interface InstalledMenu {
  shape: string;
  spec: string;
  valid: boolean;
  flags: Map<string, boolean>;
  setters: Map<string, FlagSetter>;
  resources: NativeMenuResource[];
  dispatch: { current: Dispatch };
}

let installationRevision = 0;
let installedRevision = 0;
let installed: InstalledMenu | null = null;
let installationQueue = Promise.resolve();
let apiPromise: Promise<NativeMenuApi> | undefined;

export function appMenuInstallationReady(): boolean {
  return installedRevision > 0 && installedRevision === installationRevision;
}

// A reload leaves AppKit holding the previous document's callbacks until the
// current document installs its own menu. Native tests wait for that boundary.
if (__TAOMNI_QA_UPDATER__) {
  (globalThis as typeof globalThis & {
    __TAOMNI_QA_APP_MENU__?: { ready: () => boolean; path: (action: MenuActionId) => number[] | null };
  }).__TAOMNI_QA_APP_MENU__ = {
    ready: appMenuInstallationReady,
    // Stable locator only. Tests still read/activate the actual AppKit item;
    // this cannot change a flag, dispatch an action or bypass its channel.
    path: (action) => {
      if (!installed || !appMenuInstallationReady()) return null;
      const spec: AppMenuSpec = JSON.parse(installed.spec);
      const visit = (nodes: MenuNodeSpec[], prefix: number[]): number[] | null => {
        for (const [index, node] of nodes.entries()) {
          const path = [...prefix, index];
          if ((node.type === "item" || node.type === "check") && node.action === action) return path;
          if (node.type === "submenu") {
            const found = visit(node.items, path);
            if (found) return found;
          }
        }
        return null;
      };
      for (const [index, submenu] of spec.submenus.entries()) {
        const found = visit(submenu.items, [index]);
        if (found) return found;
      }
      return null;
    },
  };
}

async function closeResources(resources: NativeMenuResource[]): Promise<void> {
  const results = await Promise.allSettled([...resources].reverse().map((resource) => resource.close()));
  for (const result of results) {
    if (result.status === "rejected") console.error("Failed to release native menu resource", result.reason);
  }
}

async function finishCreations<T>(creations: Promise<T>[]): Promise<T[]> {
  // Settle every sibling before cleanup, including resources created after a
  // failed sibling. No late native handle may escape the ownership ledger.
  const results = await Promise.allSettled(creations);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

function menuFlags(spec: AppMenuSpec): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  function collect(node: MenuNodeSpec) {
    if (node.type === "item" || node.type === "submenu") flags.set(`enabled:${node.id}`, node.enabled ?? true);
    if (node.type === "check") flags.set(`checked:${node.id}`, node.checked);
    if (node.type === "submenu") node.items.forEach(collect);
  }
  spec.submenus.forEach((submenu) => submenu.items.forEach(collect));
  return flags;
}

async function patchFlags(current: InstalledMenu, flags: Map<string, boolean>): Promise<void> {
  const changes = [...flags].filter(([key, value]) => current.flags.get(key) !== value);
  const apply = async (key: string, value: boolean) => {
    const setter = current.setters.get(key);
    if (!setter) throw new Error(`Missing native menu state owner: ${key}`);
    await setter(value);
  };
  const results = await Promise.allSettled(changes.map(([key, value]) => apply(key, value)));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    // Preserve the old menu and callbacks on failure. A failed rollback makes
    // its native flags uncertain, so the next update must replace the tree.
    current.valid = false;
    const rollback = await Promise.allSettled(changes.map(([key]) => apply(key, current.flags.get(key)!)));
    rollback.forEach((result) => {
      if (result.status === "rejected") console.error("Failed to restore native menu state", result.reason);
    });
    throw failure.reason;
  }
  current.flags = flags;
}

/** Own native menu resources and serialize replacements and flag updates.
 * Obsolete queued versions do no IPC. Existing channels survive state-only
 * changes; structural replacements retain the previous menu until installed. */
export function installAppMenu(spec: AppMenuSpec, dispatch: Dispatch): Promise<void> {
  const revision = ++installationRevision;
  const update = installationQueue.then(async () => {
    if (revision !== installationRevision) return;
    const serialized = JSON.stringify(spec);
    const shape = JSON.stringify(spec, (key, value: unknown) => (
      key === "enabled" || key === "checked" ? undefined : value
    ));
    const flags = menuFlags(spec);
    if (installed?.valid && installed.shape === shape && installed.spec !== serialized) {
      await patchFlags(installed, flags);
      installed.spec = serialized;
      installed.dispatch.current = dispatch;
      if (revision === installationRevision) installedRevision = revision;
      return;
    }

    const api = await (apiPromise ??= import("@tauri-apps/api/menu"));
    if (revision !== installationRevision) return;
    // Explicit handles keep nested items' JS channels alive on Tauri 2.12.
    const prefix = `app-menu-${crypto.randomUUID()}`;
    const resources: NativeMenuResource[] = [];
    const setters = new Map<string, FlagSetter>();
    const actionOwner = { current: dispatch };
    const own = <T extends NativeMenuResource>(resource: T): T => {
      resources.push(resource);
      return resource;
    };
    const materialize = async (node: MenuNodeSpec): Promise<NativeMenuItem> => {
      switch (node.type) {
        case "separator":
          return own(await api.PredefinedMenuItem.new({ item: "Separator" }));
        case "predefined":
          return own(await api.PredefinedMenuItem.new({ item: node.item, text: node.label }));
        case "item": {
          const item = own(await api.MenuItem.new({
            id: `${prefix}-${node.id}`, text: node.label, enabled: node.enabled ?? true,
            accelerator: node.accelerator, action: () => actionOwner.current(node.action),
          }));
          setters.set(`enabled:${node.id}`, (value) => item.setEnabled(value));
          return item;
        }
        case "check": {
          const item = own(await api.CheckMenuItem.new({
            id: `${prefix}-${node.id}`, text: node.label, checked: node.checked,
            action: () => actionOwner.current(node.action),
          }));
          setters.set(`checked:${node.id}`, (value) => item.setChecked(value));
          return item;
        }
        case "submenu": {
          const items = await finishCreations(node.items.map(materialize));
          const submenu = own(await api.Submenu.new({
            id: `${prefix}-${node.id}`, text: node.label, enabled: node.enabled ?? true, items,
          }));
          setters.set(`enabled:${node.id}`, (value) => submenu.setEnabled(value));
          return submenu;
        }
      }
    };
    try {
      const items = await finishCreations(spec.submenus.map(async (submenu) => {
        const children = await finishCreations(submenu.items.map(materialize));
        return own(await api.Submenu.new({ id: `${prefix}-${submenu.id}`, text: submenu.label, items: children }));
      }));
      const menu = own(await api.Menu.new({ items }));
      if (revision !== installationRevision) {
        await closeResources(resources);
        return;
      }
      const replaced = await menu.setAsAppMenu();
      const previous = installed;
      installed = { shape, spec: serialized, valid: true, flags, setters, resources, dispatch: actionOwner };
      // IDs are unique per installation: closing old handles cannot delete new
      // action channels. setAsAppMenu returns another handle to the old root.
      if (previous) await closeResources(previous.resources);
      if (replaced) await closeResources([replaced]);
      if (revision === installationRevision) installedRevision = revision;
    } catch (error) {
      await closeResources(resources);
      throw error;
    }
  });
  installationQueue = update.catch(() => {});
  return update;
}
