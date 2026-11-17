import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Node builtins are used only to read the retained render fixture.
import { readFileSync } from "node:fs";
import { inspectMermaidDiagram } from "../../editor/workspace/model/mermaid";
import { newDrawioPage, parseDrawio, drawioFile } from "./drawioCodec";
import { DEFAULT_DIAGRAM_VIEW } from "./diagramModel";
import { mermaidDrawioCells } from "./drawioMermaid";
import { drawioToMarkdown } from "./drawioImport";
import type { MermaidSequence } from "./drawioMermaidSequence";

vi.mock("../../editor/workspace/model/mermaid", () => ({ inspectMermaidDiagram: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const readFixture = (name: string): string => readFileSync(`src/components/viewer/markdown/fixtures/mermaid-agent-sequence.${name}`, "utf8");

it.each([0, 90])("exports the reported agent sequence as independent native messages, actors, activations, loop and numbered labels at %s degrees", async (rotation) => {
  const data = JSON.parse(readFixture("json")) as MermaidSequence;
  vi.mocked(inspectMermaidDiagram).mockImplementation(async (_source, inspect) => inspect({ type: "sequence", db: { getActors: () => new Map(data.actors), getMessages: () => data.messages } }));
  // jsdom has no SVG geometry API; the browser/native regressions measure the
  // actual render. Here message/path semantics use the retained real SVG.
  Object.defineProperty(SVGElement.prototype, "getTotalLength", { configurable: true, value: () => 100 });
  Object.defineProperty(SVGElement.prototype, "getPointAtLength", { configurable: true, value(this: SVGElement, length: number) {
    const values = this.getAttribute("d")!.match(/[-\d.]+/g)!.map(Number);
    const t = length / 100, s = 1 - t;
    return { x: s ** 3 * values[0] + 3 * s ** 2 * t * values[2] + 3 * s * t ** 2 * values[4] + t ** 3 * values[6],
      y: s ** 3 * values[1] + 3 * s ** 2 * t * values[3] + 3 * s * t ** 2 * values[5] + t ** 3 * values[7] };
  } });
  try {
    const svg = new DOMParser().parseFromString(readFixture("svg"), "image/svg+xml").documentElement as unknown as SVGSVGElement;
    const source = readFixture("mmd"), page = newDrawioPage("agent", "Agent");
    expect(await mermaidDrawioCells(page, { source, svg, width: 1181, height: 815, theme: "light", text: "", filename: "agent" }, { ...DEFAULT_DIAGRAM_VIEW, rotation }, "agent", 40, 80)).toBe(true);
    const model = parseDrawio(drawioFile([page]))[0].model;
    const messages = Array.from(model.querySelectorAll("mxCell[taomniKind='sequence-message']"));
    expect(messages).toHaveLength(9);
    expect(messages.filter((cell) => cell.getAttribute("from") === cell.getAttribute("to"))).toHaveLength(3);
    expect(messages.filter((cell) => cell.getAttribute("style")?.includes("dashed=1;"))).toHaveLength(3);
    expect(messages.filter((cell) => cell.getAttribute("style")?.includes("curved=1;"))).toHaveLength(3);
    const messageLabels = Array.from(model.querySelectorAll("mxCell[taomniKind='sequence-message-label']"));
    expect(messageLabels).toHaveLength(rotation ? 9 : 0);
    expect((rotation ? messageLabels : messages)[0]?.getAttribute("value")).toBe("输入任务目标 (如: 修复代码并提交)");
    if (rotation) expect(messageLabels.every(cell => cell.getAttribute("style")?.includes(`rotation=${rotation};`))).toBe(true);
    expect(messages.every((cell) => !!cell.getAttribute("source") && !!cell.getAttribute("target"))).toBe(true);
    expect(model.querySelectorAll("mxCell[taomniKind='sequence-lifeline']")).toHaveLength(4);
    expect(model.querySelectorAll("mxCell[taomniKind='sequence-activation']")).toHaveLength(2);
    expect(model.querySelectorAll("mxCell[taomniKind='sequence-fragment']")).toHaveLength(4);
    expect(model.querySelectorAll("mxCell[taomniKind='sequence-participant']")).toHaveLength(6);
    expect(model.querySelector("object[mermaidSource]")?.getAttribute("mermaidSource")).toBe(source);
    const cells = Array.from(model.querySelectorAll("mxCell[vertex='1'],mxCell[edge='1']"));
    expect(cells.every((cell) => cell.getAttribute("parent") === "1")).toBe(true);
    expect(cells.some((cell) => /shape=image|(?:^|;)group;/.test(cell.getAttribute("style") || ""))).toBe(false);
    expect(cells.filter((cell) => cell.getAttribute("value") === "9")).toHaveLength(1);
    expect(cells.some((cell) => cell.getAttribute("value")?.includes("工具调用与自适应循环"))).toBe(true);
    const imported = drawioToMarkdown([{ ...page, model }], "text");
    expect(imported).toContain('taomniKind="sequence-actor-label"');
    expect(imported).toContain('value="9"');
  } finally {
    Reflect.deleteProperty(SVGElement.prototype, "getTotalLength");
    Reflect.deleteProperty(SVGElement.prototype, "getPointAtLength");
  }
});
