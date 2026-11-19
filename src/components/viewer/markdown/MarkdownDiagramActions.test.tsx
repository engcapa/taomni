import { useLayoutEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeText } from "../../../lib/clipboard";
import { saveExportBlob } from "./exportFiles";
import { MarkdownDiagramActions } from "./MarkdownDiagramActions";
import { rememberDiagram } from "./diagramModel";
import { rememberDrawio } from "./drawioRender";
import { parseDrawio } from "./drawioCodec";

vi.mock("../viewerLabels", () => ({ useViewerLabels: () => label }));
vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn(), writeImagePng: vi.fn() }));
vi.mock("./exportFiles", () => ({ saveExportBlob: vi.fn() }));
vi.mock("./wordSvg", () => ({ portableWordSvg: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"/>') }));
const label = (_zh: string, en: string) => en;
const source = "flowchart LR\nA[加载配置] --> B[保存历史]";
let report = vi.fn();
const drawio = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" parent="1" vertex="1" value="Review"/></root></mxGraphModel>';
function Harness({ path = "/docs/example.md", imported = false }: { path?: string; imported?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const diagram = document.createElement("div"); diagram.className = imported ? "fv-md-drawio" : "fv-md-mermaid";
    diagram.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240"><text>加载配置</text><text>保存历史</text></svg>';
    if (imported) rememberDrawio(diagram, parseDrawio(drawio)[0]);
    else rememberDiagram(diagram, { source, theme: "light" });
    root.current!.prepend(diagram);
    return () => diagram.remove();
  }, [path, imported]);
  return <div ref={root}><div className="fv-md-main" tabIndex={-1} /><MarkdownDiagramActions root={root} docPath={path} onError={report} /></div>;
}
const diagram = () => document.querySelector<HTMLElement>(".fv-md-mermaid")!;
beforeEach(() => {
  vi.clearAllMocks(); report = vi.fn();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

it("opens the same menu for imported draw.io and copies its editable XML", async () => {
  render(<Harness imported />);
  const drawing = document.querySelector(".fv-md-drawio")!;
  fireEvent.contextMenu(drawing);
  expect(screen.getByRole("menu", { name: "draw.io image menu" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy draw.io source" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('value="Review"')));
  fireEvent.doubleClick(drawing);
  expect(screen.getByRole("img", { name: "draw.io diagram" }).querySelector("svg")).toBeInTheDocument();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("copies structured text separately from exact Mermaid source through the context menu", async () => {
  render(<Harness />);
  fireEvent.contextMenu(diagram(), { clientX: 40, clientY: 40 });
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("markdown-diagram-menu-copy-text"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("加载配置\n保存历史"));
  fireEvent.contextMenu(diagram()); fireEvent.click(screen.getByTestId("markdown-diagram-menu-copy-source"));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  expect(diagram().querySelector("svg")!.textContent).toBe("加载配置保存历史");
});

it("rotates, flips, fits and resets a viewer copy then restores diagram focus on Escape", async () => {
  render(<Harness />); diagram().focus(); fireEvent.keyDown(diagram(), { key: "Enter" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await screen.findByRole("img");
  const stage = screen.getByTestId("markdown-diagram-stage");
  fireEvent.click(screen.getByTestId("markdown-diagram-view-rotate-left")); expect(stage).toHaveAttribute("data-rotation", "270");
  fireEvent.click(screen.getByTestId("markdown-diagram-view-flip-v")); expect(stage).toHaveAttribute("data-flip-y", "true");
  fireEvent.keyDown(stage, { key: "R" }); expect(stage).toHaveAttribute("data-rotation", "180");
  fireEvent.click(screen.getByTestId("markdown-diagram-view-actual")); expect(stage).toHaveAttribute("data-scale", "1");
  fireEvent.click(screen.getByTestId("markdown-diagram-view-reset")); expect(stage).toHaveAttribute("data-rotation", "0"); expect(stage).toHaveAttribute("data-flip-y", "false");
  fireEvent.keyDown(stage, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(diagram());
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:diagram"));
});

it("distinguishes save formats with different icons, visible labels and accessible names", () => {
  render(<Harness />);
  fireEvent.doubleClick(diagram());
  const formats = [["save-svg", "SVG", "Save SVG"], ["save-png", "PNG", "Save high-resolution PNG"], ["save-drawio", "draw.io", "Save draw.io file"]];
  const icons = formats.map(([id, format, name]) => {
    const button = screen.getByTestId(`markdown-diagram-view-${id}`);
    expect(button).toHaveTextContent(format);
    expect(button).toHaveAccessibleName(name);
    return button.querySelector("svg")!.innerHTML;
  });
  expect(new Set(icons).size).toBe(3);
});

it("supports keyboard menu dismissal and never generates or writes an image after save cancellation", async () => {
  vi.mocked(saveExportBlob).mockResolvedValue(null);
  render(<Harness />); diagram().focus(); fireEvent.keyDown(diagram(), { key: "F10", shiftKey: true });
  fireEvent.keyDown(screen.getByTestId("markdown-diagram-menu"), { key: "End" });
  expect(document.activeElement).toBe(screen.getByTestId("markdown-diagram-menu-copy-source"));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(diagram());
  fireEvent.contextMenu(diagram()); fireEvent.click(screen.getByTestId("markdown-diagram-menu-save-png"));
  await waitFor(() => expect(screen.getByTestId("markdown-diagram-status")).toHaveTextContent("Save cancelled"));
  expect(saveExportBlob).toHaveBeenCalledWith("example-diagram-1.png", expect.any(Function), "/docs/example.md");
});

it("dismisses the context menu when a diagram consumes pointerdown or when focus moves outside", () => {
  render(<Harness />);
  fireEvent.contextMenu(diagram());
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.pointerDown(diagram(), { button: 0 });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(diagram());
  act(() => document.querySelector<HTMLElement>(".fv-md-main")!.focus());
  expect(screen.queryByRole("menu")).toBeNull();
});

it("disposes portals and ignores a failed save from the previous document", async () => {
  let reject!: (cause: Error) => void;
  vi.mocked(saveExportBlob).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const { rerender, unmount } = render(<Harness />);
  fireEvent.contextMenu(diagram()); fireEvent.click(screen.getByTestId("markdown-diagram-menu-save-svg"));
  rerender(<Harness path="/docs/other.md" />);
  await act(async () => { reject(new Error("Late disk error")); });
  expect(report).not.toHaveBeenCalled(); expect(screen.queryByTestId("markdown-diagram-status")).toBeNull();
  fireEvent.doubleClick(diagram()); expect(screen.getByRole("dialog")).toBeInTheDocument();
  unmount(); expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByRole("menu")).toBeNull();
});
