import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./ipc", () => ({
  selectFilePath: vi.fn(),
  readFileBytes: vi.fn(),
}));
vi.mock("./runtime", () => ({
  isTauriRuntime: vi.fn(),
}));
vi.mock("./fileHelpers", () => ({
  openTextFileWithName: vi.fn(),
  openBinaryFile: vi.fn(),
}));

import { pickImportText, pickImportBytes } from "./nativeImportPicker";
import { selectFilePath, readFileBytes } from "./ipc";
import { isTauriRuntime } from "./runtime";
import { openTextFileWithName, openBinaryFile } from "./fileHelpers";

const mockSelect = vi.mocked(selectFilePath);
const mockRead = vi.mocked(readFileBytes);
const mockIsTauri = vi.mocked(isTauriRuntime);
const mockOpenText = vi.mocked(openTextFileWithName);
const mockOpenBinary = vi.mocked(openBinaryFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pickImportText", () => {
  it("uses the native dialog under Tauri and decodes the bytes (.bak is selectable)", async () => {
    mockIsTauri.mockReturnValue(true);
    mockSelect.mockResolvedValue("/home/u/下载/ZeroOmegaOptions-2026.bak");
    mockRead.mockResolvedValue(new TextEncoder().encode('{"ok":true}'));

    const file = await pickImportText(".bak,.json,application/json,text/plain");

    expect(file).toEqual({ name: "ZeroOmegaOptions-2026.bak", text: '{"ok":true}' });
    expect(mockOpenText).not.toHaveBeenCalled();
  });

  it("returns null when the native dialog is cancelled", async () => {
    mockIsTauri.mockReturnValue(true);
    mockSelect.mockResolvedValue(null);

    expect(await pickImportText(".bak")).toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("falls back to the HTML picker in the browser dev server", async () => {
    mockIsTauri.mockReturnValue(false);
    mockOpenText.mockResolvedValue({ name: "x.json", text: "{}" });

    const file = await pickImportText(".json,application/json");

    expect(file).toEqual({ name: "x.json", text: "{}" });
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe("pickImportBytes", () => {
  it("uses the native dialog under Tauri and strips a Windows path to the basename", async () => {
    mockIsTauri.mockReturnValue(true);
    mockSelect.mockResolvedValue("C:\\Users\\u\\export.xsh");
    const bytes = new Uint8Array([1, 2, 3]);
    mockRead.mockResolvedValue(bytes);

    const file = await pickImportBytes(".xsh,.xts,.zip");

    expect(file).toEqual({ name: "export.xsh", bytes });
  });

  it("falls back to openBinaryFile in the browser dev server", async () => {
    mockIsTauri.mockReturnValue(false);
    mockOpenBinary.mockResolvedValue(new Uint8Array([9, 9]).buffer);

    const file = await pickImportBytes(".zip");

    expect(file?.name).toBe("");
    expect(Array.from(file?.bytes ?? [])).toEqual([9, 9]);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
