import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import { FilesPanel } from "./FilesPanel";
import { setLocale } from "../../../lib/i18n";

const mocks = vi.hoisted(() => ({ open: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class { onmessage = () => undefined; } }));
vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: () => true }));

describe("native Tao file selection recovery", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); setLocale("en"); });

  it("clears a failed selection when the next valid native upload completes", async () => {
    setLocale("en");
    let uploads = 0;
    mocks.open.mockResolvedValueOnce(["C:/qa/unsupported.bin"]).mockResolvedValueOnce(["C:/qa/valid.png"]);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "deepseek_app_file_tasks") return [];
      if (command === "deepseek_app_upload_file") {
        if (++uploads === 1) throw "file: this file type is not supported";
        return { fileId: "qa-recovery", filename: "valid.png", mime: "image/png", sizeBytes: 20 };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const controller = createChatController();
    render(<FilesPanel controller={controller} />);
    fireEvent.click(screen.getByTestId("tao-home-file-choose"));
    await waitFor(() => expect(screen.getAllByRole("alert")[0]).toHaveTextContent("not supported"));
    fireEvent.click(screen.getByTestId("tao-home-file-choose"));
    await waitFor(() => expect(controller.getState().composer.chips).toEqual([expect.objectContaining({ fileId: "qa-recovery" })]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancel leaves the current references intact and sends no upload", async () => {
    mocks.open.mockResolvedValue(null);
    mocks.invoke.mockImplementation(async (command: string) => command === "deepseek_app_file_tasks" ? [] : undefined);
    const controller = createChatController();
    controller.setChips([{ id: "keep", kind: "local", label: "Keep", preview: "QA content" }]);
    render(<FilesPanel controller={controller} />);
    fireEvent.click(screen.getByTestId("tao-home-file-choose"));
    await waitFor(() => expect(mocks.open).toHaveBeenCalled());
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ filters: [expect.objectContaining({
      extensions: expect.arrayContaining(["pdf", "png", "webp", "py", "ts", "rs", "md", "docx"]),
    })] }));
    expect(mocks.invoke.mock.calls.some(([command]) => command === "deepseek_app_upload_file")).toBe(false);
    expect(controller.getState().composer.chips.map((chip) => chip.id)).toEqual(["keep"]);
  });
});
