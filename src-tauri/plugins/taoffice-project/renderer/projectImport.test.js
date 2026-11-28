import { Blob } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { readProject } from "./projectImport.js";

const source = (extension, input) => ({ extension, read: async () => new Blob([input]) });
const signal = () => new AbortController().signal;

describe("Project import transfer", () => {
  it("passes XML directly to the renderer", async () => {
    const invoke = vi.fn();
    const bytes = await readProject({ invoke }, source("xml", "<Project/>"), signal());
    expect(new TextDecoder().decode(bytes)).toBe("<Project/>");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("transfers binary input in order and releases the converted bytes", async () => {
    const result = "<Project/>";
    const invoke = vi.fn(async (method) => {
      if (method === "project/convert") return { size: result.length };
      if (method === "project/read") return { data: btoa(result) };
      return null;
    });
    const release = vi.fn();
    const deferCleanup = vi.fn(() => release);
    const bytes = await readProject({ invoke, deferCleanup }, source("mpp", Uint8Array.of(0xd0, 0xcf)), signal());
    expect(new TextDecoder().decode(bytes)).toBe(result);
    const id = invoke.mock.calls[0][1].id;
    expect(invoke.mock.calls.map(([method, payload]) => [method, payload])).toEqual([
      ["project/begin", { id, size: 2 }],
      ["project/append", { id, offset: 0, data: "0M8=" }],
      ["project/convert", { id }],
      ["project/read", { id, offset: 0 }],
    ]);
    expect(deferCleanup).toHaveBeenCalledWith("project/close", { id });
    expect(release).toHaveBeenCalledOnce();
  });

  it("discards a truncated response and releases the failed transfer", async () => {
    const invoke = vi.fn(async (method) => {
      if (method === "project/convert") return { size: 10 };
      if (method === "project/read") return { data: btoa("<") };
      return null;
    });
    await expect(readProject({ invoke }, source("mpp", Uint8Array.of(0xd0)), signal()))
      .rejects.toThrow("incomplete");
    expect(invoke).toHaveBeenLastCalledWith("project/close", { id: invoke.mock.calls[0][1].id });
  });
});
