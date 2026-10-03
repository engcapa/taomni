import { describe, expect, it } from "vitest";
import { defaultShellLayout, loadShellLayout, SHELL_LAYOUT_KEY, validateShellLayout } from "./shellLayoutPersistence";

function storage(values: Record<string, string> = {}) {
  return { values, getItem: (k: string) => values[k] ?? null, setItem: (k: string, v: string) => { values[k] = v; }, removeItem: (k: string) => { delete values[k]; } };
}
describe("Shell layout compatibility", () => {
  it("migrates actual legacy keys once while preserving legacy data", () => {
    const s = storage({ "taomni.sidebarCollapsed": "false", "taomni.sidebarCollapsedByGroup.v1": JSON.stringify({ terminal: false, "code-workspace": true }),
      "taomni.resizable-panels.v4.main-layout": JSON.stringify({ sidebar: 25, content: 75 }),
      "taomni.chatDrawer.layout.v1": JSON.stringify({ position: "bottom", width: 470, height: 300, pinned: false, floatingOpacity: .8, ribbonOffsetRatio: .2 }) });
    const result = loadShellLayout(s, 1280);
    expect(result.layout.navigator).toMatchObject({ width: 307, collapsedByLane: { home: false, connect: false, build: true } });
    expect(result.layout.tao).toMatchObject({ edge: "bottom", width: 470, height: 300, pinned: false, opacity: .8, ribbonOffsetRatio: .2 });
    expect(s.values["taomni.chatDrawer.layout.v1"]).toBeTruthy();
    s.values["taomni.sidebarCollapsed"] = "true";
    expect(loadShellLayout(s, 1280).layout.navigator.collapsedByLane.home).toBe(false);
  });
  it("preserves an unknown version and supports unavailable storage", () => {
    const s = storage({ [SHELL_LAYOUT_KEY]: '{"version":99}' });
    expect(loadShellLayout(s, 800)).toMatchObject({ writable: false, warning: "version" });
    expect(s.values[SHELL_LAYOUT_KEY]).toBe('{"version":99}');
    expect(loadShellLayout({ ...s, getItem: () => { throw new Error("denied"); } }, 800).warning).toBe("read");
  });
  it("sanitizes workspace descriptors, strips credentials and keeps distinct instance refs", () => {
    const layout = defaultShellLayout();
    const workspace = { repoRoot: "/project", roots: [], password: "secret", name: "Project" };
    layout.restoreSources = { "workspace:w1": { kind: "workspace", workspaceInstanceId: "w1", workspace }, "workspace:w2": { kind: "workspace", workspaceInstanceId: "w2", workspace } };
    const validated = validateShellLayout({ ...layout, tao: { width: Infinity, opacity: 0, ribbonOffsetRatio: 9 } })!;
    expect(Object.keys(validated.restoreSources)).toHaveLength(2);
    expect(JSON.stringify(validated)).not.toContain("secret");
    expect(validated.tao).toMatchObject({ width: 360, opacity: .65, ribbonOffsetRatio: 1 });
  });
});
