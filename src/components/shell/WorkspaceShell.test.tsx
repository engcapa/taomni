import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/appStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { defaultShellLayout } from "../../lib/shell/shellLayoutPersistence";
import { ShellFrame } from "./WorkspaceShell";
import { ShellSurfaceRegistry, StableSurface } from "./SurfaceSlot";

vi.mock("./GlobalRail", () => ({ GlobalRail: () => null }));

beforeEach(() => {
  const layout = defaultShellLayout();
  layout.tao = { ...layout.tao, edge: "top", pinned: false };
  useAppStore.setState({ tabs: [{ id: "welcome", title: "Home", type: "welcome", closable: false }], activeTabId: "welcome" });
  useShellLayoutStore.setState({ layout, taoOpen: true, panels: {}, laneSelection: null,
    overlay: null, overlayTarget: null, navigatorOverlay: false, transfersOpen: false,
    restoreRefByTab: {}, pinnedTabs: {}, laneOverrides: {}, mru: [], mruCycling: false, exiting: false });
});
afterEach(cleanup);

it("keeps empty-lane Home actionable when the retained terminal gains its restore identity", () => {
  useAppStore.setState({ tabs: [
    { id: "welcome", title: "Home", type: "welcome", closable: false },
    { id: "ssh-alpha", title: "Alpha", type: "terminal", closable: true },
  ], activeTabId: "ssh-alpha" });
  useShellLayoutStore.getState().visitTab("ssh-alpha");
  useShellLayoutStore.getState().selectLane("communicate");
  useShellLayoutStore.setState({ taoOpen: false });
  render(<ShellSurfaceRegistry>
    <ShellFrame navigator={null}><textarea aria-label="Retained terminal input" defaultValue="draft 中文" /></ShellFrame>
  </ShellSurfaceRegistry>);
  const retained = screen.getByLabelText("Retained terminal input");
  expect(screen.getByTestId("shell-work-area")).toHaveAttribute("inert");
  act(() => useShellLayoutStore.getState().bindRestoreSource("ssh-alpha", { kind: "run-entry", identity: "saved:alpha" }, 1, true));
  expect(screen.getByTestId("shell-lane-empty-home")).toBeInTheDocument();
  expect(screen.getByTestId("shell-work-area")).toHaveAttribute("inert");
  fireEvent.click(screen.getByTestId("shell-lane-empty-home"));
  expect(useAppStore.getState().activeTabId).toBe("welcome");
  expect(screen.queryByTestId("shell-lane-empty")).toBeNull();
  expect(screen.getByLabelText("Retained terminal input")).toBe(retained);
  expect(retained).toHaveValue("draft 中文");
});

it("keeps the moved Tao overlay interactive and dismisses it only from outside its current host", () => {
  render(<ShellSurfaceRegistry>
    <ShellFrame navigator={null}><div>Editor</div></ShellFrame>
    <StableSurface id="tao" slot="tao" visible>
      <button onClick={() => useShellLayoutStore.getState().updateLayout((layout) => ({
        ...layout, tao: { ...layout.tao, edge: "bottom" },
      }))}>Move to bottom</button>
      <input aria-label="Retained draft" defaultValue="draft 中文" />
    </StableSurface>
  </ShellSurfaceRegistry>);
  const draft = screen.getByRole("textbox", { name: "Retained draft" });
  fireEvent.click(screen.getByRole("button", { name: "Move to bottom" }));
  expect(useShellLayoutStore.getState().layout.tao.edge).toBe("bottom");
  expect(screen.getByRole("textbox", { name: "Retained draft" })).toBe(draft);
  fireEvent.pointerDown(draft);
  fireEvent.change(draft, { target: { value: "edited 中文" } });
  expect(useShellLayoutStore.getState().taoOpen).toBe(true);
  expect(draft).toHaveValue("edited 中文");
  fireEvent.pointerDown(document.body);
  expect(useShellLayoutStore.getState().taoOpen).toBe(false);
});

it.each([
  ["bottom", "right"],
  ["right", "bottom"],
] as const)("keeps an unpinned Host interactive after moving from %s to %s", (source, destination) => {
  useShellLayoutStore.setState({ taoOpen: false });
  useShellLayoutStore.getState().registerPanel({
    id: "files", kind: "sftp", owner: { kind: "tab", tabId: "welcome" },
    generation: 1, phase: "ready", requestedOpen: true, pinned: false,
    placement: { kind: "dock", edge: source }, operation: null, error: null,
  });
  render(<ShellSurfaceRegistry>
    <ShellFrame navigator={null}><div>Editor</div></ShellFrame>
    <StableSurface id="files" slot="panel:files" visible>
      <input aria-label="Files draft" defaultValue="retained 中文" />
    </StableSurface>
  </ShellSurfaceRegistry>);
  const draft = screen.getByRole("textbox", { name: "Files draft" });
  fireEvent.click(screen.getByTestId("shell-host-more"));
  fireEvent.click(screen.getByTestId(`shell-panel-move-${destination}`));
  expect(screen.getByTestId("shell-host")).toHaveAttribute("data-edge", destination);
  expect(screen.getByRole("textbox", { name: "Files draft" })).toBe(draft);
  fireEvent.pointerDown(draft);
  fireEvent.change(draft, { target: { value: "edited 中文" } });
  expect(useShellLayoutStore.getState().panels.files.requestedOpen).toBe(true);
  expect(draft).toHaveValue("edited 中文");
  const more = screen.getByTestId("shell-host-more");
  fireEvent.pointerDown(more);
  fireEvent.click(more);
  expect(screen.getByTestId(`shell-panel-move-${source}`)).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(useShellLayoutStore.getState().panels.files.requestedOpen).toBe(false);
});
