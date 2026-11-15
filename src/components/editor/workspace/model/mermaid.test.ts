import { describe, expect, it, vi } from "vitest";
import { renderMermaid } from "./mermaid";

const calls = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: calls }));

describe("Mermaid render ownership", () => {
  it("keeps different document/export themes isolated while rendering asynchronously, including recovery", async () => {
    let release!: () => void;
    calls.render.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { svg: "dark" }; })
      .mockResolvedValueOnce({ svg: "light" }).mockRejectedValueOnce(new Error("bad source")).mockResolvedValueOnce({ svg: "recovered" });
    const dark = renderMermaid("dark-id", "flowchart LR\nA-->B", "dark");
    const light = renderMermaid("light-id", "sequenceDiagram\nA->>B: ok", "light");
    await vi.waitFor(() => expect(calls.render).toHaveBeenCalledTimes(1));
    expect(calls.initialize).toHaveBeenCalledTimes(1);
    expect(calls.initialize.mock.calls[0][0].themeVariables.darkMode).toBe(true);
    release();
    expect(await dark).toEqual({ svg: "dark" }); expect(await light).toEqual({ svg: "light" });
    expect(calls.initialize.mock.calls[1][0].themeVariables.darkMode).toBe(false);
    expect(calls.render.mock.calls[1][1]).toContain('"htmlLabels": false');
    await expect(renderMermaid("bad", "bad", "dark")).rejects.toThrow("bad source");
    expect(await renderMermaid("good", "flowchart LR\nA-->B", "light")).toEqual({ svg: "recovered" });
  });
});
