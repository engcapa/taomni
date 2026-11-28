import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceUiStore } from "../../stores/workspaceUiStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { searchGlobalFiles, validFileQuery, type GlobalFileResults } from "../../lib/explorer/globalFileSearch";
import { explorerCancelOperation } from "../../lib/explorer";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { openFile } from "../../lib/openFile";
import { GlobalCommandModal } from "./GlobalCommandModal";
import { FileSearchDialog } from "./FileSearchDialog";

vi.mock("../../lib/explorer/globalFileSearch", async (original) => ({
  ...await original<typeof import("../../lib/explorer/globalFileSearch")>(),
  searchGlobalFiles: vi.fn(),
}));
vi.mock("../../lib/explorer", async (original) => ({
  ...await original<typeof import("../../lib/explorer")>(), explorerCancelOperation: vi.fn(async () => {}),
}));
vi.mock("../../lib/openFile", async (original) => ({
  ...await original<typeof import("../../lib/openFile")>(), openFile: vi.fn(async () => {}),
}));
vi.mock("../../lib/explorer/openExplorer", () => ({ openExplorer: vi.fn(async () => "explorer") }));

const matches: GlobalFileResults = {
  entries: [
    { name: "yearly.md", path: "/papers/yearly.md", isDirectory: false },
    { name: "yearly", path: "/backups/yearly", isDirectory: true },
  ],
  provider: "boundedScan", scannedRoots: ["/papers"], truncated: true,
};
let trigger: HTMLButtonElement;
beforeEach(() => {
  trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  vi.clearAllMocks();
  vi.mocked(searchGlobalFiles).mockResolvedValue(matches);
});
afterEach(() => {
  cleanup();
  trigger.remove();
  useWorkspaceUiStore.getState().closeGlobalSearch();
  useExplorerStore.setState({ tabs: [], activeTabId: null });
});

function showDialog() {
  return render(<FileSearchDialog contextRoot="/papers" returnFocus={trigger} onClose={() => {}} />);
}
const input = () => screen.getByTestId("file-search-input");
const submit = () => screen.getByTestId("file-search-submit");
const status = () => screen.getByTestId("file-search-status");
function type(text: string) { fireEvent.change(input(), { target: { value: text } }); }

it("counts Unicode code points after trimming and waits for an eligible explicit submission", async () => {
  expect(validFileQuery(" 🪴 ")).toBe(false);
  expect(validFileQuery(" 🪴簿 ")).toBe(true);
  expect(validFileQuery("🪴".repeat(97))).toBe(false);
  showDialog();
  expect(input()).toHaveFocus();
  type("y");
  expect(submit()).toBeDisabled();
  fireEvent.keyDown(input(), { key: "Enter" });
  type("yly");
  fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
  fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
  expect(searchGlobalFiles).not.toHaveBeenCalled();
  fireEvent.click(submit());
  expect(searchGlobalFiles).toHaveBeenCalledExactlyOnceWith("yly", expect.any(String), "/papers");
  expect(await screen.findByText("/papers/yearly.md")).toBeVisible();
  expect(status()).toHaveTextContent("Limited folder scan");
  expect(status()).toHaveTextContent("Folders checked: /papers");
  expect(status()).toHaveAttribute("data-truncated", "true");
  fireEvent.keyDown(input(), { key: "ArrowDown" });
  expect(screen.getAllByTestId("file-search-result")[0]).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  const folder = screen.getAllByTestId("file-search-result")[1];
  expect(folder).toHaveFocus();
  fireEvent.click(folder);
  expect(openExplorer).toHaveBeenCalledExactlyOnceWith("/backups/yearly");
});

it("runs a seeded search only after choosing the palette action and opens a file in Explorer", async () => {
  useExplorerStore.getState().openTab({
    id: "explorer-1", type: "file-browser", title: "papers", closable: true, fileBrowser: { initialPath: "/papers", explorer: true },
  });
  render(<StrictMode><GlobalCommandModal /></StrictMode>);
  act(() => useWorkspaceUiStore.getState().openGlobalSearch());
  const paletteInput = screen.getByTestId("global-search-input");
  fireEvent.change(paletteInput, { target: { value: "yly" } });
  const activate = screen.getByTestId("global-search-files");
  fireEvent.mouseEnter(activate);
  fireEvent.keyDown(paletteInput, { key: "ArrowDown" });
  expect(searchGlobalFiles).not.toHaveBeenCalled();
  fireEvent.click(activate);
  const row = (await screen.findAllByTestId("file-search-result"))[0];
  expect(searchGlobalFiles).toHaveBeenCalledExactlyOnceWith("yly", expect.any(String), "/papers");
  fireEvent.keyDown(input(), { key: "Escape", isComposing: true });
  expect(screen.getByTestId("file-search-dialog")).toBeVisible();
  fireEvent.keyDown(input(), { key: "Escape" });
  expect(activate).toHaveFocus();
  expect(paletteInput).toHaveValue("yly");
  expect(row).not.toBeInTheDocument();
  fireEvent.click(activate);
  fireEvent.click((await screen.findAllByTestId("file-search-result"))[0]);
  expect(openFile).toHaveBeenCalledExactlyOnceWith("/papers/yearly.md", { context: "global-file-search", host: "explorer" });
  await waitFor(() => expect(screen.queryByTestId("global-search-modal")).toBeNull());
});

it("cancels an edited or closed request and rejects late results from a previous search", async () => {
  let finish!: (result: GlobalFileResults) => void;
  vi.mocked(searchGlobalFiles).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = showDialog();
  type("old");
  fireEvent.click(submit());
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(searchGlobalFiles).toHaveBeenCalledTimes(1);
  const id = vi.mocked(searchGlobalFiles).mock.calls[0][1];
  type("new");
  expect(explorerCancelOperation).toHaveBeenCalledWith(id);
  fireEvent.click(submit());
  await screen.findByText("/papers/yearly.md");
  await act(async () => finish({ ...matches, entries: [] }));
  expect(screen.getAllByTestId("file-search-result")).toHaveLength(2);
  type("again");
  vi.mocked(searchGlobalFiles).mockImplementation(() => new Promise(() => {}));
  fireEvent.click(submit());
  fireEvent.click(screen.getByTestId("file-search-cancel"));
  expect(status()).toHaveAttribute("data-state", "cancelled");
  expect(input()).toHaveFocus();
  fireEvent.click(submit());
  const lastId = vi.mocked(searchGlobalFiles).mock.lastCall![1];
  view.unmount();
  expect(explorerCancelOperation).toHaveBeenLastCalledWith(lastId);
  expect(trigger).toHaveFocus();
});

it("allows retry after provider contention, empty results and a failed result action", async () => {
  vi.mocked(searchGlobalFiles)
    .mockRejectedValueOnce("busy: occupied")
    .mockResolvedValueOnce({ ...matches, entries: [], truncated: false })
    .mockResolvedValueOnce(matches);
  vi.mocked(openFile).mockRejectedValueOnce(new Error("permission denied"));
  showDialog();
  type("year");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(await screen.findByText("Another file search is running. Try again shortly.")).toBeVisible();
  fireEvent.click(submit());
  expect(await screen.findByText("No matching names found.")).toBeVisible();
  fireEvent.click(submit());
  const row = (await screen.findAllByTestId("file-search-result"))[0];
  fireEvent.click(row);
  expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  expect(row).toBeEnabled();
  type("different");
  expect(screen.queryByRole("alert")).toBeNull();
});
