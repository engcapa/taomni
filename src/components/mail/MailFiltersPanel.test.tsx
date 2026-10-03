import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailFilter } from "../../lib/mailFilters";

const filterMocks = vi.hoisted(() => ({
  mailListFilters: vi.fn(),
  mailSaveFilters: vi.fn(),
  mailExportFilters: vi.fn(),
  mailImportFilters: vi.fn(),
}));

vi.mock("../../lib/mailFilters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mailFilters")>()),
  ...filterMocks,
}));

import { MailFiltersPanel } from "./MailFiltersPanel";

const folders = [
  { name: "INBOX", label: "Inbox" },
  { name: "Archive", label: "Archive" },
];

const saved: MailFilter = {
  id: "f1",
  name: "Boss",
  enabled: true,
  matchAny: false,
  conditions: [{ field: "from", op: "is", value: "boss@example.com" }],
  actions: [{ kind: "moveTo", value: "Archive" }],
  onIncoming: true,
};

function renderPanel(props: Partial<Parameters<typeof MailFiltersPanel>[0]> = {}) {
  const onRun = vi.fn(async () => ({ folder: "INBOX", examined: 4, matched: 1, moved: 1, errors: [] }));
  const onStatus = vi.fn();
  render(
    <MailFiltersPanel
      accountId="acct"
      folders={folders}
      currentFolder={{ name: "INBOX", label: "Inbox" }}
      onRun={onRun}
      onStatus={onStatus}
      {...props}
    />,
  );
  return { onRun, onStatus };
}

describe("MailFiltersPanel", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    filterMocks.mailListFilters.mockResolvedValue([]);
    filterMocks.mailSaveFilters.mockImplementation(async (_: string, filters: MailFilter[]) => filters);
  });

  it("creates a filter with several conditions and actions (DEC-11)", async () => {
    renderPanel();
    expect(await screen.findByTestId("mail-filters-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mail-filter-new"));
    const save = screen.getByTestId("mail-filter-save");
    expect(save).toBeDisabled();
    expect(screen.getByTestId("mail-filter-problem")).toHaveTextContent(/name/);

    fireEvent.change(screen.getByTestId("mail-filter-name"), { target: { value: "Reports" } });
    fireEvent.change(screen.getByTestId("mail-filter-condition-value"), { target: { value: "reports@example.com" } });
    fireEvent.click(screen.getByTestId("mail-filter-add-condition"));
    const second = screen.getAllByTestId("mail-filter-condition")[1];
    fireEvent.change(within(second).getByTestId("mail-filter-condition-field"), { target: { value: "sizeKb" } });
    expect(within(second).getByTestId("mail-filter-condition-op")).toHaveValue("greaterThan");
    fireEvent.change(within(second).getByTestId("mail-filter-condition-value"), { target: { value: "100" } });
    fireEvent.change(screen.getByTestId("mail-filter-match"), { target: { value: "any" } });
    fireEvent.change(screen.getByTestId("mail-filter-action-folder"), { target: { value: "Archive" } });
    fireEvent.click(screen.getByTestId("mail-filter-add-action"));
    fireEvent.change(screen.getAllByTestId("mail-filter-action-kind")[1], { target: { value: "addTag" } });
    fireEvent.change(screen.getByTestId("mail-filter-action-tag"), { target: { value: "$label2" } });

    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(filterMocks.mailSaveFilters).toHaveBeenCalledTimes(1));
    const [, filters] = filterMocks.mailSaveFilters.mock.calls[0];
    expect(filters[0]).toMatchObject({
      name: "Reports",
      matchAny: true,
      onIncoming: true,
      conditions: [
        { field: "from", op: "contains", value: "reports@example.com" },
        { field: "sizeKb", op: "greaterThan", value: "100" },
      ],
      actions: [{ kind: "moveTo", value: "Archive" }, { kind: "addTag", value: "$label2" }],
    });
    expect(await screen.findByTestId("mail-filter-row")).toHaveAttribute("data-filter-name", "Reports");
  });

  it("runs, reorders, toggles and deletes filters", async () => {
    const second = { ...saved, id: "f2", name: "Second" };
    filterMocks.mailListFilters.mockResolvedValue([saved, second]);
    const { onRun, onStatus } = renderPanel();
    const rows = await screen.findAllByTestId("mail-filter-row");
    expect(rows).toHaveLength(2);

    fireEvent.click(screen.getByTestId("mail-filter-run-all"));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith(undefined));
    expect(await screen.findByTestId("mail-filters-last-run")).toHaveTextContent("matched 1 of 4");
    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("moved 1"));
    fireEvent.click(within(rows[1]).getByTestId("mail-filter-run"));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith(["f2"]));

    fireEvent.click(screen.getByLabelText("Move Second up"));
    await waitFor(() => expect(filterMocks.mailSaveFilters).toHaveBeenLastCalledWith("acct", [second, saved]));
    fireEvent.click(within(screen.getAllByTestId("mail-filter-row")[1]).getByTestId("mail-filter-enabled"));
    await waitFor(() => expect(filterMocks.mailSaveFilters).toHaveBeenLastCalledWith("acct", [second, { ...saved, enabled: false }]));
    fireEvent.click(within(screen.getAllByTestId("mail-filter-row")[0]).getByTestId("mail-filter-delete"));
    await waitFor(() => expect(filterMocks.mailSaveFilters).toHaveBeenLastCalledWith("acct", [{ ...saved, enabled: false }]));
  });

  it("opens the editor on a pre-filled draft and shows save errors", async () => {
    filterMocks.mailSaveFilters.mockRejectedValue("Boss: invalid regular expression");
    renderPanel({ initialDraft: saved });
    expect(await screen.findByTestId("mail-filter-editor")).toBeInTheDocument();
    expect(screen.getByTestId("mail-filter-name")).toHaveValue("Boss");
    expect(screen.getByTestId("mail-filter-condition-value")).toHaveValue("boss@example.com");
    fireEvent.click(screen.getByTestId("mail-filter-save"));
    await waitFor(() => expect(filterMocks.mailSaveFilters).toHaveBeenCalled());
    expect(screen.getByTestId("mail-filter-editor")).toBeInTheDocument();
  });
});
