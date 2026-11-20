import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installShellHarness, mountShell, pointer, row, rows, selection } from "./tests/explorerShellHarness";
import { getExplorerPreferences, setExplorerPreferences, EXPLORER_PREFERENCES_KEY } from "./explorerPreferences";
import { DEFAULT_EXPLORER_WIDTHS, explorerColumnLayout, fitExplorerColumn, readExplorerColumns, type ExplorerColumn } from "./explorerColumns";

installShellHarness();
const label = (_zh: string, en: string) => en;
const handle = (key: ExplorerColumn) => screen.getByTestId(`explorer-column-resize-${key}`);
function measure(key: ExplorerColumn, initial = DEFAULT_EXPLORER_WIDTHS[key]) {
  const element = handle(key).parentElement!;
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: initial,
    width: getExplorerPreferences().columnWidths[key] ?? initial, height: 26, bottom: 26, toJSON: () => ({}) }));
}

describe("Explorer detail columns", () => {
  it("resizes one column without sorting, changing selection or persisting every pointer move", async () => {
    await mountShell(); measure("mtime");
    fireEvent.click(row("alpha.txt"));
    const original = rows();
    pointer(handle("mtime"), "pointerdown", { button: 0, clientX: 200 });
    pointer(window, "pointermove", { clientX: 280 });
    expect(screen.getByTestId("explorer-files").style.getPropertyValue("--ex-columns")).toContain("220px");
    expect(getExplorerPreferences().columnWidths.mtime).toBeUndefined();
    pointer(window, "pointerup", { clientX: 280 });
    expect(getExplorerPreferences().columnWidths).toEqual({ mtime: 220 });
    expect(JSON.parse(localStorage.getItem(EXPLORER_PREFERENCES_KEY)!).columnWidths).toEqual({ mtime: 220 });
    expect(selection()).toEqual(["/fixture/alpha.txt"]);
    expect(rows()).toEqual(original);
    expect(getExplorerPreferences().sortKey).toBe("name");
    expect(getExplorerPreferences().sortDir).toBe("asc");
  });

  it("ignores other pointers and clamps tiny and oversized widths", async () => {
    await mountShell(); measure("size");
    pointer(handle("size"), "pointerdown", { button: 0, pointerId: 3, clientX: 200 });
    pointer(window, "pointermove", { pointerId: 4, clientX: 800 });
    pointer(window, "pointerup", { pointerId: 4 });
    expect(getExplorerPreferences().columnWidths.size).toBeUndefined();
    pointer(window, "pointermove", { pointerId: 3, clientX: -100 });
    pointer(window, "pointerup", { pointerId: 3 });
    expect(getExplorerPreferences().columnWidths.size).toBe(64);
    pointer(handle("size"), "pointerdown", { button: 0, clientX: 0 });
    pointer(window, "pointermove", { clientX: 10000 });
    pointer(window, "pointerup", {});
    expect(getExplorerPreferences().columnWidths.size).toBe(2048);
  });

  it("reverts cancelled drags and ends a drag when the window loses focus", async () => {
    await mountShell(); measure("type");
    pointer(handle("type"), "pointerdown", { button: 0, clientX: 100 });
    pointer(window, "pointermove", { clientX: 200 });
    pointer(window, "pointercancel", {});
    expect(getExplorerPreferences().columnWidths.type).toBeUndefined();
    expect(handle("type")).toHaveAttribute("aria-valuenow", "96");
    pointer(handle("type"), "pointerdown", { button: 0, clientX: 100 });
    pointer(window, "pointermove", { clientX: 200 });
    fireEvent(window, new Event("blur"));
    expect(getExplorerPreferences().columnWidths.type).toBe(196);
    pointer(window, "pointermove", { clientX: 900 });
    expect(getExplorerPreferences().columnWidths.type).toBe(196);
  });

  it("cleans up active pointer listeners on mode change and unmount", async () => {
    const view = await mountShell(); measure("name");
    pointer(handle("name"), "pointerdown", { button: 0, clientX: 100 });
    pointer(window, "pointermove", { clientX: 200 });
    act(() => setExplorerPreferences({ view: "icons" }));
    pointer(window, "pointerup", {});
    expect(getExplorerPreferences().columnWidths.name).toBeUndefined();
    act(() => setExplorerPreferences({ view: "details" })); measure("name");
    pointer(handle("name"), "pointerdown", { button: 0, clientX: 100 });
    view.unmount();
    pointer(window, "pointermove", { clientX: 500 }); pointer(window, "pointerup", {});
    expect(getExplorerPreferences().columnWidths.name).toBeUndefined();
  });

  it("fits contents on double click without toggling sort", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText: (text: string) => ({ width: text.length * 12 }) } as CanvasRenderingContext2D);
    await mountShell();
    fireEvent.doubleClick(handle("name"));
    expect(getExplorerPreferences().columnWidths.name).toBe(156);
    expect(getExplorerPreferences().sortDir).toBe("asc");
    expect(getExplorerPreferences().sortKey).toBe("name");
    expect(rows()).toEqual(["folder", "alpha.txt", "beta.md", "gamma.csv"]);
  });

  it("supports focused separator keys while retaining file selection and ordinary header sorting", async () => {
    const { list } = await mountShell(); measure("mtime");
    fireEvent.click(row("beta.md"));
    fireEvent.keyDown(handle("mtime"), { key: "ArrowRight" });
    expect(getExplorerPreferences().columnWidths.mtime).toBe(150);
    fireEvent.keyDown(handle("mtime"), { key: "ArrowLeft", shiftKey: true });
    expect(getExplorerPreferences().columnWidths.mtime).toBe(100);
    fireEvent.keyDown(handle("mtime"), { key: "Home" });
    expect(getExplorerPreferences().columnWidths.mtime).toBeUndefined();
    fireEvent.keyDown(handle("mtime"), { key: "ArrowRight", isComposing: true });
    fireEvent.keyDown(handle("mtime"), { key: "ArrowRight", metaKey: true });
    expect(getExplorerPreferences().columnWidths.mtime).toBeUndefined();
    expect(selection()).toEqual(["/fixture/beta.md"]);
    fireEvent.click(screen.getByTestId("explorer-column-size"));
    expect(getExplorerPreferences().sortKey).toBe("size");
    fireEvent.keyDown(list, { key: "Home" });
    expect(selection()).toEqual(["/fixture/folder"]);
  });

  it("restores widths on remount and keeps resizing usable when persistence fails", async () => {
    const first = await mountShell(); measure("type");
    pointer(handle("type"), "pointerdown", { button: 0, clientX: 50 });
    pointer(window, "pointermove", { clientX: 100 }); pointer(window, "pointerup", {});
    first.unmount();
    await mountShell(); measure("type");
    expect(handle("type")).toHaveAttribute("aria-valuenow", "146");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.keyDown(handle("type"), { key: "ArrowRight" });
    expect(getExplorerPreferences().columnWidths.type).toBe(156);
  });
});

describe("Explorer column persistence and fit model", () => {
  it("migrates old preferences and sanitizes corrupt or out-of-range columns", () => {
    expect(readExplorerColumns(undefined)).toEqual({});
    expect(readExplorerColumns([])).toEqual({});
    expect(readExplorerColumns({ name: "300", mtime: NaN, size: -9, type: 9999, injected: 20 })).toEqual({ size: 64, type: 2048 });
    localStorage.setItem(EXPLORER_PREFERENCES_KEY, JSON.stringify({ view: "details", columnWidths: { name: 400, size: -5 } }));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: EXPLORER_PREFERENCES_KEY })));
    expect(getExplorerPreferences().columnWidths).toEqual({ name: 400, size: 64 });
    localStorage.setItem(EXPLORER_PREFERENCES_KEY, JSON.stringify({ view: "details" }));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: EXPLORER_PREFERENCES_KEY })));
    expect(getExplorerPreferences().columnWidths).toEqual({});
  });

  it("fits all data, including long Unicode names outside the virtual viewport", () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({ name: index === 999 ? "很长的文件名".repeat(10) : "short", path: String(index), size: 10, fileType: "file" as const, mtime: 0, mode: 0, isHidden: false }));
    const width = fitExplorerColumn("name", entries, label, text => Array.from(text).length * 12);
    expect(width).toBe(768);
    expect(explorerColumnLayout({ name: width }).minWidth).toBe(1092);
    expect(explorerColumnLayout({}).template).toContain("minmax(140px, 1fr)");
    expect(explorerColumnLayout({ size: 120 }).template).toContain("120px");
  });
});
