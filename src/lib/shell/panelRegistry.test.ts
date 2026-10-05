import { describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "./panelRegistry";

describe("PanelRegistry ownership", () => {
  it("does not unregister the replacement adapter when an old surface cleans up", () => {
    const registry = new PanelRegistry();
    const old = { id: "workspace:one:terminal", getInstance: () => undefined, actions: { open: vi.fn() } };
    const replacement = { id: old.id, getInstance: () => undefined, actions: { open: vi.fn() } };
    const removeOld = registry.register(old);
    const removeNew = registry.register(replacement);
    removeOld();
    registry.get(old.id)?.actions.open?.();
    expect(old.actions.open).not.toHaveBeenCalled();
    expect(replacement.actions.open).toHaveBeenCalledOnce();
    expect(registry.list()).toEqual([replacement]);
    removeNew(); removeNew();
    expect(registry.list()).toEqual([]);
  });
});
