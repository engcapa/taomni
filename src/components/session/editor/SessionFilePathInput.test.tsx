import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionFilePathInput } from "./SessionFilePathInput";

const { pick } = vi.hoisted(() => ({ pick: vi.fn() }));
vi.mock("../../../lib/ipc", () => ({ selectFilePath: pick }));

function Form({ read }: { read?: (path: string) => Promise<() => void> }) {
  const [path, setPath] = useState("draft.xml");
  return <SessionFilePathInput value={path} onChange={setPath} label="Configuration" placeholder=""
    analysis={read && { label: "Analyze", title: "Analyze configuration", read }} />;
}

describe("session configuration file inputs", () => {
  afterEach(cleanup);
  it("keeps the draft and associates an actionable picker failure, then retries", async () => {
    pick.mockRejectedValueOnce(new Error("Chooser unavailable")).mockResolvedValueOnce(null).mockResolvedValueOnce(" next.xml ");
    render(<Form />);
    const browse = screen.getByRole("button", { name: "Browse file" });
    const input = screen.getByRole("textbox");
    fireEvent.click(browse);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Chooser unavailable");
    expect(input).toHaveAccessibleDescription(alert.textContent ?? "");
    expect(input).toHaveValue("draft.xml");
    await act(async () => fireEvent.click(browse));
    expect(input).toHaveValue("draft.xml");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => fireEvent.click(browse));
    expect(input).toHaveValue("next.xml");
  });

  it("applies results only to the path and editor that requested them", async () => {
    let resolve!: (apply: () => void) => void;
    const read = () => new Promise<() => void>((done) => { resolve = done; });
    const apply = vi.fn();
    const view = render(<Form read={read} />);
    const analyze = screen.getByRole("button", { name: "Analyze" });
    fireEvent.click(analyze);
    expect(analyze).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "other.xml" } });
    await act(async () => resolve(apply));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(analyze);
    await act(async () => resolve(apply));
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.click(analyze);
    view.unmount();
    await act(async () => resolve(apply));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
