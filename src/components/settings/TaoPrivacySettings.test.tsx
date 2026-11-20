import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TaoPrivacySettings } from "./TaoPrivacySettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/runtime", () => ({ isTauriRuntime: () => true }));

it("keeps independently committed source choices in a dismissible multi-select menu", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "history_privacy_summary") return { version: 1, commandsCleaned: 2, queriesCleaned: 0 };
    if (command === "deepseek_app_search_sources") return { commands: true, sql: true, mail: false };
    const sources = (args as { sources?: Record<string, boolean> } | undefined)?.sources;
    if (command === "deepseek_app_set_search_sources" && sources && "commands" in sources) throw new Error("Source update failed");
  });
  render(<TaoPrivacySettings />);
  const trigger = await screen.findByTestId("tao-search-sources");
  expect(trigger).toHaveTextContent("2/3");
  fireEvent.click(trigger);
  const sql = screen.getByTestId("tao-search-source-sql");
  fireEvent.click(sql);
  await waitFor(() => expect(trigger).toHaveTextContent("1/3"));
  expect(sql).not.toBeChecked();
  const commands = screen.getByTestId("tao-search-source-commands");
  fireEvent.click(commands);
  expect(await screen.findByRole("alert")).toHaveTextContent("Source update failed");
  expect(commands).toBeChecked();
  fireEvent.keyDown(commands, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(screen.queryByTestId("tao-search-sources-menu")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("deepseek_app_set_search_sources", { sources: { sql: false } });
});
