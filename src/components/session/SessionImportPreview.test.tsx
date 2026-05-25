import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionConfig } from "../../lib/ipc";
import type {
  SessionImportResult,
  SessionImportSecret,
} from "../../lib/sessionImportExport";
import { SessionImportPreview } from "./SessionImportPreview";

function makeSession(id: string, name = `session-${id}`): SessionConfig {
  return {
    id,
    name,
    session_type: "SSH",
    group_path: null,
    host: `${id}.example.com`,
    port: 22,
    username: "root",
    auth_method: "Password",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
  };
}

function makeResult(overrides: Partial<SessionImportResult> = {}): SessionImportResult {
  return {
    sessions: [makeSession("a"), makeSession("b"), makeSession("c")],
    warnings: [],
    skipped: 0,
    secrets: [],
    ...overrides,
  };
}

function renderPreview(
  options: {
    result?: SessionImportResult;
    onConfirm?: (selected: ReadonlySet<string>) => void;
    onCancel?: () => void;
  } = {},
) {
  const onConfirm = options.onConfirm ?? vi.fn();
  const onCancel = options.onCancel ?? vi.fn();
  render(
    <SessionImportPreview
      source="Tabby"
      result={options.result ?? makeResult()}
      targetFolder={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

function rowCheckbox(id: string): HTMLInputElement {
  const el = screen.getByTestId(`session-import-preview-row-select-${id}`);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`row checkbox for ${id} not found`);
  }
  return el;
}

function masterCheckbox(): HTMLInputElement {
  const el = screen.getByTestId("session-import-preview-select-all");
  if (!(el instanceof HTMLInputElement)) {
    throw new Error("master checkbox not found");
  }
  return el;
}

describe("SessionImportPreview", () => {
  afterEach(() => cleanup());

  it("renders all rows checked by default", () => {
    renderPreview();
    expect(rowCheckbox("a").checked).toBe(true);
    expect(rowCheckbox("b").checked).toBe(true);
    expect(rowCheckbox("c").checked).toBe(true);
    expect(masterCheckbox().checked).toBe(true);
    expect(masterCheckbox().indeterminate).toBe(false);
    expect(screen.getByTestId("session-import-preview-summary")).toHaveTextContent(
      "3 of 3 sessions",
    );
  });

  it("flips master checkbox to indeterminate when one row is unchecked", async () => {
    const user = userEvent.setup();
    renderPreview();
    await user.click(rowCheckbox("b"));
    expect(rowCheckbox("b").checked).toBe(false);
    expect(masterCheckbox().checked).toBe(false);
    expect(masterCheckbox().indeterminate).toBe(true);
    expect(screen.getByTestId("session-import-preview-summary")).toHaveTextContent(
      "2 of 3 sessions",
    );
  });

  it("disables Import when nothing is selected and re-enables after toggling one back on", async () => {
    const user = userEvent.setup();
    renderPreview();
    await user.click(masterCheckbox()); // deselect all
    expect(rowCheckbox("a").checked).toBe(false);
    expect(rowCheckbox("c").checked).toBe(false);
    const confirm = screen.getByTestId("session-import-preview-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.click(rowCheckbox("a"));
    expect(confirm.disabled).toBe(false);
  });

  it("passes the current selection set when Confirm is clicked", async () => {
    const onConfirm = vi.fn<(selected: ReadonlySet<string>) => void>();
    const user = userEvent.setup();
    renderPreview({ onConfirm });
    await user.click(rowCheckbox("c")); // deselect c, leave a + b
    await user.click(screen.getByTestId("session-import-preview-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const arg = onConfirm.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Set);
    expect(Array.from(arg ?? [])).toEqual(expect.arrayContaining(["a", "b"]));
    expect(arg?.size).toBe(2);
  });

  it("recomputes saved-password and standalone counts as rows are toggled", async () => {
    const secrets: SessionImportSecret[] = [
      { sessionId: "a", kind: "password", label: "root@a:22", value: "pa" },
      { sessionId: "b", kind: "password", label: "root@b:22", value: "pb" },
      { sessionId: "", kind: "key-passphrase", label: "key-id", value: "kp", attachment: "standalone" },
    ];
    const user = userEvent.setup();
    renderPreview({ result: makeResult({ secrets }) });

    expect(screen.getByText(/2 saved passwords will be stored/)).toBeInTheDocument();
    expect(screen.getByText(/\+ 1 standalone secret/)).toBeInTheDocument();

    await user.click(rowCheckbox("a"));
    // a deselected → only b's password counts; standalone count unchanged.
    expect(screen.getByText(/1 saved password will be stored/)).toBeInTheDocument();
    expect(screen.getByText(/\+ 1 standalone secret/)).toBeInTheDocument();
  });
});
