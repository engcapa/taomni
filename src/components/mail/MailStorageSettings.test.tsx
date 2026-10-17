import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailFolder } from "../../lib/mail";
import { MailStorageSettings, type MailStorageOptions } from "./MailStorageSettings";

const { listFolders } = vi.hoisted(() => ({ listFolders: vi.fn() }));
vi.mock("../../lib/mail", () => ({ mailListCachedFolders: listFolders }));
vi.mock("../../lib/ipc", () => ({ selectFolderPath: vi.fn() }));
const value: MailStorageOptions = { directory: "", mode: "include", folders: [] };
const folder = (name: string, displayName?: string): MailFolder => ({
  accountId: "a", name, displayName, flags: [], updatedAt: 0,
});

describe("MailStorageSettings", () => {
  beforeEach(() => listFolders.mockReset());
  afterEach(cleanup);

  it("labels cached folders in readable text while retaining exact server keys", async () => {
    listFolders.mockResolvedValue([
      folder("&dcVr0pCuTvY-", "电子邮件"),
      folder("&U,BTFw-"),
      { ...folder("hidden"), flags: ["\\Noselect"] },
    ]);
    const onChange = vi.fn();
    render(<MailStorageSettings accountId="a" value={{ ...value, folders: [""] }} onChange={onChange} pop3={false} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "电子邮件" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, folders: ["&dcVr0pCuTvY-"] });
    expect(screen.getByRole("checkbox", { name: "台北" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "hidden" })).not.toBeInTheDocument();
  });

  it("does not connect to discover folders for a new account and allows manual entries", () => {
    const onChange = vi.fn();
    render(<MailStorageSettings value={value} onChange={onChange} pop3={false} />);
    expect(listFolders).not.toHaveBeenCalled();
    expect(screen.getByText(/Connect and sync this account first/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Full mail folder names"), { target: { value: "INBOX" } });
    expect(onChange).toHaveBeenCalledWith({ ...value, folders: ["INBOX"] });
  });

  it("discards old account candidates, failures and late replies while retaining configured names", async () => {
    let finish!: (folders: MailFolder[]) => void;
    listFolders.mockResolvedValueOnce([folder("First")]).mockImplementationOnce(() => new Promise<MailFolder[]>((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("unavailable"));
    const props = { value: { ...value, folders: ["&U,BTFw-"] }, onChange: vi.fn(), pop3: false };
    const { rerender } = render(<MailStorageSettings {...props} accountId="a" />);
    await screen.findByRole("checkbox", { name: "First" });
    rerender(<MailStorageSettings {...props} accountId="b" />);
    expect(screen.queryByRole("checkbox", { name: "First" })).not.toBeInTheDocument();
    rerender(<MailStorageSettings {...props} accountId="c" />);
    await waitFor(() => expect(listFolders).toHaveBeenCalledTimes(3));
    await act(async () => finish([folder("Late") ]));
    expect(screen.queryByRole("checkbox", { name: "Late" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "台北" })).toBeChecked();
    expect(screen.getByText(/Connect and sync this account first/)).toBeInTheDocument();
    rerender(<MailStorageSettings {...props} />);
    expect(screen.queryByRole("checkbox", { name: "First" })).not.toBeInTheDocument();
  });
});
