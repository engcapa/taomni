import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceActionHost } from "./workspaceActionHost";
import { setKeymapPlatformOverride } from "./workspaceKeymapPlatform";

afterEach(() => {
  setKeymapPlatformOverride(null);
  vi.restoreAllMocks();
});

describe("workspace action snapshot binding environment", () => {
  it("reads the platform once for a catalog while retaining live platform changes", () => {
    setKeymapPlatformOverride(null);
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Public Linux browser");
    const host = new WorkspaceActionHost({ workspaceId: "snapshot-bindings" });
    host.registerActions(Array.from({ length: 120 }, (_, index) => ({
      id: `public.action.${index}`,
      title: `Public action ${index}`,
      category: "File",
      keybinding: { default: "Ctrl+S", macos: "Meta+S" },
      provenance: "local" as const,
      run: () => ({ kind: "applied" as const }),
    })));

    const linux = host.getSnapshot();
    expect(linux).toHaveLength(120);
    expect(linux.every((item) => item.keybinding === "Ctrl+S")).toBe(true);
    expect(platform.mock.calls.length + agent.mock.calls.length).toBeLessThanOrEqual(12);

    platform.mockReturnValue("MacIntel");
    agent.mockReturnValue("Public Macintosh browser");
    platform.mockClear();
    agent.mockClear();
    const mac = host.getSnapshot();
    expect(mac.every((item) => item.keybinding === "Cmd+S")).toBe(true);
    expect(mac.every((item) => item.baseShortcuts?.[0]?.kind === "keyboard")).toBe(true);
    expect(platform.mock.calls.length + agent.mock.calls.length).toBeLessThanOrEqual(12);
    host.dispose();
  });
});
