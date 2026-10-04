import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetainedPrimaryView } from "./RetainedPrimaryView";

afterEach(cleanup);

describe("retained utility and communication views", () => {
  it("keeps the same input and full draft across repeated hides without a hidden global input listener", async () => {
    const onPaste = vi.fn();
    function Composer() {
      const [draft, setDraft] = useState("");
      useEffect(() => {
        window.addEventListener("paste", onPaste);
        return () => window.removeEventListener("paste", onPaste);
      }, []);
      return <textarea aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
    }
    const { rerender } = render(<RetainedPrimaryView active><Composer /></RetainedPrimaryView>);
    const input = screen.getByLabelText("Draft");
    fireEvent.change(input, { target: { value: "完整中文草稿\nSecond line" } });
    for (let i = 0; i < 3; i++) {
      rerender(<RetainedPrimaryView active={false}><Composer /></RetainedPrimaryView>);
      expect(input).not.toBeVisible();
      expect(input.closest("[inert]")).not.toBeNull();
      fireEvent(window, new Event("paste"));
      expect(onPaste).toHaveBeenCalledTimes(i);
      rerender(<RetainedPrimaryView active><Composer /></RetainedPrimaryView>);
      expect(screen.getByLabelText("Draft")).toBe(input);
      expect(input).toHaveValue("完整中文草稿\nSecond line");
      fireEvent(window, new Event("paste"));
      expect(onPaste).toHaveBeenCalledTimes(i + 1);
    }
  });

  it("retains an in-flight result delivered while hidden and releases effects when the tab closes", async () => {
    let deliver!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { deliver = resolve; });
    const stop = vi.fn();
    function Probe() {
      const [result, setResult] = useState("pending");
      useEffect(() => stop, []);
      return <><button onClick={() => void pending.then(setResult)}>Run</button><output>{result}</output></>;
    }
    const { rerender, unmount } = render(<RetainedPrimaryView active><Probe /></RetainedPrimaryView>);
    fireEvent.click(screen.getByText("Run"));
    rerender(<RetainedPrimaryView active={false}><Probe /></RetainedPrimaryView>);
    await act(async () => { deliver("SHELL late result"); await pending; });
    rerender(<RetainedPrimaryView active><Probe /></RetainedPrimaryView>);
    await waitFor(() => expect(screen.getByText("SHELL late result")).toBeVisible());
    expect(stop).toHaveBeenCalledTimes(1);
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
