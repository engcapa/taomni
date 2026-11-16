import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryPanel } from "./MemoryPanel";
import { createChatController } from "./controller";

const backend = vi.hoisted(() => ({ listMemory: vi.fn(), saveMemory: vi.fn(), deleteMemory: vi.fn() }));
vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./nativeCapabilities", () => ({ nativeCapabilities: backend }));
const entry = { id: "saved", kind: "skill" as const, title: "/review", content: "Original", enabled: true };

beforeEach(() => {
  vi.resetAllMocks();
  backend.listMemory.mockResolvedValue([entry]);
  backend.saveMemory.mockResolvedValue(entry);
});
afterEach(cleanup);

async function edit() {
  render(<MemoryPanel controller={createChatController()} />);
  fireEvent.click(await screen.findByTestId("tao-home-memory-edit"));
  fireEvent.change(screen.getByTestId("tao-home-memory-content"), { target: { value: "Revised" } });
}

it.each(["button", "Escape"])("cancels inline editing through %s without changing approved content", async (method) => {
  await edit();
  if (method === "button") fireEvent.click(screen.getByTestId("tao-home-memory-cancel"));
  else fireEvent.keyDown(screen.getByTestId("tao-home-memory-content"), { key: "Escape" });
  expect(screen.getByText("Original")).toBeInTheDocument();
  expect(screen.queryByTestId("tao-home-memory-content")).not.toBeInTheDocument();
  expect(backend.saveMemory).not.toHaveBeenCalled();
});

it("retains failed edits for retry and preserves record identity and kind on save", async () => {
  backend.saveMemory.mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValue(entry);
  await edit();
  fireEvent.click(screen.getByTestId("tao-home-memory-save"));
  expect(await screen.findByRole("alert")).toHaveTextContent("storage unavailable");
  expect(screen.getByTestId("tao-home-memory-content")).toHaveValue("Revised");
  backend.listMemory.mockResolvedValue([{ ...entry, content: "Revised" }]);
  fireEvent.click(screen.getByTestId("tao-home-memory-save"));
  expect(await screen.findByText("Revised", { selector: "p" })).toBeInTheDocument();
  expect(backend.saveMemory).toHaveBeenLastCalledWith({ ...entry, content: "Revised" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("blocks duplicate writes and cancellation until the actual save settles", async () => {
  let complete!: () => void;
  backend.saveMemory.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  await edit();
  fireEvent.click(screen.getByTestId("tao-home-memory-save"));
  expect(screen.getByTestId("tao-home-memory-save")).toBeDisabled();
  expect(screen.getByTestId("tao-home-memory-cancel")).toBeDisabled();
  fireEvent.click(screen.getByTestId("tao-home-memory-save"));
  fireEvent.keyDown(screen.getByTestId("tao-home-memory-content"), { key: "Escape" });
  expect(backend.saveMemory).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("tao-home-memory-content")).toBeInTheDocument();
  complete();
  await waitFor(() => expect(screen.queryByTestId("tao-home-memory-content")).not.toBeInTheDocument());
});
