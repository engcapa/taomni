import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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
    fireEvent.click(screen.getByText("Advanced: edit folder names"));
    fireEvent.change(screen.getByLabelText("Full mail folder names"), { target: { value: "INBOX" } });
    expect(onChange).toHaveBeenCalledWith({ ...value, folders: ["INBOX"] });
  });

  it("shows readable selections offline and keeps encoded keys when deselecting a folder", () => {
    const onChange = vi.fn();
    render(<MailStorageSettings value={{ ...value, mode: "exclude", folders: ["&U,BTFw-", "Archives/2025"] }} onChange={onChange} pop3={false} />);
    expect(screen.getByRole("list", { name: "Selected mail folders" })).toHaveTextContent("台北");
    expect(screen.getByRole("list", { name: "Selected mail folders" })).not.toHaveTextContent("&U,BTFw-");
    expect(screen.getByText("Excluded folders")).toBeInTheDocument();
    expect(screen.getByLabelText("Full mail folder names")).not.toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Archives/2025" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, mode: "exclude", folders: ["&U,BTFw-"] });
    fireEvent.click(screen.getByText("Advanced: edit folder names"));
    expect(screen.getByLabelText("Full mail folder names")).toHaveValue("&U,BTFw-\nArchives/2025");
  });

  it.each(["include", "exclude"] as const)("matches manual readable names to cached keys in %s mode without duplicate choices", async (mode) => {
    listFolders.mockResolvedValue([folder("&U,BTFw-"), folder("Projects/&U,BTFw-"), folder("INBOX")]);
    function Settings() {
      const [settings, setSettings] = useState<MailStorageOptions>({ ...value, mode });
      return <MailStorageSettings accountId="a" value={settings} onChange={setSettings} pop3={false} />;
    }
    render(<Settings />);
    await screen.findByRole("checkbox", { name: "台北" });
    fireEvent.click(screen.getByText("Advanced: edit folder names"));
    fireEvent.change(screen.getByLabelText("Full mail folder names"), { target: { value: "台北\n&U,BTFw-\nProjects/台北\ninbox" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("checkbox", { name: "台北" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Projects/台北" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "INBOX" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "台北" }));
    expect(screen.getByLabelText("Full mail folder names")).toHaveValue("Projects/台北\ninbox");
    expect(screen.getByRole("checkbox", { name: "台北" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Projects/台北" })).toBeChecked();
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
